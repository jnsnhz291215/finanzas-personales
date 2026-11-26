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
    const desc = normalizar(m.descripcion ?? '').replace(/\bc(?=0?\d{1,2}\s*\/)/g, 'cuota ');
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
 *   { accion: 'duplicada', numero }  es la última pagada: ya estaba registrada, no se duplica
 *   { accion: 'menor', numero, esperada }  la cartola muestra un número menor que el de la app: se pregunta
 *   { accion: 'salto', numero, esperada }  la cartola salta más de una cuota: se pregunta
 */
export function evaluarNumeroCuota(compra, numero) {
  const pagadas = Number(compra.cuotas_pagadas);
  const esperada = pagadas + 1;
  if (numero === null || numero === undefined) return { accion: 'registrar', numero: esperada };
  if (numero === esperada) return { accion: 'registrar', numero };
  if (numero === pagadas) return { accion: 'duplicada', numero };
  if (numero < pagadas) return { accion: 'menor', numero, esperada };
  return { accion: 'salto', numero, esperada };
}

/**
 * Número de cuota que muestra la descripción de un cargo de crédito: "06/12", "6/12", "C06/12",
 * "CUOTA 6 DE 12", "cuota 6 de 12", "6 de 12 cuotas". Devuelve { actual, total } o null. Para no
 * confundir una fecha ("05/11"), la forma "NN/NN" solo vale con un total habitual de cuotas o con la
 * palabra cuota cerca; el actual no puede pasar del total ni el total de 60.
 */
export function extraerNumeroCuota(descripcion) {
  const desc = normalizar(descripcion ?? '');
  const valido = (a, t) => Number.isInteger(a) && Number.isInteger(t) && t >= 2 && t <= 60 && a >= 1 && a <= t;

  let m = /\b(?:cuota|cta|cta\.)\s*0?(\d{1,2})\s*(?:de|\/)\s*0?(\d{1,2})\b/.exec(desc);
  if (m && valido(Number(m[1]), Number(m[2]))) return { actual: Number(m[1]), total: Number(m[2]) };

  m = /\b0?(\d{1,2})\s*de\s*0?(\d{1,2})\s*cuotas?\b/.exec(desc);
  if (m && valido(Number(m[1]), Number(m[2]))) return { actual: Number(m[1]), total: Number(m[2]) };

  const TOTALES_HABITUALES = new Set([2, 3, 4, 5, 6, 7, 8, 9, 10, 12, 15, 18, 20, 24, 30, 36, 48, 60]);
  m = /(?:^|[^\d/])c?0?(\d{1,2})\s*\/\s*0?(\d{1,2})(?![\d/])/.exec(desc);
  if (m && valido(Number(m[1]), Number(m[2])) && TOTALES_HABITUALES.has(Number(m[2]))) {
    return { actual: Number(m[1]), total: Number(m[2]) };
  }
  return null;
}

/** ¿La descripción dice "TASA INT. x%"? Así vienen las compras en cuotas de una tarjeta de crédito */
export function tieneTasaInteres(descripcion) {
  return /\btasa\s+int\.?\s*[\d.,]*\s*%?/.test(normalizar(descripcion ?? ''));
}

/** Cargos propios del banco (comisión, impuestos, intereses): nunca son una compra de nadie */
export function esCargoBanco(descripcion) {
  return /\b(?:comision|impuesto\s+decreto\s+ley|impuesto\s+d\.?l|intereses?\s+rotativos?|interes\s+rotativo|intereses?\s+de\s+mora|interes\s+de\s+mora|interes\s+moratorio|intereses?\s+moratorios?|seguro\s+desgravamen|mantencion)\b/.test(normalizar(descripcion ?? ''));
}

/**
 * Nombre sugerido para una compra en cuotas según el comercio: "APPLE.COM CL APPLE TASA INT. 0,00% 06/12" -> "Apple".
 * Quita la tasa, el número de cuota, el dominio (.com) y el país, y no repite palabras.
 */
export function nombreSugerido(descripcion) {
  const sinTasa = String(descripcion ?? '').replace(/\bTASA\s+INT\.?\s*[\d.,]*\s*%?/gi, ' ').replace(/\.(?:com|cl|net|org)\b/gi, ' ');
  const palabras = aliasDeCargo(sinTasa).split(' ').filter(p => p && !['cl', 'com', 'int', 'tasa', 'chile'].includes(p) && !/^\d+$/.test(p));
  const unicas = [...new Set(palabras)].slice(0, 3);
  const nombre = unicas.join(' ') || 'compra en cuotas';
  return nombre[0].toUpperCase() + nombre.slice(1);
}

/**
 * La misma compra en cuotas aparece en cada cartola con su número de cuota (06/12, 07/12...). Se reconoce por el comercio, el valor de la
 * cuota, el total de cuotas y la fecha de la compra.
 */
export function claveCuotaDeLote(mov) {
  const nc = mov.cuota ? { total: mov.cuota.total } : extraerNumeroCuota(mov.descripcion);
  const valor = mov.cuota?.valorCuota ?? mov.monto;
  return `${aliasDeCargo(nombreSugerido(mov.descripcion))}|${Math.round(Number(valor))}|${nc?.total ?? ''}|${String(mov.fecha).slice(0, 10)}`;
}

/**
 * Para un lote de cartolas: por cada compra en cuotas (ver claveCuotaDeLote), la cuota más alta vista en cualquiera de ellas.
 * Devuelve un Map clave -> { actual, mov }; sirve para preguntar una sola vez por compra y con la cuota más reciente.
 */
export function mejoresCuotasDeLote(items) {
  const mejores = new Map();
  for (const item of items) {
    for (const mov of item.movimientos ?? []) {
      if (mov.tipo !== 'cargo' || esCargoBanco(mov.descripcion)) continue;
      const nc = mov.cuota ? { actual: mov.cuota.actual } : extraerNumeroCuota(mov.descripcion);
      if (!nc) continue;
      const clave = claveCuotaDeLote(mov);
      const previo = mejores.get(clave);
      if (!previo || nc.actual > previo.actual) mejores.set(clave, { actual: nc.actual, mov });
    }
  }
  return mejores;
}

/** Nombre corto de una compra en cuotas a partir de la descripción del cargo (sin el "06/12") */
export function aliasDeCargo(descripcion) {
  const limpio = normalizar(descripcion ?? '')
    .replace(/\b(?:cuota|cta)\.?\s*0?\d{1,2}\s*(?:de|\/)\s*0?\d{1,2}\b/g, ' ')
    .replace(/\b0?\d{1,2}\s*de\s*0?\d{1,2}\s*cuotas?\b/g, ' ')
    .replace(/c?\b0?\d{1,2}\s*\/\s*0?\d{1,2}\b/g, ' ')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 60);
  return limpio || 'compra en cuotas';
}

/**
 * La compra en cuotas que ya existe para un cargo: mismo total de cuotas, mismo monto por cuota (±1) y
 * una descripción parecida (el mismo nombre o una palabra de 4 letras o más en común). null si no hay.
 */
export function buscarCompraSimilar(compras, descripcion, monto, total) {
  const alias = aliasDeCargo(descripcion);
  const palabras = alias.split(' ').filter(p => p.length >= 4);
  return compras.find(c => {
    if (Number(c.total_cuotas) !== Number(total) || !montosCalzan(c.monto_cuota, monto)) return false;
    const nombre = normalizar(c.alias).trim();
    return nombre === alias || palabras.some(p => ` ${nombre} `.includes(` ${p} `)) ||
      nombre.split(' ').some(p => p.length >= 4 && alias.split(' ').includes(p));
  }) ?? null;
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
  const cuota = extraerNumeroCuota(mov.descripcion);
  return `${numero}. ${formatearFechaCL(String(mov.fecha).slice(0, 10))} ${String(mov.descripcion).slice(0, 45)} ${dinero(mov.monto)}` +
    (cuota ? ` (cuota ${cuota.actual}/${cuota.total})` : '');
}

/** Resumen corto del lote */
export function textoResumenLote({ titular, cuota, gastos, pago, otras = [], avisos = [] }) {
  const lineas = [`Cartola de ${titular}`];
  const etiqueta = cuota ? `${cuota.alias} ${cuota.numero}/${cuota.total}` : '';
  if (cuota?.estado === 'registrada') lineas.push(`Cuota registrada: ${etiqueta}${cuota.terminada ? ' (compra terminada)' : ''}`);
  else if (cuota?.estado === 'duplicada') lineas.push(`Cuota ${etiqueta}: ya estaba registrada, no la dupliqué`);
  else if (cuota?.estado === 'pendiente') lineas.push(`Cuota ${etiqueta}: sin registrar`);
  else lineas.push('No reconocí la cuota en la cartola');
  lineas.push(`${gastos} ${gastos === 1 ? 'gasto tuyo agregado' : 'gastos tuyos agregados'}`);
  for (const o of otras) {
    lineas.push(`Cuotas: ${o.alias} ${o.actual}/${o.total} (${o.estado})${o.terminada ? ' - compra terminada' : ''}`);
  }
  if (pago === 'registrado') lineas.push(`Pago a ${titular} registrado`);
  else if (pago === 'sin') lineas.push(`Pago a ${titular}: sin comprobante`);
  else if (pago === 'cancelado') lineas.push(`Pago a ${titular}: no registrado`);
  return [...lineas, ...avisos].join('\n');
}
