/**
 * Compras en cuotas pagadas a una persona o tarjeta ajena (por ejemplo, un MacBook en 12
 * cuotas con la tarjeta de la tía). Acceso a datos usado por el bot y por la importación de
 * cartolas (buscarCuotasPorCartola).
 *
 * No reutiliza deudas.js: allí alguien te debe a ti y sus pagos reducen esa deuda; aquí tú le
 * debes a otra persona y cada cuota que pagas es un gasto tuyo. Cada pago es un movimiento
 * (transferencia_terceros) ligado a la compra con compra_cuota_id y numero_cuota.
 *
 * La BD se importa de forma diferida para poder cargar este módulo sin base de datos.
 */

import { fechaHoySantiago } from './telegram/fechas.js';
import { calzarConCartola, resumenCompra, normalizar } from './telegram/cuotas.js';

async function consulta() {
  return (await import('./db.js')).query;
}

const COLUMNAS = `id, alias, alias_cartola, acreedor, monto_total, monto_cuota, total_cuotas,
  cuotas_pagadas, fecha_inicio, dia_pago, terminada, activa`;

function normalizarFila(f) {
  return {
    ...f,
    monto_total: f.monto_total === null || f.monto_total === undefined ? null : Number(f.monto_total),
    monto_cuota: Number(f.monto_cuota),
    total_cuotas: Number(f.total_cuotas),
    cuotas_pagadas: Number(f.cuotas_pagadas),
    terminada: Number(f.terminada) === 1,
    activa: Number(f.activa) === 1
  };
}

/** Compras en curso (activas y no terminadas); con incluirTerminadas también las terminadas */
export async function listarCompras({ incluirTerminadas = false } = {}) {
  const query = await consulta();
  const [filas] = await query(
    `SELECT ${COLUMNAS} FROM compras_cuotas
     WHERE activa = 1 ${incluirTerminadas ? '' : 'AND terminada = 0'}
     ORDER BY alias`
  );
  return filas.map(normalizarFila);
}

export async function obtenerCompra(id) {
  const query = await consulta();
  const [filas] = await query(`SELECT ${COLUMNAS} FROM compras_cuotas WHERE id = ?`, [id]);
  return filas[0] ? normalizarFila(filas[0]) : null;
}

/**
 * Crea una compra en cuotas. Devuelve { ok, id } o { ok: false, error }.
 * Valida los datos y evita duplicados (mismo alias y mismo acreedor en curso).
 */
export async function crearCompra(datos) {
  const alias = String(datos.alias ?? '').trim();
  const acreedor = String(datos.acreedor ?? '').trim();
  const montoCuota = Number(datos.montoCuota);
  const totalCuotas = Number(datos.totalCuotas);
  const pagadas = Number(datos.cuotasPagadas ?? 0);

  if (!alias || alias.length > 100) return { ok: false, error: 'Falta el nombre de la compra' };
  if (!acreedor || acreedor.length > 100) return { ok: false, error: 'Falta a quién se le debe' };
  if (!Number.isFinite(montoCuota) || montoCuota <= 0) return { ok: false, error: 'El monto de la cuota debe ser mayor que 0' };
  if (!Number.isInteger(totalCuotas) || totalCuotas < 1 || totalCuotas > 120) {
    return { ok: false, error: 'El total de cuotas debe estar entre 1 y 120' };
  }
  if (!Number.isInteger(pagadas) || pagadas < 0 || pagadas > totalCuotas) {
    return { ok: false, error: `Las cuotas pagadas deben estar entre 0 y ${totalCuotas}` };
  }

  const existentes = await listarCompras({ incluirTerminadas: true });
  const repetida = existentes.find(c => normalizar(c.alias) === normalizar(alias) && normalizar(c.acreedor) === normalizar(acreedor));
  if (repetida) return { ok: false, error: `Ya existe la compra ${repetida.alias} con ${repetida.acreedor}` };

  const diaPago = datos.diaPago === null || datos.diaPago === undefined ? null : Number(datos.diaPago);
  const aliasCartola = datos.aliasCartola ? normalizar(datos.aliasCartola).trim() : null;

  const query = await consulta();
  const [resultado] = await query(
    `INSERT INTO compras_cuotas
       (alias, alias_cartola, acreedor, monto_total, monto_cuota, total_cuotas, cuotas_pagadas, fecha_inicio, dia_pago, terminada)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      alias, aliasCartola, acreedor, datos.montoTotal ?? null, Math.round(montoCuota), totalCuotas, pagadas,
      datos.fechaInicio ?? null, Number.isInteger(diaPago) && diaPago >= 1 && diaPago <= 31 ? diaPago : null,
      pagadas >= totalCuotas ? 1 : 0
    ]
  );
  return { ok: true, id: resultado.insertId };
}

/** Desactiva una compra (activa = 0, no se borra la fila ni sus pagos). true si existía. */
export async function desactivarCompra(id) {
  const query = await consulta();
  const [resultado] = await query(
    'UPDATE compras_cuotas SET activa = 0, actualizado_en = CURRENT_TIMESTAMP WHERE id = ? AND activa = 1',
    [id]
  );
  return resultado.affectedRows > 0;
}

export async function fijarAliasCartola(id, aliasCartola) {
  const query = await consulta();
  const limpio = aliasCartola ? normalizar(aliasCartola).trim() : null;
  const [resultado] = await query(
    'UPDATE compras_cuotas SET alias_cartola = ?, actualizado_en = CURRENT_TIMESTAMP WHERE id = ?',
    [limpio || null, id]
  );
  return resultado.affectedRows > 0;
}

/** Suma el pago de la cuota `numero` al contador; si completa todas, la compra queda terminada */
async function avanzarContador(compraId, numero) {
  const query = await consulta();
  const compra = await obtenerCompra(compraId);
  if (!compra) return null;

  // Una cuota ya pagada no suma; una adelantada deja las anteriores como pagadas
  const pagadas = Math.min(compra.total_cuotas, Math.max(compra.cuotas_pagadas, numero));
  await query(
    'UPDATE compras_cuotas SET cuotas_pagadas = ?, terminada = ?, actualizado_en = CURRENT_TIMESTAMP WHERE id = ?',
    [pagadas, pagadas >= compra.total_cuotas ? 1 : 0, compraId]
  );
  return obtenerCompra(compraId);
}

/**
 * Registra el pago de una cuota: crea el movimiento (cargo, transferencia_terceros, sin
 * categoría) ligado a la compra y actualiza el contador. Devuelve { movimientoId, compra }.
 */
export async function registrarPagoCuota({ compraId, numero, monto, cuentaId, fecha, descripcion, archivoRespaldo }) {
  const query = await consulta();
  const [insercion] = await query(
    `INSERT INTO movimientos
       (cuenta_id, fecha, descripcion, monto, tipo, tipo_movimiento, compra_cuota_id, numero_cuota, archivo_respaldo)
     VALUES (?, ?, ?, ?, 'cargo', 'transferencia_terceros', ?, ?, ?)`,
    [cuentaId, fecha ?? fechaHoySantiago(), descripcion, monto, compraId, numero, archivoRespaldo ?? null]
  );

  try {
    return { movimientoId: insercion.insertId, compra: await avanzarContador(compraId, numero) };
  } catch (error) {
    // Sin transacciones en este wrapper: se deshace el movimiento para no dejar el contador desfasado
    await query('DELETE FROM movimientos WHERE id = ?', [insercion.insertId]);
    throw error;
  }
}

/**
 * Liga un movimiento ya existente (por ejemplo, una transferencia a la tía) a una cuota de una
 * compra. Devuelve { ok, numero, compra } o { ok: false, error }.
 */
export async function vincularMovimientoACuota(movimientoId, compraId) {
  const query = await consulta();
  const [movimientos] = await query('SELECT id, compra_cuota_id FROM movimientos WHERE id = ?', [movimientoId]);
  if (movimientos.length === 0) return { ok: false, error: 'El movimiento ya no existe' };
  if (movimientos[0].compra_cuota_id) return { ok: false, error: 'Ese movimiento ya está ligado a una compra' };

  const compra = await obtenerCompra(compraId);
  if (!compra || compra.terminada) return { ok: false, error: 'La compra ya no está en curso' };

  const numero = compra.cuotas_pagadas + 1;
  await query('UPDATE movimientos SET compra_cuota_id = ?, numero_cuota = ? WHERE id = ?', [compraId, numero, movimientoId]);
  return { ok: true, numero, compra: await avanzarContador(compraId, numero) };
}

/**
 * Compras en curso que calzan con el texto de un movimiento de cartola ("transferencia a
 * Valeska"), cada una con su próxima cuota esperada. Función reutilizable por la importación
 * de cartolas: solo sugiere, nunca asigna; quien la use debe preguntar.
 */
export async function buscarCuotasPorCartola(descripcion) {
  const hoy = fechaHoySantiago();
  const compras = calzarConCartola(descripcion, await listarCompras());
  return compras.map(compra => ({ compra, resumen: resumenCompra(compra, hoy) }));
}

/** Cuotas que cuentan como gasto fijo del mes en el plan de ahorro (ver planAhorro.js) */
export async function comprasParaPlan(inicio, fin) {
  const query = await consulta();
  const [filas] = await query(
    `SELECT ${COLUMNAS} FROM compras_cuotas c
     WHERE c.activa = 1
       AND (c.terminada = 0 OR EXISTS (
             SELECT 1 FROM movimientos m
             WHERE m.compra_cuota_id = c.id AND m.fecha BETWEEN ? AND ?))`,
    [inicio, fin]
  );
  return filas.map(normalizarFila);
}
