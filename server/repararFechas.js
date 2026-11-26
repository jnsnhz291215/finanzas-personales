/**
 * Repara fechas corruptas que dejó el parser de estados de cuenta de tarjeta (el código de la operación pegado a la fecha armaba años
 * como 2602 o 2617). Es idempotente: una fecha con año entre 2000 y el año actual + 1 nunca se toca, así que volver a ejecutarlo no
 * cambia nada.
 *
 *  - archivos_importados.periodo_desde / periodo_hasta con fecha inválida: se recalculan con las fechas válidas de sus cargos
 *    (cargos_cartola y movimientos de esa cartola); si no queda ninguna válida, quedan en NULL (la cartola se muestra sin período).
 *  - movimientos.fecha inválida: pasa a ser el fin del período (ya reparado) de la cartola de la que vino; si no se sabe de cuál, no se toca
 *    y se cuenta aparte ("sin corregir").
 *  - cargos_cartola.fecha inválida: igual que los movimientos (si no hay período, no se toca).
 *  - compras_cuotas.fecha_inicio inválida: queda en NULL (la fecha de la compra se desconoce; el resto de la compra no cambia).
 *
 * Por defecto solo cuenta lo que tocaría. Con --aplicar lo hace en UNA transacción (si algo falla no queda nada a medias).
 * No imprime descripciones ni montos: solo cantidades.
 *
 * Uso: node server/repararFechas.js            (cuenta)
 *      node server/repararFechas.js --aplicar  (repara)
 */

import path from 'path';
import { fileURLToPath } from 'url';
import { fechaPlausible } from './cartolas.js';

const texto = (f) => (f === null || f === undefined ? null : String(f).slice(0, 10));

/** Fechas con año fuera de rango (o imposibles) que hay que reparar, y qué se haría con cada una */
export function planificarReparacion({ archivos, movimientos, cargos, compras }, anioActual = new Date().getFullYear()) {
  const valida = (f) => fechaPlausible(texto(f), anioActual);

  // Fechas válidas de cada cartola (por hash y por ruta)
  const validasPorHash = new Map();
  const agregar = (hash, fecha) => {
    if (!hash || !valida(fecha)) return;
    const lista = validasPorHash.get(hash) ?? [];
    lista.push(texto(fecha));
    validasPorHash.set(hash, lista);
  };
  for (const c of cargos) agregar(c.hash_archivo, c.fecha);
  const hashPorRuta = new Map(archivos.filter(a => a.ruta_archivo).map(a => [a.ruta_archivo, a.hash_archivo]));
  for (const m of movimientos) agregar(hashPorRuta.get(m.importado_de), m.fecha);

  const periodoPorHash = new Map();
  const archivosAReparar = [];
  for (const a of archivos) {
    let desde = texto(a.periodo_desde);
    let hasta = texto(a.periodo_hasta);
    const mala = (desde && !valida(desde)) || (hasta && !valida(hasta));
    if (mala) {
      const fechas = (validasPorHash.get(a.hash_archivo) ?? []).sort();
      desde = fechas[0] ?? null;
      hasta = fechas[fechas.length - 1] ?? null;
      archivosAReparar.push({ id: a.id, desde, hasta });
    }
    if (valida(hasta)) periodoPorHash.set(a.hash_archivo, hasta);
  }

  const movimientosAReparar = [];
  let movimientosSinCorregir = 0;
  for (const m of movimientos) {
    if (valida(m.fecha)) continue;
    const hasta = periodoPorHash.get(hashPorRuta.get(m.importado_de));
    if (hasta) movimientosAReparar.push({ id: m.id, fecha: hasta });
    else movimientosSinCorregir++;
  }

  const cargosAReparar = [];
  let cargosSinCorregir = 0;
  for (const c of cargos) {
    if (valida(c.fecha)) continue;
    const hasta = periodoPorHash.get(c.hash_archivo);
    if (hasta) cargosAReparar.push({ id: c.id, fecha: hasta });
    else cargosSinCorregir++;
  }

  const comprasAReparar = compras.filter(c => c.fecha_inicio && !valida(c.fecha_inicio)).map(c => ({ id: c.id }));

  return { archivosAReparar, movimientosAReparar, movimientosSinCorregir, cargosAReparar, cargosSinCorregir, comprasAReparar };
}

/** Sentencias SQL del plan */
export function sentenciasDeReparacion(plan) {
  return [
    ...plan.archivosAReparar.map(a => ({ sql: 'UPDATE archivos_importados SET periodo_desde = ?, periodo_hasta = ? WHERE id = ?', params: [a.desde, a.hasta, a.id] })),
    ...plan.movimientosAReparar.map(m => ({ sql: 'UPDATE movimientos SET fecha = ? WHERE id = ?', params: [m.fecha, m.id] })),
    ...plan.cargosAReparar.map(c => ({ sql: 'UPDATE cargos_cartola SET fecha = ? WHERE id = ?', params: [c.fecha, c.id] })),
    ...plan.comprasAReparar.map(c => ({ sql: 'UPDATE compras_cuotas SET fecha_inicio = NULL WHERE id = ?', params: [c.id] }))
  ];
}

/** Lee la BD, arma el plan y, con `aplicar`, lo ejecuta en una transacción. Devuelve las cantidades. */
export async function repararFechas({ aplicar = false } = {}) {
  const { query } = await import('./db.js');
  const anio = new Date().getFullYear();
  // Solo se leen las filas con alguna fecha fuera de rango (más las cartolas y cargos necesarios para reparar)
  const [archivos] = await query('SELECT id, hash_archivo, ruta_archivo, periodo_desde, periodo_hasta FROM archivos_importados');
  const [movimientos] = await query(
    'SELECT id, fecha, importado_de FROM movimientos WHERE importado_de IS NOT NULL AND importado_de <> ? OR fecha < ? OR fecha >= ?',
    ['', '2000-01-01', `${anio + 2}-01-01`]
  );
  const [cargos] = await query('SELECT id, hash_archivo, fecha FROM cargos_cartola');
  const [compras] = await query('SELECT id, fecha_inicio FROM compras_cuotas WHERE fecha_inicio IS NOT NULL');

  const plan = planificarReparacion({ archivos, movimientos, cargos, compras }, anio);
  const resumen = {
    archivos: plan.archivosAReparar.length,
    movimientos: plan.movimientosAReparar.length,
    movimientosSinCorregir: plan.movimientosSinCorregir,
    cargos: plan.cargosAReparar.length,
    cargosSinCorregir: plan.cargosSinCorregir,
    compras: plan.comprasAReparar.length,
    aplicado: false
  };
  const sentencias = sentenciasDeReparacion(plan);
  if (!aplicar || sentencias.length === 0) return resumen;

  const { ejecutarEnTransaccion } = await import('./resetCuenta.js');
  await ejecutarEnTransaccion(sentencias);
  return { ...resumen, aplicado: true };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const aplicar = process.argv.includes('--aplicar');
  repararFechas({ aplicar })
    .then(r => {
      console.log(
        `${aplicar ? 'Reparación aplicada' : 'Simulación'}: ${r.archivos} períodos de cartolas, ${r.movimientos} movimientos, ` +
        `${r.cargos} cargos leídos y ${r.compras} compras en cuotas ${aplicar ? 'reparados' : 'por reparar'}; ` +
        `sin poder corregir: ${r.movimientosSinCorregir} movimientos y ${r.cargosSinCorregir} cargos leídos.`
      );
      if (!aplicar) console.log('Para reparar: node server/repararFechas.js --aplicar');
      process.exit(0);
    })
    .catch(error => {
      console.error(`Error: ${error.message}`);
      process.exit(1);
    });
}
