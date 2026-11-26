/**
 * Memoria de los cargos que traían las cartolas de tarjetas de terceros (también los que no se guardaron como gastos tuyos).
 * Sirve para reconocer que una misma compra (misma fecha de compra, comercio y monto) que aparece en cartolas de meses distintos
 * es una cuota aunque la fila no traiga número, y para no ofrecerla de nuevo como un cargo suelto.
 *
 * La BD se importa de forma diferida para poder probar la clave sin base de datos.
 */

import { nombreSugerido } from './telegram/terceros.js';
import { normalizar } from './telegram/cuentas.js';

async function consulta() {
  return (await import('./db.js')).query;
}

/** Clave de una compra: fecha de la compra, comercio (sin tasa, dominio ni número de cuota) y monto */
export function claveCompra(mov) {
  return `${String(mov.fecha).slice(0, 10)}|${normalizar(nombreSugerido(mov.descripcion))}|${Math.round(Number(mov.monto))}`;
}

/** Guarda los cargos de una cartola (una sola vez por cartola: se reemplazan los que ya había de ese hash) */
export async function registrarCargosVistos(cuentaId, hash, movimientos) {
  const query = await consulta();
  await query('DELETE FROM cargos_cartola WHERE hash_archivo = ?', [hash]);
  for (const m of movimientos) {
    if (m.tipo !== 'cargo') continue;
    await query(
      `INSERT INTO cargos_cartola (cuenta_id, hash_archivo, fecha, descripcion, monto, cuota_actual, cuota_total)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [cuentaId, hash, String(m.fecha).slice(0, 10), String(m.descripcion).slice(0, 255), m.monto, m.cuota?.actual ?? null, m.cuota?.total ?? null]
    );
  }
}

/**
 * Posiciones de `movimientos` cuya misma compra (fecha, comercio y monto) ya apareció en otra cartola de la cuenta
 * (otro hash). Es una pista: esas compras se tratan como cuotas aunque no traigan número.
 */
export async function posicionesRepetidas(cuentaId, hash, movimientos) {
  if (!cuentaId) return new Set();
  const query = await consulta();
  const [filas] = await query(
    'SELECT fecha, descripcion, monto FROM cargos_cartola WHERE cuenta_id = ? AND hash_archivo <> ?',
    [cuentaId, hash]
  );
  const vistas = new Set(filas.map(f => claveCompra({ fecha: f.fecha, descripcion: f.descripcion, monto: Number(f.monto) })));
  const repetidas = new Set();
  movimientos.forEach((m, i) => {
    if (m.tipo === 'cargo' && vistas.has(claveCompra(m))) repetidas.add(i);
  });
  return repetidas;
}
