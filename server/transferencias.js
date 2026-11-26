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
import { vincularMovimientoACuota, registrarPagoCuota } from './cuotas.js';

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

  // Subconjuntos de 2 a 5 cuotas cuya suma es el monto
  const calzan = [];
  const limite = Math.min(cuotas.length, 8);
  for (let mascara = 1; mascara < (1 << limite); mascara++) {
    const elegidas = cuotas.slice(0, limite).filter((_, i) => mascara & (1 << i));
    if (elegidas.length < 2 || elegidas.length > 5) continue;
    if (montosCalzan(elegidas.reduce((s, c) => s + c.monto, 0), monto)) calzan.push(elegidas);
  }
  if (calzan.length === 1) return { tipo: 'suma', cuotas: calzan[0] };
  if (calzan.length > 1) return { tipo: 'ambigua', cuotas: calzan[0] };

  const total = cuotas.reduce((s, c) => s + c.monto, 0);
  return monto < total
    ? { tipo: 'parcial', diferencia: total - monto, total, cuotas }
    : { tipo: 'sobra', diferencia: monto - total, total, cuotas };
}

// ---------------------------------------------------------------------------
// Datos
// ---------------------------------------------------------------------------

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
  if (resto.length > 0) await query('UPDATE movimientos SET monto = ? WHERE id = ?', [primera.monto, movimiento.id]);
  const r = await vincularMovimientoACuota(movimiento.id, primera.compra.id);
  if (!r.ok) return { ok: false, error: r.error };

  const compras = [r.compra];
  for (const cuota of resto) {
    const pago = await registrarPagoCuota({
      compraId: cuota.compra.id,
      numero: cuota.numero,
      monto: cuota.monto,
      cuentaId,
      fecha,
      descripcion: `Cuota ${cuota.numero}/${cuota.compra.total_cuotas} ${cuota.compra.alias} (${cuota.compra.acreedor})`,
      archivoRespaldo: null
    });
    compras.push(pago.compra);
  }
  return { ok: true, compras };
}
