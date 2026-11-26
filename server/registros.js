/**
 * Eliminar, corregir y deshacer registros desde el bot respondiendo (reply) al mensaje que
 * los creó. Aquí vive solo la lógica de datos: vínculos mensaje <-> registro (tabla
 * mensajes_registro), eliminaciones con sus efectos (cuota, comprobante, importación) y el
 * historial (historial_cambios) que permite deshacer durante 24 horas.
 *
 * Tipos de registro: movimiento, pago_cuota (también es un movimiento), compra, cuenta,
 * importacion y, solo como vínculo, historial (la confirmación de una eliminación o corrección,
 * a la que se responde "deshacer").
 *
 * La BD se importa de forma diferida para poder probar las funciones puras sin base de datos.
 * Nada de esto registra montos, nombres de archivo ni números en los logs.
 */

import { enviarAPapelera, restaurarDePapelera } from './storage.js';
import { obtenerMovimiento, actualizarMovimiento, listarCategorias, listarCuentasActivas } from './gestion.js';
import { obtenerCompra } from './cuotas.js';

async function consulta() {
  return (await import('./db.js')).query;
}

export const VENTANA_DESHACER_MS = 24 * 60 * 60 * 1000;
export const TIPOS_MANUALES = ['movimiento', 'pago_cuota', 'compra', 'cuenta'];
export const CAMPOS_CORREGIBLES = ['monto', 'fecha', 'cuenta_id', 'categoria_id', 'descripcion'];

const ETIQUETA_TIPO = {
  movimiento: 'movimiento',
  pago_cuota: 'pago de cuota',
  compra: 'compra en cuotas',
  cuenta: 'cuenta',
  importacion: 'importación de cartola'
};

export function etiquetaTipo(tipo) {
  return ETIQUETA_TIPO[tipo] ?? 'registro';
}

// ---------------------------------------------------------------------------
// Funciones puras
// ---------------------------------------------------------------------------

const pad = (n) => String(n).padStart(2, '0');

/** YYYY-MM-DD a partir de un Date (hora local, como los entrega mysql2) o de un texto */
export function aFechaISO(valor) {
  if (valor instanceof Date) return `${valor.getFullYear()}-${pad(valor.getMonth() + 1)}-${pad(valor.getDate())}`;
  return String(valor ?? '').slice(0, 10);
}

/** DD-MM-YYYY para mostrar */
export function fechaCorta(valor) {
  const iso = aFechaISO(valor);
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  return m ? `${m[3]}-${m[2]}-${m[1]}` : iso;
}

/** true mientras no pasen 24 horas desde `creadoMs` */
export function dentroDeVentana(creadoMs, ahora = Date.now()) {
  const t = Number(creadoMs);
  return Number.isFinite(t) && ahora - t < VENTANA_DESHACER_MS;
}

/**
 * Copia una fila de BD lista para guardarse como JSON y reinsertarse: las fechas (Date) se pasan
 * a texto local para que no se corran un día por la zona horaria.
 */
export function filaSerializable(fila, { excluir = ['actualizado_en'] } = {}) {
  const salida = {};
  for (const [clave, valor] of Object.entries(fila ?? {})) {
    if (excluir.includes(clave) || valor === undefined) continue;
    if (valor instanceof Date) {
      const soloFecha = clave === 'fecha' || clave.startsWith('fecha_') && clave !== 'fecha_importacion';
      salida[clave] = soloFecha
        ? aFechaISO(valor)
        : `${aFechaISO(valor)} ${pad(valor.getHours())}:${pad(valor.getMinutes())}:${pad(valor.getSeconds())}`;
    } else {
      salida[clave] = valor;
    }
  }
  return salida;
}

/** Cuotas pagadas después de quitar el pago de la cuota `numero` (solo retrocede si era la última) */
export function contadorTrasQuitarPago(cuotasPagadas, numero) {
  const pagadas = Number(cuotasPagadas);
  const n = Number(numero);
  if (!Number.isFinite(pagadas) || !Number.isFinite(n) || n < 1) return pagadas;
  return n === pagadas ? n - 1 : pagadas;
}

const TABLAS_PERMITIDAS = new Set(['movimientos', 'cuentas', 'archivos_importados']);

async function insertarFila(tabla, fila) {
  if (!TABLAS_PERMITIDAS.has(tabla)) throw new Error('tabla no permitida');
  const query = await consulta();
  const columnas = Object.keys(fila);
  await query(
    `INSERT INTO ${tabla} (${columnas.join(', ')}) VALUES (${columnas.map(() => '?').join(', ')})`,
    columnas.map(c => fila[c])
  );
}

// ---------------------------------------------------------------------------
// Vínculos mensaje <-> registro
// ---------------------------------------------------------------------------

/** Guarda que estos mensajes del chat (el de Juan y el del bot) corresponden a un registro */
export async function vincularMensajes(chatId, messageIds, tipo, registroId) {
  try {
    const ids = [...new Set((Array.isArray(messageIds) ? messageIds : [messageIds])
      .map(Number).filter(n => Number.isFinite(n) && n > 0))];
    if (ids.length === 0 || !registroId) return;
    const query = await consulta();
    for (const messageId of ids) {
      await query(
        'INSERT INTO mensajes_registro (chat_id, message_id, tipo, registro_id) VALUES (?, ?, ?, ?)',
        [chatId, messageId, tipo, registroId]
      );
    }
  } catch (error) {
    // Un fallo aquí no debe afectar el guardado del registro
    console.error('Error al vincular mensajes:', error.code ?? '', error.message);
  }
}

/** Registro asociado a un mensaje del chat (el más reciente si hay varios) o null */
export async function buscarVinculo(chatId, messageId) {
  const query = await consulta();
  const [filas] = await query(
    'SELECT tipo, registro_id FROM mensajes_registro WHERE chat_id = ? AND message_id = ? ORDER BY id DESC LIMIT 1',
    [chatId, messageId]
  );
  return filas[0] ? { tipo: filas[0].tipo, registroId: Number(filas[0].registro_id) } : null;
}

/** Último registro creado a mano en el chat que todavía existe, o null */
export async function ultimoRegistroManual(chatId) {
  const query = await consulta();
  const [filas] = await query(
    `SELECT tipo, registro_id FROM mensajes_registro
     WHERE chat_id = ? AND tipo IN ('movimiento', 'pago_cuota', 'compra', 'cuenta')
     ORDER BY id DESC LIMIT 40`,
    [chatId]
  );
  const vistos = new Set();
  for (const fila of filas) {
    const clave = `${fila.tipo}:${fila.registro_id}`;
    if (vistos.has(clave)) continue;
    vistos.add(clave);
    const descripcion = await describirRegistro(fila.tipo, Number(fila.registro_id));
    if (descripcion.existe) return { tipo: fila.tipo, registroId: Number(fila.registro_id) };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Descripción de registros (texto plano; el bot lo escapa)
// ---------------------------------------------------------------------------

async function filaPor(tabla, id) {
  if (!TABLAS_PERMITIDAS.has(tabla) && tabla !== 'compras_cuotas') throw new Error('tabla no permitida');
  const query = await consulta();
  const [filas] = await query(`SELECT * FROM ${tabla} WHERE id = ?`, [id]);
  return filas[0] ?? null;
}

const dinero = (n) => `$${Math.round(Number(n)).toLocaleString('es-CL')}`;

/** { existe, lineas: string[] } con el resumen del registro para las confirmaciones */
export async function describirRegistro(tipo, id) {
  if (tipo === 'movimiento' || tipo === 'pago_cuota') {
    const m = await obtenerMovimiento(id);
    if (!m) return { existe: false, lineas: [] };
    const lineas = [
      `${m.descripcion}`,
      `${m.tipo === 'abono' ? 'Ingreso' : 'Gasto'} de ${dinero(m.monto)} el ${fechaCorta(m.fecha)}`,
      `Cuenta: ${m.cuenta_nombre ?? 'sin cuenta'}`
    ];
    if (m.categoria_nombre) lineas.push(`Categoría: ${m.categoria_nombre}`);
    const fila = await filaPor('movimientos', id);
    if (fila?.compra_cuota_id) {
      const compra = await obtenerCompra(fila.compra_cuota_id);
      if (compra) lineas.push(`Cuota ${fila.numero_cuota} de ${compra.total_cuotas} de ${compra.alias}`);
    }
    return { existe: true, lineas };
  }

  if (tipo === 'compra') {
    const c = await obtenerCompra(id);
    if (!c || Number(c.activa) === 0) return { existe: false, lineas: [] };
    return {
      existe: true,
      lineas: [`${c.alias} (${c.acreedor})`, `${c.total_cuotas} cuotas de ${dinero(c.monto_cuota)}, ${c.cuotas_pagadas} pagadas`]
    };
  }

  if (tipo === 'cuenta') {
    const c = await filaPor('cuentas', id);
    if (!c || Number(c.activa) === 0) return { existe: false, lineas: [] };
    return { existe: true, lineas: [`${c.nombre}${c.banco ? ` (${c.banco})` : ''}`] };
  }

  if (tipo === 'importacion') {
    const a = await filaPor('archivos_importados', id);
    if (!a) return { existe: false, lineas: [] };
    const n = await contarMovimientosDeImportacion(a);
    return { existe: true, lineas: [`Importación de cartola del ${fechaCorta(a.fecha_importacion)}`, `${n} movimientos`] };
  }

  return { existe: false, lineas: [] };
}

async function contarMovimientosDeImportacion(archivo) {
  if (!archivo?.ruta_archivo) return 0;
  const query = await consulta();
  const [filas] = await query('SELECT COUNT(*) AS n FROM movimientos WHERE importado_de = ?', [archivo.ruta_archivo]);
  return Number(filas[0]?.n ?? 0);
}

// ---------------------------------------------------------------------------
// Historial
// ---------------------------------------------------------------------------

async function guardarHistorial({ accion, tipo, registroId, chatId, antes, despues }) {
  const query = await consulta();
  const [r] = await query(
    `INSERT INTO historial_cambios (creado_ms, accion, tipo, registro_id, chat_id, antes, despues)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [
      Date.now(), accion, tipo, registroId ?? null, chatId ?? null,
      antes === undefined ? null : JSON.stringify(antes),
      despues === undefined ? null : JSON.stringify(despues)
    ]
  );
  return r.insertId;
}

async function obtenerHistorial(id) {
  const query = await consulta();
  const [filas] = await query('SELECT * FROM historial_cambios WHERE id = ?', [id]);
  const f = filas[0];
  if (!f) return null;
  const leer = (t) => { try { return t ? JSON.parse(t) : null; } catch { return null; } };
  return { ...f, creado_ms: Number(f.creado_ms), antes: leer(f.antes), despues: leer(f.despues), deshecho: Number(f.deshecho) === 1 };
}

// ---------------------------------------------------------------------------
// Eliminar
// ---------------------------------------------------------------------------

/**
 * Qué pasará al eliminar, para la confirmación. Devuelve
 * { ok, lineas, aviso, accion } o { ok: false, error }.
 */
export async function planEliminacion(tipo, id) {
  const d = await describirRegistro(tipo, id);
  if (!d.existe) return { ok: false, error: 'Ese registro ya no existe.' };

  if (tipo === 'movimiento' || tipo === 'pago_cuota') {
    const fila = await filaPor('movimientos', id);
    const lineas = [...d.lineas];
    let aviso = 'Se elimina el movimiento';
    if (fila?.archivo_respaldo) aviso += ' y su comprobante';
    if (fila?.compra_cuota_id) aviso += '. La cuota vuelve a quedar pendiente';
    return { ok: true, accion: 'eliminar', lineas, aviso: `${aviso}.` };
  }

  if (tipo === 'compra') {
    return { ok: true, accion: 'desactivar', lineas: d.lineas, aviso: 'Se desactiva la compra. Los pagos ya registrados se conservan.' };
  }

  if (tipo === 'cuenta') {
    const query = await consulta();
    const [n] = await query('SELECT COUNT(*) AS n FROM movimientos WHERE cuenta_id = ? OR cuenta_destino_id = ?', [id, id]);
    const conMovimientos = Number(n[0]?.n ?? 0) > 0;
    return {
      ok: true,
      accion: conMovimientos ? 'desactivar' : 'eliminar',
      lineas: d.lineas,
      aviso: conMovimientos
        ? 'La cuenta tiene movimientos: se desactiva (deja de aparecer), no se borra.'
        : 'La cuenta no tiene movimientos: se elimina.'
    };
  }

  if (tipo === 'importacion') {
    const a = await filaPor('archivos_importados', id);
    const n = await contarMovimientosDeImportacion(a);
    return {
      ok: true,
      accion: 'eliminar',
      lineas: d.lineas,
      aviso: `Se eliminan los ${n} movimientos de esta importación y el registro del archivo, así que podrás volver a importarlo.`
    };
  }

  return { ok: false, error: 'No sé eliminar ese tipo de registro.' };
}

/** Quita el pago de una cuota del contador de su compra; devuelve el estado previo de la compra */
async function retrocederCompra(compraId, numero, estadosPrevios) {
  const compra = await obtenerCompra(compraId);
  if (!compra) return;
  if (!estadosPrevios[compraId]) {
    estadosPrevios[compraId] = { cuotas_pagadas: compra.cuotas_pagadas, terminada: compra.terminada ? 1 : 0 };
  }
  const pagadas = contadorTrasQuitarPago(compra.cuotas_pagadas, numero);
  if (pagadas === compra.cuotas_pagadas) return;
  const query = await consulta();
  await query(
    'UPDATE compras_cuotas SET cuotas_pagadas = ?, terminada = ?, actualizado_en = CURRENT_TIMESTAMP WHERE id = ?',
    [pagadas, pagadas >= compra.total_cuotas ? 1 : 0, compraId]
  );
}

/**
 * Elimina el registro con todos sus efectos y deja el historial para deshacer. Devuelve
 * { ok, historialId, resumen } o { ok: false, error }. No pide confirmación: eso lo hace el bot.
 */
export async function eliminarRegistro(tipo, id, chatId) {
  const query = await consulta();

  if (tipo === 'movimiento' || tipo === 'pago_cuota') {
    const fila = await filaPor('movimientos', id);
    if (!fila) return { ok: false, error: 'Ese movimiento ya no existe.' };
    const resumen = (await describirRegistro('movimiento', id)).lineas;

    const compras = {};
    const archivo = fila.archivo_respaldo
      ? { original: fila.archivo_respaldo, papelera: await enviarAPapelera(fila.archivo_respaldo) }
      : null;
    await query('DELETE FROM movimientos WHERE id = ?', [id]);
    if (fila.compra_cuota_id) await retrocederCompra(fila.compra_cuota_id, fila.numero_cuota, compras);

    const historialId = await guardarHistorial({
      accion: 'eliminar', tipo: 'movimiento', registroId: id, chatId,
      antes: { fila: filaSerializable(fila), compras, archivo }
    });
    return { ok: true, historialId, resumen };
  }

  if (tipo === 'compra') {
    const compra = await obtenerCompra(id);
    if (!compra) return { ok: false, error: 'Esa compra ya no existe.' };
    const resumen = (await describirRegistro('compra', id)).lineas;
    await query('UPDATE compras_cuotas SET activa = 0, actualizado_en = CURRENT_TIMESTAMP WHERE id = ?', [id]);
    const historialId = await guardarHistorial({
      accion: 'eliminar', tipo: 'compra', registroId: id, chatId, antes: { activa: 1 }
    });
    return { ok: true, historialId, resumen };
  }

  if (tipo === 'cuenta') {
    const fila = await filaPor('cuentas', id);
    if (!fila) return { ok: false, error: 'Esa cuenta ya no existe.' };
    const resumen = (await describirRegistro('cuenta', id)).lineas;
    const plan = await planEliminacion('cuenta', id);
    if (plan.accion === 'desactivar') {
      await query('UPDATE cuentas SET activa = 0 WHERE id = ?', [id]);
      const historialId = await guardarHistorial({
        accion: 'eliminar', tipo: 'cuenta', registroId: id, chatId, antes: { modo: 'desactivar' }
      });
      return { ok: true, historialId, resumen };
    }
    await query('DELETE FROM cuentas WHERE id = ?', [id]);
    const historialId = await guardarHistorial({
      accion: 'eliminar', tipo: 'cuenta', registroId: id, chatId,
      antes: { modo: 'borrar', fila: filaSerializable(fila) }
    });
    return { ok: true, historialId, resumen };
  }

  if (tipo === 'importacion') {
    const archivo = await filaPor('archivos_importados', id);
    if (!archivo) return { ok: false, error: 'Esa importación ya no existe.' };
    const resumen = (await describirRegistro('importacion', id)).lineas;

    let movimientos = [];
    if (archivo.ruta_archivo) {
      const [filas] = await query('SELECT * FROM movimientos WHERE importado_de = ?', [archivo.ruta_archivo]);
      movimientos = filas;
    }
    // Primero las cuotas más altas, para que el contador retroceda en orden
    const compras = {};
    const conCuota = movimientos
      .filter(m => m.compra_cuota_id)
      .sort((a, b) => Number(b.numero_cuota) - Number(a.numero_cuota));

    const rutaOriginal = archivo.ruta_archivo;
    const papelera = rutaOriginal ? await enviarAPapelera(rutaOriginal) : null;

    if (archivo.ruta_archivo) await query('DELETE FROM movimientos WHERE importado_de = ?', [archivo.ruta_archivo]);
    for (const m of conCuota) await retrocederCompra(m.compra_cuota_id, m.numero_cuota, compras);
    await query('DELETE FROM archivos_importados WHERE id = ?', [id]);

    const historialId = await guardarHistorial({
      accion: 'eliminar', tipo: 'importacion', registroId: id, chatId,
      antes: {
        archivo: filaSerializable(archivo),
        movimientos: movimientos.map(m => filaSerializable(m)),
        compras,
        papelera: rutaOriginal ? { original: rutaOriginal, papelera } : null
      }
    });
    return { ok: true, historialId, resumen: [...resumen.slice(0, 1), `${movimientos.length} movimientos eliminados`] };
  }

  return { ok: false, error: 'No sé eliminar ese tipo de registro.' };
}

// ---------------------------------------------------------------------------
// Corregir (solo movimientos y pagos de cuota)
// ---------------------------------------------------------------------------

/** Interpreta un monto de la forma en que lo guarda MariaDB/SQLite (número o texto) */
const numero = (v) => (v === null || v === undefined || v === '' ? null : Number(v));

/**
 * Vista previa de una corrección: [{ campo, etiqueta, antes, despues }] solo con lo que
 * realmente cambia, o { ok: false, error }. No escribe nada.
 */
export async function previsualizarCorreccion(id, cambios) {
  const actual = await obtenerMovimiento(id);
  if (!actual) return { ok: false, error: 'Ese movimiento ya no existe.' };

  const filas = [];
  if (cambios.monto !== undefined) {
    const nuevo = Number(cambios.monto);
    if (!Number.isFinite(nuevo) || nuevo <= 0) return { ok: false, error: 'El monto debe ser mayor que 0.' };
    if (nuevo !== Number(actual.monto)) filas.push({ campo: 'monto', etiqueta: 'Monto', antes: dinero(actual.monto), despues: dinero(nuevo), antesNumero: Number(actual.monto), despuesNumero: nuevo });
  }
  if (cambios.fecha !== undefined) {
    const nueva = aFechaISO(cambios.fecha);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(nueva)) return { ok: false, error: 'No entendí la fecha.' };
    if (nueva !== aFechaISO(actual.fecha)) filas.push({ campo: 'fecha', etiqueta: 'Fecha', antes: fechaCorta(actual.fecha), despues: fechaCorta(nueva) });
  }
  if (cambios.descripcion !== undefined) {
    const nueva = String(cambios.descripcion).trim().slice(0, 255);
    if (!nueva) return { ok: false, error: 'La descripción no puede quedar vacía.' };
    if (nueva !== String(actual.descripcion)) filas.push({ campo: 'descripcion', etiqueta: 'Descripción', antes: String(actual.descripcion), despues: nueva });
  }
  if (cambios.cuenta_id !== undefined) {
    const cuentas = await listarCuentasActivas();
    const nueva = cuentas.find(c => Number(c.id) === Number(cambios.cuenta_id));
    if (!nueva) return { ok: false, error: 'Esa cuenta no existe o está desactivada.' };
    if (Number(nueva.id) !== Number(actual.cuenta_id)) filas.push({ campo: 'cuenta_id', etiqueta: 'Cuenta', antes: actual.cuenta_nombre ?? 'sin cuenta', despues: nueva.nombre });
  }
  if (cambios.categoria_id !== undefined) {
    const categorias = await listarCategorias();
    const nueva = categorias.find(c => Number(c.id) === Number(cambios.categoria_id));
    if (!nueva) return { ok: false, error: 'Esa categoría no existe.' };
    if (Number(nueva.id) !== Number(actual.categoria_id)) filas.push({ campo: 'categoria_id', etiqueta: 'Categoría', antes: actual.categoria_nombre ?? 'sin categoría', despues: nueva.nombre });
  }
  return { ok: true, cambios: filas };
}

/** Aplica la corrección y guarda antes/después. Devuelve { ok, historialId, movimiento } o { ok: false, error } */
export async function corregirMovimiento(id, cambios, chatId) {
  const actual = await obtenerMovimiento(id);
  if (!actual) return { ok: false, error: 'Ese movimiento ya no existe.' };

  const permitidos = {};
  for (const campo of CAMPOS_CORREGIBLES) {
    if (cambios[campo] !== undefined) permitidos[campo] = cambios[campo];
  }
  if (permitidos.fecha !== undefined) permitidos.fecha = aFechaISO(permitidos.fecha);
  if (permitidos.descripcion !== undefined) permitidos.descripcion = String(permitidos.descripcion).trim().slice(0, 255);

  const valorDe = (campo, fila) => (campo === 'fecha' ? aFechaISO(fila.fecha) : campo === 'descripcion' ? String(fila.descripcion) : numero(fila[campo]));

  const antes = {};
  for (const campo of Object.keys(permitidos)) antes[campo] = valorDe(campo, actual);

  const r = await actualizarMovimiento(id, permitidos);
  if (!r.ok) return r;

  const despues = {};
  for (const campo of Object.keys(permitidos)) despues[campo] = valorDe(campo, r.movimiento);
  const historialId = await guardarHistorial({ accion: 'corregir', tipo: 'movimiento', registroId: id, chatId, antes, despues });
  return { ok: true, historialId, movimiento: r.movimiento };
}

// ---------------------------------------------------------------------------
// Deshacer
// ---------------------------------------------------------------------------

/** Último cambio de ese registro que todavía se puede deshacer (id del historial) o null */
export async function historialPendienteDe(tipo, registroId, ahora = Date.now()) {
  const query = await consulta();
  const tipoHistorial = tipo === 'pago_cuota' ? 'movimiento' : tipo;
  const [filas] = await query(
    'SELECT id, creado_ms FROM historial_cambios WHERE tipo = ? AND registro_id = ? AND deshecho = 0 ORDER BY id DESC LIMIT 1',
    [tipoHistorial, registroId]
  );
  const f = filas[0];
  return f && dentroDeVentana(Number(f.creado_ms), ahora) ? Number(f.id) : null;
}

/** Qué se puede deshacer de este historial, o por qué no: { ok, cambio } | { ok: false, error } */
export async function historialDeshacible(historialId, ahora = Date.now()) {
  const h = await obtenerHistorial(historialId);
  if (!h) return { ok: false, error: 'No encuentro ese cambio.' };
  if (h.deshecho) return { ok: false, error: 'Ese cambio ya se deshizo.' };
  if (!dentroDeVentana(h.creado_ms, ahora)) return { ok: false, error: 'Pasaron más de 24 horas, ya no se puede deshacer.' };
  return { ok: true, cambio: h };
}

/** Deshace una eliminación o corrección dentro de las 24 horas. */
export async function deshacerCambio(historialId, ahora = Date.now()) {
  const v = await historialDeshacible(historialId, ahora);
  if (!v.ok) return v;
  const h = v.cambio;
  const query = await consulta();

  try {
    if (h.accion === 'corregir') {
      const r = await actualizarMovimiento(h.registro_id, h.antes ?? {});
      if (!r.ok) return r;
    } else if (h.tipo === 'movimiento') {
      const { fila, compras, archivo } = h.antes;
      if (await filaPor('movimientos', fila.id)) return { ok: false, error: 'Ese movimiento ya existe.' };
      await insertarFila('movimientos', fila);
      await restaurarCompras(compras);
      if (archivo?.papelera) await restaurarDePapelera(archivo.papelera, archivo.original);
    } else if (h.tipo === 'compra') {
      await query('UPDATE compras_cuotas SET activa = 1, actualizado_en = CURRENT_TIMESTAMP WHERE id = ?', [h.registro_id]);
    } else if (h.tipo === 'cuenta') {
      if (h.antes?.modo === 'desactivar') {
        await query('UPDATE cuentas SET activa = 1 WHERE id = ?', [h.registro_id]);
      } else {
        await insertarFila('cuentas', h.antes.fila);
      }
    } else if (h.tipo === 'importacion') {
      const { archivo, movimientos, compras, papelera } = h.antes;
      if (await filaPor('archivos_importados', archivo.id)) return { ok: false, error: 'Esa importación ya existe.' };
      await insertarFila('archivos_importados', archivo);
      for (const m of movimientos) await insertarFila('movimientos', m);
      await restaurarCompras(compras);
      if (papelera?.papelera) await restaurarDePapelera(papelera.papelera, papelera.original);
    } else {
      return { ok: false, error: 'No sé deshacer ese cambio.' };
    }
  } catch (error) {
    console.error('Error al deshacer:', error.code ?? '', error.message);
    return { ok: false, error: 'No pude deshacerlo.' };
  }

  await query('UPDATE historial_cambios SET deshecho = 1 WHERE id = ?', [historialId]);
  return { ok: true, tipo: h.tipo, accion: h.accion };
}

async function restaurarCompras(compras) {
  const query = await consulta();
  for (const [id, estado] of Object.entries(compras ?? {})) {
    await query(
      'UPDATE compras_cuotas SET cuotas_pagadas = ?, terminada = ?, actualizado_en = CURRENT_TIMESTAMP WHERE id = ?',
      [estado.cuotas_pagadas, estado.terminada ? 1 : 0, Number(id)]
    );
  }
}
