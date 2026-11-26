/**
 * /resetcuenta: borrar de UNA cuenta sus importaciones de cartolas o todo lo suyo, opcionalmente solo de un período (un mes o un
 * rango de meses). La cuenta misma (nombre, titular, dígitos, banco, vínculo) y las compras en cuotas se conservan, y los PDF
 * originales no se borran del almacenamiento.
 *
 * Antes de borrar se guarda un respaldo JSON de lo eliminado en <FINANZAS_STORAGE>/respaldos/ (permisos 600) y el borrado es una sola
 * transacción. El respaldo permite deshacer. Si se borran pagos ligados a una compra en cuotas, su contador baja en la misma cantidad
 * (el respaldo guarda el valor anterior).
 *
 * La BD se importa de forma diferida para poder probar las funciones puras sin base de datos. Nunca se registra en consola el contenido
 * de lo borrado ni rutas.
 */

import fs from 'fs/promises';
import path from 'path';
import { rutaRaiz } from './storage.js';
import { normalizar } from './telegram/cuentas.js';
import { archivosDeCuenta } from './estadoCuenta.js';

async function bd() {
  return import('./db.js');
}

// ---------------------------------------------------------------------------
// Frases y período (funciones puras)
// ---------------------------------------------------------------------------

const MESES = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];
const NOMBRES_MES = MESES.join('|');
const VERBO = /^(?:por favor\s+)?(resetea|resetear|reinicia|reiniciar|limpia|limpiar|vacia|vaciar|borra|borrar|elimina|eliminar)\s+/;

/** "mes 1", "mes 1 a 3", "enero", "enero a marzo", con año opcional ("2026", "de 2026") */
const PERIODO_NUMERO = /\bmes(?:es)?\s+(\d{1,2})(?:\s*(?:a|al|hasta|-)\s*(?:mes\s*)?(\d{1,2}))?(?:\s+(?:de(?:l)?\s+)?(20\d{2}))?\b/;
const PERIODO_NOMBRE = new RegExp(`\\b(${NOMBRES_MES})(?:\\s*(?:a|al|hasta|-)\\s*(${NOMBRES_MES}))?(?:\\s+(?:de(?:l)?\\s+)?(20\\d{2}))?\\b`);

/**
 * "8263", "8263 mes 1", "8263 mes 1 2026", "enero", "enero 2026", "mes 1 a 3" y frases como "resetea la cuenta 8263" o "borra enero de la
 * 8263". Devuelve { digitos, periodo: { mesDesde, mesHasta, anio|null } | null, verbo, error? } o null si no parece de esto.
 * "borra"/"elimina" solo valen si traen un período (para no confundirse con desactivar una cuenta).
 */
export function interpretarResetCuenta(texto) {
  const original = String(texto ?? '').trim();
  if (!original || original.startsWith('/') || original.length > 140) return null;
  let norm = normalizar(original).replace(/[¿?¡!,;:.]/g, ' ').replace(/\s+/g, ' ').trim();

  const v = VERBO.exec(norm);
  const verbo = v ? v[1] : null;
  if (v) norm = norm.slice(v[0].length);

  let periodo = null;
  let m = PERIODO_NUMERO.exec(norm);
  if (m) {
    periodo = { mesDesde: Number(m[1]), mesHasta: Number(m[2] ?? m[1]), anio: m[3] ? Number(m[3]) : null };
  } else if ((m = PERIODO_NOMBRE.exec(norm))) {
    periodo = { mesDesde: MESES.indexOf(m[1]) + 1, mesHasta: MESES.indexOf(m[2] ?? m[1]) + 1, anio: m[3] ? Number(m[3]) : null };
  }
  if (m) norm = norm.replace(m[0], ' ');

  const digitos = /\b(\d{4})\b/.exec(norm)?.[1] ?? null;
  if (verbo && /^(?:borra|borrar|elimina|eliminar)$/.test(verbo) && !periodo) return null;

  const resultado = { digitos, periodo, verbo };
  if (periodo && (periodo.mesDesde < 1 || periodo.mesDesde > 12 || periodo.mesHasta < 1 || periodo.mesHasta > 12 || periodo.mesDesde > periodo.mesHasta)) {
    return { ...resultado, error: 'El período no es válido: los meses van del 1 al 12 y el rango, de menor a mayor (por ejemplo «mes 1 a 3»).' };
  }
  return resultado;
}

const dos = (n) => String(n).padStart(2, '0');

/** { desde, hasta } (YYYY-MM-DD, comparables como texto) de un período con año, o null sin período */
export function rangoDePeriodo(periodo, anio) {
  if (!periodo) return null;
  return { desde: `${anio}-${dos(periodo.mesDesde)}-01`, hasta: `${anio}-${dos(periodo.mesHasta)}-31`, mesDesde: `${anio}-${dos(periodo.mesDesde)}`, mesHasta: `${anio}-${dos(periodo.mesHasta)}` };
}

/** "enero 2026", "enero a marzo 2026" o "toda la cuenta" */
export function etiquetaPeriodo(periodo, anio) {
  if (!periodo) return 'toda la cuenta';
  const nombre = (n) => MESES[n - 1];
  return periodo.mesDesde === periodo.mesHasta ? `${nombre(periodo.mesDesde)} ${anio}` : `${nombre(periodo.mesDesde)} a ${nombre(periodo.mesHasta)} ${anio}`;
}

/** Contadores nuevos de las compras en cuotas tras quitar pagos: [{ id, alias, antes, despues, total, terminada }] */
export function recalcularCuotas(compras, pagosQuitados) {
  return compras
    .map(c => {
      const quitados = pagosQuitados.get(Number(c.id)) ?? 0;
      const antes = Number(c.cuotas_pagadas);
      const despues = Math.max(0, antes - quitados);
      return { id: Number(c.id), alias: c.alias, antes, despues, total: Number(c.total_cuotas), terminada: despues >= Number(c.total_cuotas), terminadaAntes: Boolean(Number(c.terminada)) };
    })
    .filter(c => c.despues !== c.antes);
}

const chunk = (lista, n = 400) => {
  const partes = [];
  for (let i = 0; i < lista.length; i += n) partes.push(lista.slice(i, i + n));
  return partes;
};

/** Sentencias DELETE ... WHERE id IN (...) por tandas */
export function sentenciasBorrar(tabla, ids) {
  return chunk(ids).map(parte => ({ sql: `DELETE FROM ${tabla} WHERE id IN (${parte.map(() => '?').join(',')})`, params: parte }));
}

/** INSERT de filas completas (con su id), para deshacer */
export function sentenciasInsertar(tabla, filas) {
  return filas.map(fila => {
    const columnas = Object.keys(fila);
    return { sql: `INSERT INTO ${tabla} (${columnas.join(', ')}) VALUES (${columnas.map(() => '?').join(', ')})`, params: columnas.map(c => fila[c]) };
  });
}

// ---------------------------------------------------------------------------
// Selección
// ---------------------------------------------------------------------------

const MODOS = ['importaciones', 'todo'];

function enLista(ids) {
  return { marcas: ids.map(() => '?').join(','), ids };
}

/**
 * Lo que se borraría de una cuenta: { movimientos, archivos, cargos, mensajes, compras (contadores a cambiar), conteos }.
 * `rango` es null (toda la cuenta) o { desde, hasta, mesDesde, mesHasta }. Una cartola entra por el mes en que termina su período;
 * un movimiento, por su fecha. Modo 'importaciones': los movimientos que vinieron de cartolas; 'todo': también los manuales.
 */
export async function seleccionar(cuentaId, rango, modo) {
  if (!MODOS.includes(modo)) throw new Error('modo no válido');
  const { query } = await bd();

  const filtroFecha = rango ? ' AND fecha >= ? AND fecha <= ?' : '';
  const paramsFecha = rango ? [rango.desde, rango.hasta] : [];
  const [movimientos] = await query(
    `SELECT * FROM movimientos WHERE cuenta_id = ?${filtroFecha}${modo === 'importaciones' ? ' AND importado_de IS NOT NULL' : ''} ORDER BY id`,
    [cuentaId, ...paramsFecha]
  );

  const delPeriodo = (await archivosDeCuenta(cuentaId)).filter(a => !rango || (a.mes && a.mes >= rango.mesDesde && a.mes <= rango.mesHasta));
  let archivos = [];
  let cargos = [];
  if (delPeriodo.length > 0) {
    const { marcas, ids } = enLista(delPeriodo.map(a => a.id));
    [archivos] = await query(`SELECT * FROM archivos_importados WHERE id IN (${marcas})`, ids);
    const hashes = archivos.map(a => a.hash_archivo);
    if (hashes.length > 0) {
      [cargos] = await query(`SELECT * FROM cargos_cartola WHERE cuenta_id = ? AND hash_archivo IN (${hashes.map(() => '?').join(',')})`, [cuentaId, ...hashes]);
    }
  }

  let mensajes = [];
  const idsMov = movimientos.map(m => m.id);
  const idsArchivo = archivos.map(a => a.id);
  for (const parte of chunk(idsMov)) {
    const [filas] = await query(
      `SELECT * FROM mensajes_registro WHERE tipo IN ('movimiento', 'pago_cuota') AND registro_id IN (${parte.map(() => '?').join(',')})`, parte
    );
    mensajes.push(...filas);
  }
  for (const parte of chunk(idsArchivo)) {
    const [filas] = await query(
      `SELECT * FROM mensajes_registro WHERE tipo = 'importacion' AND registro_id IN (${parte.map(() => '?').join(',')})`, parte
    );
    mensajes.push(...filas);
  }

  // Compras en cuotas cuyos pagos se borran: su contador baja en la misma cantidad
  const pagosQuitados = new Map();
  for (const m of movimientos) {
    if (m.compra_cuota_id && m.tipo === 'cargo') pagosQuitados.set(Number(m.compra_cuota_id), (pagosQuitados.get(Number(m.compra_cuota_id)) ?? 0) + 1);
  }
  let compras = [];
  if (pagosQuitados.size > 0) {
    const ids = [...pagosQuitados.keys()];
    const [filas] = await query(`SELECT id, alias, cuotas_pagadas, total_cuotas, terminada FROM compras_cuotas WHERE id IN (${ids.map(() => '?').join(',')})`, ids);
    compras = recalcularCuotas(filas, pagosQuitados);
  }

  const importados = movimientos.filter(m => m.importado_de).length;
  return {
    cuentaId,
    modo,
    movimientos,
    archivos,
    cargos,
    mensajes,
    compras,
    conteos: {
      movimientos: movimientos.length,
      importados,
      manuales: movimientos.length - importados,
      archivos: archivos.length,
      cargos: cargos.length,
      pagosCuota: [...pagosQuitados.values()].reduce((t, n) => t + n, 0),
      transferencias: movimientos.filter(m => ['transferencia_propia', 'transferencia_terceros'].includes(m.tipo_movimiento) || m.cuenta_destino_id).length
    }
  };
}

// ---------------------------------------------------------------------------
// Respaldo, borrado y deshacer
// ---------------------------------------------------------------------------

/** Ejecuta las sentencias en una sola transacción (SQLite o MariaDB): si algo falla no queda nada a medias */
export async function ejecutarEnTransaccion(sentencias) {
  const { motorDB, getConnection } = await bd();
  if (motorDB === 'sqlite') {
    const db = await getConnection();
    db.transaction(() => {
      for (const { sql, params } of sentencias) db.prepare(sql).run(...params);
    })();
    return;
  }
  const pool = await getConnection();
  const conexion = await pool.getConnection();
  try {
    await conexion.beginTransaction();
    for (const { sql, params } of sentencias) await conexion.query(sql, params);
    await conexion.commit();
  } catch (error) {
    await conexion.rollback().catch(() => {});
    throw error;
  } finally {
    conexion.release();
  }
}

function carpetaRespaldosCuenta() {
  return path.join(rutaRaiz(), 'respaldos');
}

/** Guarda el JSON de lo que se va a borrar (permisos 600) y devuelve { nombre, absoluta }. Si falla, lanza y no se borra nada. */
export async function guardarRespaldoJSON(seleccion, meta) {
  const carpeta = carpetaRespaldosCuenta();
  await fs.mkdir(carpeta, { recursive: true });
  const ahora = new Date();
  const sello = ahora.toISOString().replace(/[-:]/g, '').replace(/\..+$/, '').replace('T', '_');
  const nombre = `resetcuenta-${seleccion.cuentaId}-${sello}.json`;
  const absoluta = path.join(carpeta, nombre);
  const contenido = {
    version: 1,
    creado: ahora.toISOString(),
    cuentaId: seleccion.cuentaId,
    modo: seleccion.modo,
    ...meta,
    tablas: {
      movimientos: seleccion.movimientos,
      archivos_importados: seleccion.archivos,
      cargos_cartola: seleccion.cargos,
      mensajes_registro: seleccion.mensajes
    },
    compras: seleccion.compras
  };
  await fs.writeFile(absoluta, JSON.stringify(contenido), { mode: 0o600 });
  return { nombre, absoluta };
}

/** Borra la selección en una transacción y ajusta los contadores de las cuotas. Devuelve los conteos. */
export async function borrarSeleccion(seleccion) {
  const sentencias = [
    ...sentenciasBorrar('mensajes_registro', seleccion.mensajes.map(f => f.id)),
    ...sentenciasBorrar('movimientos', seleccion.movimientos.map(f => f.id)),
    ...sentenciasBorrar('cargos_cartola', seleccion.cargos.map(f => f.id)),
    ...sentenciasBorrar('archivos_importados', seleccion.archivos.map(f => f.id)),
    ...seleccion.compras.map(c => ({
      sql: 'UPDATE compras_cuotas SET cuotas_pagadas = ?, terminada = ?, actualizado_en = CURRENT_TIMESTAMP WHERE id = ?',
      params: [c.despues, c.terminada ? 1 : 0, c.id]
    }))
  ];
  await ejecutarEnTransaccion(sentencias);
  return seleccion.conteos;
}

/** Vuelve a insertar lo que había en el respaldo y restaura los contadores de las cuotas. Lanza si algo no calza (no deja nada a medias). */
export async function deshacerDesdeRespaldo(nombre) {
  if (!/^resetcuenta-\d+-\d{8}_\d{6}\.json$/.test(String(nombre))) throw new Error('respaldo no válido');
  const absoluta = path.join(carpetaRespaldosCuenta(), nombre);
  const datos = JSON.parse(await fs.readFile(absoluta, 'utf8'));
  const t = datos.tablas;
  const sentencias = [
    ...sentenciasInsertar('archivos_importados', t.archivos_importados),
    ...sentenciasInsertar('movimientos', t.movimientos),
    ...sentenciasInsertar('cargos_cartola', t.cargos_cartola),
    ...sentenciasInsertar('mensajes_registro', t.mensajes_registro),
    ...datos.compras.map(c => ({
      sql: 'UPDATE compras_cuotas SET cuotas_pagadas = ?, terminada = ?, actualizado_en = CURRENT_TIMESTAMP WHERE id = ?',
      params: [c.antes, c.terminadaAntes ? 1 : 0, c.id]
    }))
  ];
  await ejecutarEnTransaccion(sentencias);
  return datos;
}
