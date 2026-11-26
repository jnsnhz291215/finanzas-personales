/**
 * Compras en cuotas: interpretación de mensajes (alta, pago de cuota, consultas), validación
 * de la cuota que se paga y calce con el texto de las cartolas. Funciones puras, sin BD.
 *
 * Ejemplos:
 *   /cuotas nueva mac 12 cuotas de 85 mil tía, pagadas 6
 *   compré el mac en 12 cuotas de 85 mil con la tarjeta de la tía
 *   pagué cuota tía mac 6/12 · pague cuota mac 7/12 · pagué la cuota del mac
 *   cuánto le debo a mi tía · cuántas cuotas me quedan del mac
 */

import { analizarMonto } from './parser.js';
import { construirFecha } from './fechas.js';

export function normalizar(texto) {
  return String(texto ?? '').normalize('NFC').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
}

// Palabras de relleno que no identifican la compra ni a quién se le debe
const PALABRAS_VACIAS = new Set([
  'compre', 'comprar', 'compra', 'el', 'la', 'los', 'las', 'un', 'una', 'mi', 'mis', 'en', 'con', 'de', 'del',
  'al', 'a', 'y', 'para', 'tarjeta', 'cuota', 'cuotas', 'nueva', 'nuevo', 'pagadas', 'pagada', 'pagado',
  'pague', 'pago', 'pagando', 'debito', 'credito', 'cmr', 'efectivo', 'transferencia', 'hoy', 'ayer', 'anteayer',
  'mensuales', 'mensual', 'por'
]);

function tokens(texto) {
  return normalizar(texto)
    .split(/[^\p{L}\p{N}]+/u)
    .filter(t => t && !PALABRAS_VACIAS.has(t));
}

// ---------------------------------------------------------------------------
// Alta
// ---------------------------------------------------------------------------

/** ¿Es un mensaje libre de alta? ("compré el mac en 12 cuotas de 85 mil ...") */
export function detectarAltaCuotas(texto) {
  const original = String(texto ?? '').trim();
  if (!original || original.startsWith('/')) return false;
  const norm = normalizar(original);
  return /\bcompr\w*\b/.test(norm) && /\b\d{1,3}\s*cuotas\b/.test(norm);
}

/**
 * Interpreta el alta de una compra en cuotas (con o sin "/cuotas nueva" delante).
 * @returns {{ alias, acreedor, totalCuotas, montoCuota, montoTotal, cuotasPagadas, diaPago, aliasCartola }}
 * Cada campo es null si no se encontró; el bot pregunta lo que falte.
 */
export function parsearAltaCuotas(texto) {
  let original = String(texto ?? '').normalize('NFC').replace(/^\s*\/cuotas?(?:@\w+)?\s*/i, '').replace(/^\s*nueva\s+/i, '');
  let norm = normalizar(original);
  if (norm.length !== original.length) norm = original.toLowerCase();

  // Se "borra" un tramo con espacios en ambas copias para conservar los índices
  const quitar = (inicio, fin) => {
    const blanco = ' '.repeat(fin - inicio);
    original = original.slice(0, inicio) + blanco + original.slice(fin);
    norm = norm.slice(0, inicio) + blanco + norm.slice(fin);
  };
  const montoDespues = (desde) => {
    const analisis = analizarMonto(original.slice(desde));
    return analisis && analisis.inicio <= 1 ? analisis : null;
  };

  const r = {
    alias: null,
    acreedor: null,
    totalCuotas: null,
    montoCuota: null,
    montoTotal: null,
    cuotasPagadas: null,
    diaPago: null,
    aliasCartola: null
  };

  // Alias de varias palabras entre comillas: "macbook pro" (macbook-pro ya viene como una palabra)
  let aliasEntreComillas = null;
  let m = /["“”]([^"“”]+)["“”]/.exec(original);
  if (m) {
    aliasEntreComillas = m[1].replace(/\s+/g, ' ').trim().toLowerCase() || null;
    quitar(m.index, m.index + m[0].length);
  }

  // Alias con el que aparece en la cartola: "cartola valeska"
  m = /\bcartola\s+(\p{L}[\p{L}\p{N}]*)/u.exec(norm);
  if (m) {
    r.aliasCartola = normalizar(m[1]);
    quitar(m.index, m.index + m[0].length);
  }

  // Cuotas ya pagadas: "pagadas 6", "6 pagadas", "llevo 6"
  m = /\bpagad[ao]s?\s+(\d{1,3})\b|\b(\d{1,3})\s+pagad[ao]s?\b|\bllevo\s+(\d{1,3})\b/.exec(norm);
  if (m) {
    r.cuotasPagadas = parseInt(m[1] ?? m[2] ?? m[3], 10);
    quitar(m.index, m.index + m[0].length);
  }

  // Monto total opcional: "total 1.020.000"
  m = /\btotal\s+/.exec(norm);
  if (m) {
    const monto = montoDespues(m.index + m[0].length);
    if (monto) {
      r.montoTotal = monto.monto;
      quitar(m.index, m.index + m[0].length + monto.fin);
    }
  }

  // Día de pago opcional: "día 5", "paga el 5", "vence el 5"
  m = /\b(?:dia(?:\s+de\s+pago)?|paga(?:r)?\s+el|vence\s+el)\s+(\d{1,2})\b/.exec(norm);
  if (m) {
    const dia = parseInt(m[1], 10);
    if (dia >= 1 && dia <= 31) r.diaPago = dia;
    quitar(m.index, m.index + m[0].length);
  }

  // "12 cuotas de 85 mil"
  m = /\b(\d{1,3})\s*cuotas?\b(?:\s+(?:mensuales\s+)?de\s+)?/.exec(norm);
  if (m) {
    const total = parseInt(m[1], 10);
    if (total >= 1 && total <= 120) r.totalCuotas = total;
    const monto = montoDespues(m.index + m[0].length);
    if (monto) {
      r.montoCuota = monto.monto;
      quitar(m.index, m.index + m[0].length + monto.fin);
    } else {
      quitar(m.index, m.index + m[0].length);
    }
  } else {
    // "cuotas de 85 mil" sin la cantidad
    m = /\bcuotas?\s+de\s+/.exec(norm);
    if (m) {
      const monto = montoDespues(m.index + m[0].length);
      if (monto) {
        r.montoCuota = monto.monto;
        quitar(m.index, m.index + m[0].length + monto.fin);
      }
    }
  }

  // Lo que queda: la primera palabra es la compra (alias) y el resto, a quién se le debe
  const palabras = original
    .split(/\s+/)
    .map(p => p.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, ''))
    .filter(p => p && !PALABRAS_VACIAS.has(normalizar(p)));
  if (aliasEntreComillas) {
    r.alias = aliasEntreComillas;
    if (palabras.length > 0) r.acreedor = palabras.join(' ');
  } else {
    if (palabras.length > 0) r.alias = palabras[0].toLowerCase();
    if (palabras.length > 1) r.acreedor = palabras.slice(1).join(' ');
  }

  return r;
}

// ---------------------------------------------------------------------------
// Pago de cuota
// ---------------------------------------------------------------------------

/**
 * Interpreta "pagué cuota tía mac 6/12", "pague cuota mac 7/12" o "pagué la cuota del mac".
 * @returns {{ numero: number|null, total: number|null, monto: number|null, palabras: string[] }|null}
 * null si el mensaje no es un pago de cuota. `palabras` identifican la compra (alias o persona).
 */
export function parsearPagoCuota(texto) {
  const original = String(texto ?? '').normalize('NFC').trim();
  if (!original || original.startsWith('/')) return null;
  const norm = normalizar(original);
  const marca = /\bpag(?:ue|o|ando)\s+(?:la\s+|una\s+|otra\s+|mi\s+)?cuota\b/.exec(norm);
  if (!marca) return null;

  let resto = original.slice(marca.index + marca[0].length);

  let numero = null;
  let total = null;
  const nm = /(\d{1,3})\s*\/\s*(\d{1,3})/.exec(resto);
  if (nm) {
    numero = parseInt(nm[1], 10);
    total = parseInt(nm[2], 10);
    resto = resto.replace(nm[0], ' ');
  }

  // Monto opcional ("85 mil", "$85.000")
  let monto = null;
  const analisis = analizarMonto(resto);
  if (analisis) {
    monto = analisis.monto;
    resto = resto.slice(0, analisis.inicio) + ' ' + resto.slice(analisis.fin);
  }

  // "cuota 6" (solo un número chico, que no sea parte de un monto)
  if (numero === null) {
    const solo = /^\s*(?:numero\s+|n\s*)?(\d{1,2})\b/.exec(normalizar(resto));
    if (solo) {
      numero = parseInt(solo[1], 10);
      resto = resto.replace(/\d{1,2}/, ' ');
    }
  }

  return { numero, total, monto, palabras: tokens(resto) };
}

/**
 * Valida la cuota que se quiere pagar contra la compra.
 * @param {{total_cuotas:number, cuotas_pagadas:number, terminada?:boolean}} compra
 * @returns {{ numero:number, errores:string[], avisos:string[] }}
 * Sin número se asume la siguiente (pagadas + 1).
 */
export function validarPagoCuota(compra, { numero = null, total = null } = {}) {
  const errores = [];
  const avisos = [];
  const siguiente = Number(compra.cuotas_pagadas) + 1;
  const efectivo = numero ?? siguiente;

  if (compra.terminada) errores.push('Esta compra ya está terminada: todas sus cuotas están pagadas.');
  if (total !== null && total !== Number(compra.total_cuotas)) {
    errores.push(`El total no coincide: esta compra tiene ${compra.total_cuotas} cuotas.`);
  }
  if (efectivo > Number(compra.total_cuotas)) {
    errores.push(`La cuota ${efectivo} supera el total de ${compra.total_cuotas} cuotas.`);
  } else if (efectivo < 1) {
    errores.push('El número de cuota debe ser 1 o mayor.');
  } else if (efectivo <= Number(compra.cuotas_pagadas)) {
    avisos.push(`La cuota ${efectivo} ya estaba pagada.`);
  } else if (efectivo !== siguiente) {
    avisos.push(`La siguiente cuota esperada es la ${siguiente}, no la ${efectivo}.`);
  }

  return { numero: efectivo, errores, avisos };
}

/**
 * Busca las compras que calzan con las palabras del mensaje (alias o a quién se le debe),
 * sin tildes ni mayúsculas. Sin palabras devuelve todas las compras dadas.
 */
export function buscarCompras(compras, palabras) {
  if (!palabras || palabras.length === 0) return compras;
  return compras.filter(c => {
    const claves = [...tokens(c.alias), ...tokens(c.acreedor)];
    const alias = normalizar(c.alias);
    const acreedor = normalizar(c.acreedor);
    return palabras.every(p =>
      claves.some(k => k === p || k.startsWith(p) || p.startsWith(k)) || alias.includes(p) || acreedor.includes(p)
    );
  });
}

// ---------------------------------------------------------------------------
// Consultas sin comando
// ---------------------------------------------------------------------------

/**
 * "cuánto le debo a mi tía" -> { tipo: 'acreedor', termino: 'tia' };
 * "cuántas cuotas me quedan del mac" -> { tipo: 'compra', termino: 'mac' }.
 * Nunca si el mensaje trae un número o un monto.
 */
export function detectarConsultaCuotas(texto) {
  const original = String(texto ?? '').trim();
  if (!original || original.startsWith('/') || /\d/.test(original) || analizarMonto(original)) return null;
  const norm = normalizar(original).replace(/[?¿!¡.,]/g, ' ').replace(/\s+/g, ' ').trim();

  let m = /\bcuanto\s+(?:le\s+)?debo\s+(?:a|al)\s+(.+)$/.exec(norm);
  if (m) return { tipo: 'acreedor', termino: tokens(m[1]).join(' ') || null };

  m = /\bcuantas\s+cuotas\s+(?:me\s+)?(?:quedan|faltan)(?:\s+(?:de|del|de\s+la)\s+(.+))?$/.exec(norm);
  if (m) return { tipo: 'compra', termino: m[1] ? tokens(m[1]).join(' ') || null : null };

  m = /\bcuanto\s+(?:me\s+)?falta(?:\s+por\s+pagar)?(?:\s+(?:de|del|de\s+la)\s+(.+))?$/.exec(norm);
  if (m) return { tipo: 'compra', termino: m[1] ? tokens(m[1]).join(' ') || null : null };

  return null;
}

// ---------------------------------------------------------------------------
// Resumen y fechas
// ---------------------------------------------------------------------------

/** Próxima fecha de pago (YYYY-MM-DD) según el día del mes, desde `hoy`; null sin día de pago */
export function proximaFechaPago(diaPago, hoy) {
  if (!diaPago) return null;
  let [anio, mes] = hoy.split('-').map(Number);
  for (let i = 0; i < 2; i++) {
    const diasMes = new Date(Date.UTC(anio, mes, 0)).getUTCDate();
    const fecha = construirFecha(anio, mes, Math.min(Number(diaPago), diasMes));
    if (fecha && fecha >= hoy) return fecha;
    mes += 1;
    if (mes > 12) {
      mes = 1;
      anio += 1;
    }
  }
  return null;
}

/** Lo que falta de una compra: cuotas restantes, monto pendiente y próxima cuota */
export function resumenCompra(compra, hoy) {
  const total = Number(compra.total_cuotas);
  const pagadas = Number(compra.cuotas_pagadas);
  const restantes = Math.max(0, total - pagadas);
  const montoCuota = Number(compra.monto_cuota);
  return {
    pagadas,
    total,
    restantes,
    montoCuota,
    montoPendiente: restantes * montoCuota,
    proximaCuota: restantes > 0 ? pagadas + 1 : null,
    proximaFecha: restantes > 0 ? proximaFechaPago(compra.dia_pago, hoy) : null
  };
}

// ---------------------------------------------------------------------------
// Calce con la cartola
// ---------------------------------------------------------------------------

/**
 * Compras en curso cuyo alias_cartola aparece en la descripción de un movimiento (por ejemplo
 * "transferencia a Valeska"). Es solo una pista: quien la use debe preguntar, nunca asignar solo.
 */
export function calzarConCartola(descripcion, compras) {
  const texto = ` ${normalizar(descripcion).replace(/[^\p{L}\p{N}]+/gu, ' ')} `;
  return compras.filter(c => {
    const alias = normalizar(c.alias_cartola ?? '').trim();
    return alias.length >= 3 && texto.includes(` ${alias} `);
  });
}

/**
 * Líneas "Valeska: cuotas del mes $130.000 · pagado $85.000 · pendiente $45.000" por titular. `titulares` viene de
 * resumenMensualPorTitular(); `dinero` da formato a un monto y `esc` escapa el nombre (HTML).
 */
export function lineasPorTitular(titulares, dinero, esc = (t) => t) {
  return titulares.map(t =>
    `<b>${esc(t.titular)}</b>: cuotas del mes ${dinero(t.cuotasMes)} · pagado ${dinero(t.pagado)} · pendiente ${dinero(t.pendiente)}`
  );
}
