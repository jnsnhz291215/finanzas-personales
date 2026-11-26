/**
 * Estados de cuenta guardados: por cuenta, qué años y meses tienen movimientos o cartolas, y el resumen de un mes (cargos,
 * abonos, cuotas detectadas, cuántos cargos se marcaron como míos o se ignoraron en una tarjeta de terceros).
 *
 * Las funciones puras se pueden probar sin base de datos; la BD se importa de forma diferida. Nunca se devuelven rutas
 * de archivos al chat: solo el id de la cartola, y la ruta se resuelve en el momento de enviarla.
 */

import { extraerNumeroCuota, aliasDeCargo } from './telegram/terceros.js';
import { normalizar } from './telegram/cuentas.js';
import { leerContextoCartola } from './telegram/contextoCartola.js';

async function consulta() {
  return (await import('./db.js')).query;
}

const MESES = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];

/** "2026-05" -> "mayo 2026" */
export function nombreMes(mes) {
  const [anio, m] = String(mes).split('-');
  return `${MESES[Number(m) - 1] ?? mes} ${anio}`;
}

const mayuscula = (t) => (t ? t[0].toUpperCase() + t.slice(1) : t);

// ---------------------------------------------------------------------------
// Frases
// ---------------------------------------------------------------------------

const RELLENO = new Set(['de', 'del', 'la', 'el', 'las', 'los', 'mi', 'mis', 'tarjeta', 'cuenta', 'credito', 'debito', 'cartola', 'cartolas', 'estado', 'estados', 'historial', 'ver', 'muestrame', 'dame', 'para', 'con', 'terminada', 'en']);

/**
 * "estado cuenta tarjeta 8263", "estado de cuenta de la 8263", "historial de la tarjeta de Valeska", "cartolas de la 8263".
 * Devuelve { digitos, titular, termino, explicito } o null si el texto no es de esto. `explicito` es true si trae dígitos o
 * dice tarjeta/cuenta: si es false y nada calza con una cuenta, quien lo use debe dejar pasar el mensaje.
 * Una frase como "son de la tarjeta 8263" o "cartola de la 8263" (singular) es el texto de una cartola que se envía, no esto.
 */
export function interpretarConsultaEstado(texto) {
  const original = String(texto ?? '').trim();
  if (!original || original.startsWith('/') || original.length > 120) return null;
  const norm = normalizar(original).replace(/[¿?¡!,;:.]/g, ' ').replace(/\s+/g, ' ').trim();

  const inicio = /^(?:(?:ver|muestrame|dame|mis|las|los)\s+)*(?:estados?\s+de\s+cuentas?|estados?\s+cuentas?|historial|cartolas)(?:\s+(.*))?$/.exec(norm);
  if (!inicio) return null;
  const resto = (inicio[1] ?? '').trim();

  // Un monto o números sueltos no son de esto
  if (/\$|\b\d{1,3}\.\d{3}\b|\b(?:pesos|mil|lucas?|palos?)\b/.test(resto)) return null;
  const numeros = resto.match(/\d+/g) ?? [];
  if (numeros.some(n => n.length !== 4)) return null;

  const ctx = leerContextoCartola(`cartola ${original.replace(/^.*?(?:cartolas|historial|estados?\s+de\s+cuentas?|estados?\s+cuentas?)/i, '')}`);
  const palabras = resto.split(' ').filter(p => p && !/^\d{4}$/.test(p) && !RELLENO.has(p));
  const dijoCuenta = /\b(?:tarjeta|cuenta|credito|debito)\b/.test(resto);
  const termino = palabras.join(' ') || null;

  return {
    digitos: numeros[0] ?? null,
    titular: ctx.titular ?? null,
    tipo: ctx.tipo ?? null,
    termino,
    explicito: Boolean(numeros[0]) || dijoCuenta || resto === ''
  };
}

/** Cuentas que calzan con lo pedido: por dígitos, o por titular, nombre o banco */
export function cuentasQueCalzan(consultaEstado, cuentas) {
  if (!consultaEstado) return [];
  const { digitos, titular, termino, tipo } = consultaEstado;
  const porTipo = (lista) => {
    const esperado = tipo ? { credito: 'tarjeta_credito', debito: 'tarjeta_debito' }[tipo] : null;
    const filtradas = esperado ? lista.filter(c => c.tipo === esperado) : lista;
    return filtradas.length > 0 ? filtradas : lista;
  };
  if (digitos) return cuentas.filter(c => c.ultimos4 === digitos || c.ultimos4_cuenta === digitos);

  const clave = normalizar(titular ?? termino ?? '').trim();
  if (!clave) return [];
  const todas = cuentas.filter(c => {
    const texto = normalizar([c.titular, c.nombre, c.banco].filter(Boolean).join(' '));
    return clave.split(' ').every(p => texto.includes(p));
  });
  return porTipo(todas);
}

// ---------------------------------------------------------------------------
// Fechas y meses
// ---------------------------------------------------------------------------

/**
 * Mes (YYYY-MM) al que pertenece una cartola: el del final de su período; si es de antes de que se guardara el período, el
 * último movimiento que se importó de ella y, si no hay, el mes en que se importó.
 */
export function mesDeArchivo(archivo, rangoPorRuta = new Map()) {
  const hasta = archivo.periodo_hasta ?? rangoPorRuta.get(archivo.ruta_archivo)?.hasta ?? archivo.fecha_importacion;
  return hasta ? String(hasta).slice(0, 7) : null;
}

/** Años distintos de una lista de meses, de más reciente a más antiguo */
export function aniosDe(meses) {
  return [...new Set([...meses].map(m => m.slice(0, 4)))].sort().reverse();
}

// ---------------------------------------------------------------------------
// Datos
// ---------------------------------------------------------------------------

/** Cuentas activas que tienen movimientos o cartolas guardadas */
export async function cuentasConRegistros() {
  const query = await consulta();
  const [cuentas] = await query(
    `SELECT id, nombre, banco, tipo, titular, ultimos4, ultimos4_cuenta FROM cuentas WHERE activa = 1 ORDER BY nombre`
  );
  const [movs] = await query('SELECT DISTINCT cuenta_id FROM movimientos');
  const [archivos] = await query('SELECT DISTINCT cuenta_id FROM archivos_importados WHERE cuenta_id IS NOT NULL');
  const con = new Set([...movs, ...archivos].map(f => Number(f.cuenta_id)));
  return cuentas.map(c => ({ ...c, id: Number(c.id) })).filter(c => con.has(c.id));
}

export async function obtenerCuenta(id) {
  const query = await consulta();
  const [filas] = await query('SELECT id, nombre, banco, tipo, titular, ultimos4, ultimos4_cuenta FROM cuentas WHERE id = ?', [id]);
  return filas[0] ? { ...filas[0], id: Number(filas[0].id) } : null;
}

async function archivosDeCuenta(cuentaId) {
  const query = await consulta();
  const [archivos] = await query(
    `SELECT id, nombre_archivo, ruta_archivo, fecha_importacion, periodo_desde, periodo_hasta,
            cantidad_movimientos, cargos_leidos, marcados_mios, ignorados
     FROM archivos_importados WHERE cuenta_id = ? ORDER BY id`,
    [cuentaId]
  );
  // Cartolas anteriores al período guardado: se deduce de los movimientos que se importaron de ellas
  const [rangos] = await query(
    `SELECT importado_de, MIN(fecha) AS desde, MAX(fecha) AS hasta FROM movimientos
     WHERE cuenta_id = ? AND importado_de IS NOT NULL GROUP BY importado_de`,
    [cuentaId]
  );
  const rangoPorRuta = new Map(rangos.map(r => [r.importado_de, { desde: String(r.desde).slice(0, 10), hasta: String(r.hasta).slice(0, 10) }]));
  return archivos.map(a => ({ ...a, id: Number(a.id), mes: mesDeArchivo(a, rangoPorRuta) }));
}

/** Meses (YYYY-MM) con movimientos o cartolas de una cuenta, con cuántos de cada uno: Map mes -> { movimientos, cartolas } */
export async function mesesDeCuenta(cuentaId) {
  const query = await consulta();
  const [filas] = await query('SELECT SUBSTR(fecha, 1, 7) AS mes, COUNT(*) AS n FROM movimientos WHERE cuenta_id = ? GROUP BY SUBSTR(fecha, 1, 7)', [cuentaId]);
  const meses = new Map();
  for (const f of filas) meses.set(String(f.mes), { movimientos: Number(f.n), cartolas: 0 });
  for (const a of await archivosDeCuenta(cuentaId)) {
    if (!a.mes) continue;
    const m = meses.get(a.mes) ?? { movimientos: 0, cartolas: 0 };
    m.cartolas += 1;
    meses.set(a.mes, m);
  }
  return meses;
}

/** Movimientos y cartolas de una cuenta en un mes (YYYY-MM) */
export async function detalleDeMes(cuentaId, mes) {
  const query = await consulta();
  const [movimientos] = await query(
    `SELECT m.id, m.fecha, m.descripcion, m.monto, m.tipo, m.numero_cuota, m.compra_cuota_id,
            cc.alias AS compra_alias, cc.total_cuotas AS compra_total
     FROM movimientos m LEFT JOIN compras_cuotas cc ON cc.id = m.compra_cuota_id
     WHERE m.cuenta_id = ? AND m.fecha >= ? AND m.fecha <= ?
     ORDER BY m.fecha, m.id`,
    [cuentaId, `${mes}-01`, `${mes}-31`]
  );
  const archivos = (await archivosDeCuenta(cuentaId)).filter(a => a.mes === mes);
  return {
    movimientos: movimientos.map(m => ({ ...m, monto: Number(m.monto), fecha: String(m.fecha).slice(0, 10) })),
    archivos
  };
}

/** Una cartola guardada (para enviarla): { id, cuenta_id, nombre_archivo, ruta_archivo } o null */
export async function obtenerArchivo(id) {
  const query = await consulta();
  const [filas] = await query('SELECT id, cuenta_id, nombre_archivo, ruta_archivo FROM archivos_importados WHERE id = ?', [id]);
  return filas[0] ?? null;
}

// ---------------------------------------------------------------------------
// Resumen del mes
// ---------------------------------------------------------------------------

/**
 * Resumen de los movimientos y cartolas de un mes:
 * { cargos, totalCargos, abonos, totalAbonos, cuotas: ['Macbook 6/12'], marcadosMios, ignorados } (los dos últimos, null si
 * ninguna cartola del mes es de una tarjeta de terceros).
 */
export function resumirMes(movimientos, archivos = []) {
  const cargos = movimientos.filter(m => m.tipo === 'cargo');
  const abonos = movimientos.filter(m => m.tipo === 'abono');
  const suma = (l) => l.reduce((t, m) => t + m.monto, 0);

  // Cuotas: las ligadas a una compra en cuotas y las que se leen en la descripción ("MERCADO LIBRE 06/12")
  const cuotas = [];
  const vistas = new Set();
  const agregar = (clave, texto) => {
    if (vistas.has(clave)) return;
    vistas.add(clave);
    cuotas.push(texto);
  };
  for (const m of cargos) {
    if (m.compra_cuota_id && m.numero_cuota) {
      agregar(`c${m.compra_cuota_id}_${m.numero_cuota}`, `${mayuscula(m.compra_alias ?? 'Compra')} ${m.numero_cuota}/${m.compra_total ?? '?'}`);
      continue;
    }
    const n = extraerNumeroCuota(m.descripcion);
    if (n) agregar(`d${normalizar(aliasDeCargo(m.descripcion))}_${n.actual}_${n.total}`, `${mayuscula(aliasDeCargo(m.descripcion) || 'Compra')} ${n.actual}/${n.total}`);
  }

  const deTerceros = archivos.filter(a => a.marcados_mios !== null && a.marcados_mios !== undefined);
  return {
    cargos: cargos.length,
    totalCargos: suma(cargos),
    abonos: abonos.length,
    totalAbonos: suma(abonos),
    cuotas,
    marcadosMios: deTerceros.length > 0 ? deTerceros.reduce((t, a) => t + Number(a.marcados_mios), 0) : null,
    ignorados: deTerceros.length > 0 ? deTerceros.reduce((t, a) => t + Number(a.ignorados ?? 0), 0) : null
  };
}
