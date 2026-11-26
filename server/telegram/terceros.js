/**
 * Cartolas y comprobantes de una tarjeta ajena (por ejemplo, la de la tía Valeska, con la que Juan
 * paga un Mac en 12 cuotas). Funciones puras: quién es el titular, qué cargo de la cartola es la
 * cuota, si corresponde avanzar el contador y cómo se leen las respuestas "el 2 y el 5 son míos".
 *
 * La lógica con la base de datos y Telegram está en loteTerceros.js.
 */

import { normalizar } from './cuentas.js';
import { formatearFechaCL } from './fechas.js';

const dinero = (n) => `$${Math.round(Number(n)).toLocaleString('es-CL')}`;

/** ¿El titular es el propio Juan? Sin titular, "yo" o el titular por defecto cuentan como propios. */
export function esTitularPropio(titular, titularDefecto = process.env.TITULAR_POR_DEFECTO) {
  const t = normalizar(titular ?? '').trim();
  if (!t || ['yo', 'mio', 'mia', 'propia', 'propio'].includes(t)) return true;
  const propio = normalizar(titularDefecto ?? '').trim();
  return Boolean(propio) && (t === propio || propio.includes(t) || t.includes(propio));
}

/** Compras en curso cuyo acreedor es ese titular (por nombre o parte del nombre) */
export function comprasDeTitular(compras, titular) {
  const t = normalizar(titular ?? '').trim();
  if (t.length < 3) return [];
  return compras.filter(c => {
    const a = normalizar(c.acreedor ?? '').trim();
    return a.length >= 3 && (a === t || a.includes(t) || t.includes(a));
  });
}

/** Acreedores distintos de las compras en curso, para ofrecerlos como dueños de una cartola */
export function acreedoresDe(compras) {
  const vistos = new Map();
  for (const c of compras) {
    const clave = normalizar(c.acreedor ?? '').trim();
    if (clave && !vistos.has(clave)) vistos.set(clave, c.acreedor);
  }
  return [...vistos.values()];
}

/**
 * Cuál de los movimientos de una cartola es la cuota de la compra. Puntaje: número de cuota con el
 * total correcto ("06/12", "cuota 6 de 12") = 3; el alias de la compra en la descripción = 2; el
 * monto igual a la cuota (±1) = 2. Se reconoce con 3 o más. Devuelve
 * { indice, numero, puntaje, motivos } o null. Solo se miran los cargos.
 */
export function reconocerCuota(movimientos, compra) {
  const total = Number(compra.total_cuotas);
  const montoCuota = Number(compra.monto_cuota);
  const palabras = [compra.alias, compra.alias_cartola]
    .flatMap(t => normalizar(t ?? '').split(/\s+/))
    .filter(p => p.length >= 3);

  let mejor = null;
  movimientos.forEach((m, indice) => {
    if (m.tipo !== 'cargo') return;
    const desc = normalizar(m.descripcion ?? '');
    const motivos = [];
    let puntaje = 0;
    let numero = null;

    const patron = /\b(?:cuota\s+)?0?(\d{1,2})\s*(?:\/|de)\s*0?(\d{1,2})\b/.exec(desc);
    if (patron && Number(patron[2]) === total && Number(patron[1]) >= 1 && Number(patron[1]) <= total) {
      numero = Number(patron[1]);
      puntaje += 3;
      motivos.push('número de cuota');
    }
    if (palabras.some(p => ` ${desc.replace(/[^\p{L}\p{N}]+/gu, ' ')} `.includes(` ${p} `))) {
      puntaje += 2;
      motivos.push('descripción');
    }
    if (Math.abs(Number(m.monto) - montoCuota) <= 1) {
      puntaje += 2;
      motivos.push('monto');
    }
    if (puntaje >= 3 && (!mejor || puntaje > mejor.puntaje)) mejor = { indice, numero, puntaje, motivos };
  });
  return mejor;
}

/**
 * ¿Corresponde registrar la cuota `numero` (null = la siguiente) de esta compra?
 *   { accion: 'registrar', numero }  es la siguiente a la última pagada
 *   { accion: 'duplicada', numero }  ya estaba registrada: no se duplica
 *   { accion: 'salto', numero, esperada }  faltan cuotas intermedias: no se avanza solo
 */
export function evaluarNumeroCuota(compra, numero) {
  const esperada = Number(compra.cuotas_pagadas) + 1;
  if (numero === null || numero === undefined) return { accion: 'registrar', numero: esperada };
  if (numero === esperada) return { accion: 'registrar', numero };
  if (numero < esperada) return { accion: 'duplicada', numero };
  return { accion: 'salto', numero, esperada };
}

/** ¿Los dos montos son el mismo? (tolerancia de $1 por redondeos) */
export function montosCalzan(a, b) {
  return Math.abs(Number(a) - Number(b)) <= 1;
}

/**
 * Lee "el 2 y el 5 son míos", "2, 5", "todos", "ninguno". Devuelve
 * { indices: number[] } (números de la lista, 1 a `max`), { todos: true }, { ninguno: true },
 * { error } si hay un número fuera de la lista, o null si no parece una selección.
 */
export function parsearSeleccion(texto, max) {
  const norm = normalizar(texto).replace(/[¿?¡!.;:]/g, ' ');
  if (/\b(?:ninguno|ninguna|nada|ningun)\b/.test(norm) && !/\d/.test(norm)) return { ninguno: true };
  if (/\b(?:todos|todas|todo)\b/.test(norm) && !/\d/.test(norm)) return { todos: true };

  const numeros = [...norm.matchAll(/\d+/g)].map(m => Number(m[0]));
  if (numeros.length === 0) return null;
  // Si además del número hay otras palabras que no son de una selección, no se interpreta
  const resto = norm.replace(/\d+/g, ' ').replace(/\b(?:el|la|los|las|y|e|son|es|mios|mias|mio|mia|mi|de|numero|n|nro|este|esta|estos|estas|solo|solamente|tambien|ademas)\b/g, ' ').replace(/[\s,]+/g, '');
  if (resto) return null;
  const fuera = numeros.find(n => n < 1 || n > max);
  if (fuera !== undefined) return { error: `No hay un cargo número ${fuera} en la lista (van del 1 al ${max}).` };
  return { indices: [...new Set(numeros)].sort((a, b) => a - b) };
}

/** Línea de la lista de cargos: "3. 12-11-2026 SUPERMERCADO $12.300" (sin escapar; quien la use escapa) */
export function lineaCargo(numero, mov) {
  return `${numero}. ${formatearFechaCL(String(mov.fecha).slice(0, 10))} ${String(mov.descripcion).slice(0, 45)} ${dinero(mov.monto)}`;
}

/** Resumen corto del lote */
export function textoResumenLote({ titular, cuota, gastos, pago, avisos = [] }) {
  const lineas = [`Cartola de ${titular}`];
  if (cuota?.estado === 'registrada') lineas.push(`Cuota ${cuota.numero} de ${cuota.total} (${cuota.alias}) registrada`);
  else if (cuota?.estado === 'duplicada') lineas.push(`Cuota ${cuota.numero} de ${cuota.total} (${cuota.alias}): ya estaba registrada, no la dupliqué`);
  else if (cuota?.estado === 'pendiente') lineas.push(`Cuota ${cuota.numero} de ${cuota.total} (${cuota.alias}): sin registrar`);
  else lineas.push('No reconocí la cuota en la cartola');
  lineas.push(`${gastos} ${gastos === 1 ? 'gasto tuyo agregado' : 'gastos tuyos agregados'}`);
  if (pago === 'registrado') lineas.push(`Pago a ${titular} registrado`);
  else if (pago === 'sin') lineas.push(`Pago a ${titular}: sin comprobante`);
  else if (pago === 'cancelado') lineas.push(`Pago a ${titular}: no registrado`);
  return [...lineas, ...avisos].join('\n');
}
