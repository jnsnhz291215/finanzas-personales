/**
 * Fijar a mano cuántas cuotas van pagadas de una compra (cuotas_pagadas) y explicar el resultado.
 *
 * "pagado" = el mayor entre los pagos reales vinculados a la compra y cuotas_pagadas × valor de la cuota (ver detalleCompra). Por eso al bajar
 * el contador a mano "pagado" baja solo si no hay pagos vinculados que lo justifiquen; si los hay, se avisa.
 */

import { fijarCuotasPagadas, pagosRealesPorCompra } from '../cuotas.js';
import { detalleCompra } from './cuotas.js';

/**
 * Fija cuotas_pagadas y devuelve { compra, antes, despues, pagado, debe, pagosVinculados, superanLoNuevo }. `n` se acota entre 0 y el total.
 * `superanLoNuevo`: los pagos vinculados valen más que n × cuota, así que "pagado" no baja a n × cuota.
 */
export async function fijarContador(compra, n) {
  const antes = Number(compra.cuotas_pagadas);
  const actualizada = await fijarCuotasPagadas(compra.id, n);
  const reales = (await pagosRealesPorCompra()).get(Number(compra.id)) ?? 0;
  const d = detalleCompra(actualizada, new Map([[Number(compra.id), reales]]));
  return {
    compra: actualizada,
    antes,
    despues: Number(actualizada.cuotas_pagadas),
    pagado: d.pagado,
    debe: d.debe,
    pagosVinculados: reales,
    superanLoNuevo: reales > Number(actualizada.cuotas_pagadas) * Number(actualizada.monto_cuota) + 1
  };
}

/** Texto (HTML) del resultado de fijarContador */
export function textoContador(r, nombre, dinero, esc = (t) => t) {
  const total = Number(r.compra.total_cuotas);
  const lineas = [
    `Listo: <b>${esc(nombre)}</b> va en <b>${r.despues}/${total}</b> cuotas pagadas${r.antes !== r.despues ? ` (antes ${r.antes}/${total})` : ''}.`,
    `Pagado ${dinero(r.pagado)} · se debe ${dinero(r.debe)}${r.despues >= total ? ' · compra terminada' : ''}.`
  ];
  if (r.superanLoNuevo) {
    lineas.push(
      `Ojo: tienes pagos vinculados a esta compra por ${dinero(r.pagosVinculados)}, más que ${r.despues} × ${dinero(r.compra.monto_cuota)}; ` +
      '«pagado» se queda en ese valor mayor hasta que revises esos pagos.'
    );
  }
  return lineas.join('\n');
}
