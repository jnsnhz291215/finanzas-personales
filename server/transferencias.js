/**
 * Transferencias salientes: qué es cada una. Una transferencia a otra persona NO es siempre un gasto:
 *  - a una cuenta propia de Juan: movimiento interno (transferencia_propia), no suma ni resta;
 *  - a quien le pagas una compra en cuotas (por ejemplo Valeska): pago de cuotas, cruzando el monto con
 *    la cuota del mes o con la suma de varias;
 *  - a otra persona: se pregunta si es gasto, préstamo o pago y se recuerda la respuesta por destinatario
 *    (tabla destinatarios_transferencia).
 *
 * El gasto real sigue siendo la transferencia (decisión de Juan): aquí solo se clasifica y se vincula.
 * Funciones puras arriba; la BD se importa de forma diferida. Nunca se guarda ni se muestra un RUT o un
 * número de cuenta: del destinatario solo queda el nombre.
 */

import { normalizar, capitalizarNombre } from './telegram/cuentas.js';
import { montosCalzan } from './telegram/terceros.js';
import { vincularMovimientoACuota, registrarPagoCuota, fijarCuotasPagadas } from './cuotas.js';

async function consulta() {
  return (await import('./db.js')).query;
}

export const CLASIFICACIONES = ['gasto', 'prestamo', 'pago'];

// ---------------------------------------------------------------------------
// Funciones puras
// ---------------------------------------------------------------------------

const VERBO_TRANSFERENCIA = /\b(?:transferencia|transferencias|transf|tef|traspaso|transferi|transferido|transferimos)\b/;

/** ¿La descripción de un cargo parece una transferencia a alguien? */
export function esTransferenciaSaliente(descripcion) {
  const norm = normalizar(descripcion ?? '');
  return VERBO_TRANSFERENCIA.test(norm) && /\b(?:a|para|hacia)\s+\S/.test(norm);
}

/**
 * Nombre del destinatario de "TRANSFERENCIA A CAMILA PEREZ" o "transferí 50 mil a Camila". Sin RUT ni
 * números (se descartan), en formato de nombre. null si no hay un nombre ("transferencia a terceros").
 */
export function extraerDestinatario(descripcion) {
  const m = /\b(?:transferencia|transferencias|transf|tef|traspaso|transferi|transferí)\b[^\n]*?\b(?:a|para|hacia)\s+(.+)$/i.exec(String(descripcion ?? ''));
  if (!m) return null;
  const nombre = m[1]
    .split(/\s+(?:por|con|desde|via|vía|en|para)\s+/i)[0]
    .replace(/\b\d{1,2}(?:\.\d{3}){2}-[\dkK]\b|\b\d{7,8}-[\dkK]\b/g, ' ')
    .replace(/\$?\s*\d[\d.,]*/g, ' ')
    .replace(/\b(?:banco|cta|cuenta|vista|corriente|rut)\b.*$/i, ' ')
    .replace(/[^\p{L}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const norm = normalizar(nombre);
  if (nombre.length < 3 || /^(?:terceros?|otro banco|otra cuenta|mi cuenta|cuenta propia)$/.test(norm)) return null;
  return capitalizarNombre(nombre.slice(0, 80));
}

/** Clave para recordar un destinatario: su nombre sin tildes ni mayúsculas */
export function clavePorNombre(nombre) {
  return normalizar(nombre ?? '').replace(/[^\p{L}\s]/gu, ' ').replace(/\s+/g, ' ').trim().slice(0, 100);
}

/** ¿El destinatario es una cuenta o el propio Juan? `propiasNombres`: nombres de sus cuentas; `titularPropio`: su nombre */
export function esDestinoPropio(destinatario, propiasNombres = [], titularPropio = '') {
  const d = clavePorNombre(destinatario);
  if (!d) return false;
  const titular = clavePorNombre(titularPropio);
  if (titular && (d === titular || titular.includes(d) || d.includes(titular))) return true;
  return propiasNombres.some(n => {
    const c = clavePorNombre(n);
    return c.length >= 3 && (d === c || d.includes(c));
  });
}

/**
 * Cruza el monto de una transferencia con las cuotas del mes de un titular (la siguiente cuota de cada compra en
 * curso). Devuelve:
 *   { tipo: 'exacta', cuotas: [una] }        calza con una cuota
 *   { tipo: 'suma', cuotas: [varias] }       calza con la suma de varias cuotas
 *   { tipo: 'ambigua', cuotas: [...] }       calza de más de una forma: se pregunta
 *   { tipo: 'parcial'|'sobra', diferencia, total, cuotas }   no calza: falta o sobra plata respecto de todas las cuotas
 *   { tipo: 'ninguna' }                      no hay cuotas pendientes
 * Cada cuota: { compra, numero, monto }.
 */
export function cruzarCuotas(monto, compras) {
  const cuotas = compras
    .map(c => ({ compra: c, numero: Number(c.cuotas_pagadas) + 1, monto: Number(c.monto_cuota) }))
    .filter(c => c.numero <= Number(c.compra.total_cuotas) && c.monto > 0);
  if (cuotas.length === 0) return { tipo: 'ninguna' };

  const exactas = cuotas.filter(c => montosCalzan(c.monto, monto));
  if (exactas.length === 1) return { tipo: 'exacta', cuotas: exactas };
  if (exactas.length > 1) return { tipo: 'ambigua', cuotas: exactas };

  // Subconjuntos de 2 cuotas o más (hasta todas) cuya suma es el monto
  const calzan = [];
  const limite = Math.min(cuotas.length, 10);
  for (let mascara = 1; mascara < (1 << limite); mascara++) {
    const elegidas = cuotas.slice(0, limite).filter((_, i) => mascara & (1 << i));
    if (elegidas.length < 2) continue;
    if (montosCalzan(elegidas.reduce((s, c) => s + c.monto, 0), monto)) calzan.push(elegidas);
  }
  if (calzan.length === 1) return { tipo: 'suma', cuotas: calzan[0] };
  if (calzan.length > 1) return { tipo: 'ambigua', cuotas: calzan[0] };

  const total = cuotas.reduce((s, c) => s + c.monto, 0);
  return monto < total
    ? { tipo: 'parcial', diferencia: total - monto, total, cuotas }
    : { tipo: 'sobra', diferencia: monto - total, total, cuotas };
}

/**
 * Reparte `monto` entre las cuotas elegidas: cada una recibe lo que vale, y la última queda con la diferencia
 * (lo que sobra o lo que falta) para que el total sea exactamente el de la transferencia. Si el monto no
 * alcanza para una cuota, esa y las siguientes reciben lo que quede (nunca menos de 0). Devuelve las cuotas
 * con `montoAplicado`.
 */
export function repartirMonto(cuotas, monto) {
  let resto = Number(monto);
  return cuotas.map((c, i) => {
    const ultima = i === cuotas.length - 1;
    const aplicado = ultima ? Math.max(0, resto) : Math.max(0, Math.min(c.monto, resto));
    resto -= aplicado;
    return { ...c, montoAplicado: Math.round(aplicado) };
  });
}

/**
 * Varias transferencias del mes que juntas cubren las cuotas: junta `monto` con las transferencias anteriores
 * al mismo destinatario que siguen sin vincular y cruza la suma. Devuelve { cruce, movimientos } con el
 * cruce de la suma (exacta/suma) y los movimientos que la forman, o null si juntas tampoco calzan.
 */
export function cruzarConAnteriores(monto, anteriores, compras) {
  if (anteriores.length === 0) return null;
  // De la más reciente a la más antigua: se prueba con 1, 2, ... anteriores
  const ordenadas = [...anteriores].sort((a, b) => String(b.fecha).localeCompare(String(a.fecha)));
  for (let n = 1; n <= ordenadas.length; n++) {
    const grupo = ordenadas.slice(0, n);
    const total = Number(monto) + grupo.reduce((s, m) => s + Number(m.monto), 0);
    const cruce = cruzarCuotas(total, compras);
    if (cruce.tipo === 'exacta' || cruce.tipo === 'suma') return { cruce, movimientos: grupo, total };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Datos
// ---------------------------------------------------------------------------

/**
 * Transferencias del mes de `fecha` al mismo destinatario que todavía no están ligadas a ninguna cuota
 * (cargos, sin la propia transferencia `excluirId`). Para juntarlas con una nueva.
 */
export async function transferenciasSinVincularDelMes(destinatario, fecha, excluirId) {
  const query = await consulta();
  const mes = String(fecha).slice(0, 7);
  const [filas] = await query(
    `SELECT id, fecha, descripcion, monto FROM movimientos
     WHERE tipo = 'cargo' AND compra_cuota_id IS NULL AND id <> ? AND fecha >= ? AND fecha <= ?
       AND tipo_movimiento IN ('compra', 'transferencia_terceros')`,
    [excluirId ?? 0, `${mes}-01`, `${mes}-31`]
  );
  const clave = clavePorNombre(destinatario);
  return filas
    .filter(f => esTransferenciaSaliente(f.descripcion) && clavePorNombre(extraerDestinatario(f.descripcion) ?? '') === clave)
    .map(f => ({ id: Number(f.id), fecha: String(f.fecha).slice(0, 10), descripcion: f.descripcion, monto: Number(f.monto) }));
}
/** Lo que Juan eligió antes para ese destinatario ('gasto' | 'prestamo' | 'pago') o null */
export async function obtenerClasificacion(destinatario) {
  const clave = clavePorNombre(destinatario);
  if (!clave) return null;
  const query = await consulta();
  const [filas] = await query('SELECT clasificacion FROM destinatarios_transferencia WHERE clave = ?', [clave]);
  return filas[0]?.clasificacion ?? null;
}

/** Recuerda la clasificación de un destinatario (crea o actualiza) */
export async function recordarClasificacion(destinatario, clasificacion) {
  const clave = clavePorNombre(destinatario);
  if (!clave || !CLASIFICACIONES.includes(clasificacion)) return false;
  const query = await consulta();
  const [existe] = await query('SELECT id FROM destinatarios_transferencia WHERE clave = ?', [clave]);
  if (existe[0]) {
    await query('UPDATE destinatarios_transferencia SET clasificacion = ?, actualizado_en = CURRENT_TIMESTAMP WHERE id = ?', [clasificacion, existe[0].id]);
  } else {
    await query('INSERT INTO destinatarios_transferencia (clave, nombre, clasificacion) VALUES (?, ?, ?)', [clave, String(destinatario).slice(0, 100), clasificacion]);
  }
  return true;
}

/** Transferencia a una cuenta propia: movimiento interno que no suma como gasto ni como ingreso */
export async function marcarPropia(movimientoId, cuentaDestinoId = null) {
  const query = await consulta();
  await query(
    `UPDATE movimientos SET tipo = 'cargo', tipo_movimiento = 'transferencia_propia', cuenta_destino_id = ? WHERE id = ?`,
    [cuentaDestinoId, movimientoId]
  );
}

/**
 * Aplica la clasificación a un movimiento: 'gasto' (queda como gasto), 'prestamo' (se anota como préstamo a
 * esa persona) o 'pago' (pago a alguien: transferencia a terceros).
 */
export async function aplicarClasificacion(movimientoId, clasificacion, destinatario) {
  const query = await consulta();
  if (clasificacion === 'prestamo') {
    await query(
      `UPDATE movimientos SET es_prestamo = 1, persona_prestamo = ?, tipo_movimiento = 'compra' WHERE id = ?`,
      [String(destinatario).slice(0, 100), movimientoId]
    );
  } else if (clasificacion === 'pago') {
    await query(`UPDATE movimientos SET es_prestamo = 0, persona_prestamo = NULL, tipo_movimiento = 'transferencia_terceros' WHERE id = ?`, [movimientoId]);
  } else if (clasificacion === 'gasto') {
    await query(`UPDATE movimientos SET es_prestamo = 0, persona_prestamo = NULL, tipo_movimiento = 'compra' WHERE id = ?`, [movimientoId]);
  }
}

/**
 * Vincula la transferencia a las cuotas del plan. Con una cuota, la liga y avanza el contador; con varias,
 * el movimiento original queda con la primera cuota y se crea un movimiento por cada una de las demás, para
 * que cada cuota avance su propia compra y el total no cambie. Devuelve las compras actualizadas.
 */
export async function aplicarPlanDeCuotas(movimiento, cuotas, { cuentaId, fecha }) {
  const query = await consulta();
  const [primera, ...resto] = cuotas;
  // Con varias cuotas, el movimiento original queda con lo que le toca a la primera
  if (resto.length > 0) await query('UPDATE movimientos SET monto = ? WHERE id = ?', [primera.montoAplicado ?? primera.monto, movimiento.id]);
  const r = await vincularMovimientoACuota(movimiento.id, primera.compra.id);
  if (!r.ok) return { ok: false, error: r.error };

  const compras = [r.compra];
  for (const cuota of resto) {
    const pago = await registrarPagoCuota({
      compraId: cuota.compra.id,
      numero: cuota.numero,
      monto: cuota.montoAplicado ?? cuota.monto,
      cuentaId,
      fecha,
      descripcion: `Cuota ${cuota.numero}/${cuota.compra.total_cuotas} ${cuota.compra.alias} (${cuota.compra.acreedor})`,
      archivoRespaldo: null
    });
    compras.push(pago.compra);
  }
  return { ok: true, compras };
}

/**
 * Varias transferencias (las del grupo) que juntas cubren las cuotas: cada cuota avanza su contador una vez y las
 * transferencias quedan ligadas a las cuotas en orden (si hay más transferencias que cuotas, las sobrantes van a la
 * última cuota; si hay más cuotas que transferencias, las últimas avanzan sin movimiento propio). El gasto sigue
 * siendo cada transferencia: no se crea ningún movimiento nuevo.
 */
export async function vincularGrupo(movimientos, cuotas) {
  const query = await consulta();
  for (let i = 0; i < cuotas.length; i++) {
    const cuota = cuotas[i];
    const mov = movimientos[Math.min(i, movimientos.length - 1)];
    await query(
      `UPDATE movimientos SET compra_cuota_id = ?, numero_cuota = ?, tipo_movimiento = 'transferencia_terceros'
       WHERE id = ? AND compra_cuota_id IS NULL`,
      [cuota.compra.id, cuota.numero, mov.id]
    );
    await fijarCuotasPagadas(cuota.compra.id, cuota.numero);
  }
  // Las transferencias que sobran (más transferencias que cuotas) se ligan a la última cuota
  const ultima = cuotas[cuotas.length - 1];
  for (const mov of movimientos.slice(cuotas.length)) {
    await query(
      `UPDATE movimientos SET compra_cuota_id = ?, numero_cuota = ?, tipo_movimiento = 'transferencia_terceros'
       WHERE id = ? AND compra_cuota_id IS NULL`,
      [ultima.compra.id, ultima.numero, mov.id]
    );
  }
}

/**
 * Registra el pago de varias cuotas con UNA transferencia que todavía no existe como movimiento (el comprobante del
 * lote): un movimiento por cuota, con su monto (la última queda con la diferencia) y el respaldo en el primero.
 */
export async function registrarPagosMultiples(cuotas, { cuentaId, fecha, archivoRespaldo = null }) {
  const movimientos = [];
  for (let i = 0; i < cuotas.length; i++) {
    const c = cuotas[i];
    const pago = await registrarPagoCuota({
      compraId: c.compra.id,
      numero: c.numero,
      monto: c.montoAplicado ?? c.monto,
      cuentaId,
      fecha,
      descripcion: `Cuota ${c.numero}/${c.compra.total_cuotas} ${c.compra.alias} (${c.compra.acreedor})`,
      archivoRespaldo: i === 0 ? archivoRespaldo : null
    });
    movimientos.push(pago.movimientoId);
  }
  return movimientos;
}
