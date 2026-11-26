/**
 * Interpretación del texto que el OCR leyó de la captura de un comprobante de transferencia: monto,
 * fecha y si menciona a alguien. Funciones puras; no registran nada. El texto puede traer RUT y
 * números de cuenta: nunca se guarda ni se manda a ningún servicio externo.
 *
 * El OCR de capturas de apps bancarias comete errores, así que el resultado es una propuesta que el
 * bot siempre confirma con el usuario.
 */

import { normalizar } from './cuentas.js';
import { construirFecha, fechaHoySantiago, sumarDias } from './fechas.js';

const MESES = {
  enero: 1, ene: 1, febrero: 2, feb: 2, marzo: 3, mar: 3, abril: 4, abr: 4, mayo: 5, may: 5, junio: 6, jun: 6,
  julio: 7, jul: 7, agosto: 8, ago: 8, septiembre: 9, setiembre: 9, sep: 9, sept: 9, octubre: 10, oct: 10,
  noviembre: 11, nov: 11, diciembre: 12, dic: 12
};

/** Montos con $ (o $ mal leído) en el texto: [{ monto, linea }] */
function montosConSigno(texto) {
  const montos = [];
  for (const linea of String(texto).split('\n')) {
    for (const m of linea.matchAll(/[$S§]\s?(\d{1,3}(?:[.,]\d{3})+|\d{3,9})(?!\d)/g)) {
      const monto = parseInt(m[1].replace(/[.,]/g, ''), 10);
      if (monto > 0) montos.push({ monto, linea });
    }
  }
  return montos;
}

/**
 * Monto del comprobante: el de la línea que dice monto/total/transferido/importe; si no hay, el
 * único monto con $; si hay varios y ninguno rotulado, null (no se adivina).
 */
export function extraerMontoComprobante(texto) {
  const montos = montosConSigno(texto);
  if (montos.length === 0) return null;
  const rotulados = montos.filter(m => /monto|total|transfer|importe|valor/.test(normalizar(m.linea)));
  const candidatos = rotulados.length > 0 ? rotulados : montos;
  const distintos = [...new Set(candidatos.map(m => m.monto))];
  return distintos.length === 1 ? distintos[0] : null;
}

/** Primera fecha (YYYY-MM-DD) del texto que no sea futura: 24/11/2026, 24-11-26, 24 de noviembre de 2026, 24 nov 2026 */
export function extraerFechaComprobante(texto, hoy = fechaHoySantiago()) {
  const norm = normalizar(texto);
  const maximo = sumarDias(hoy, 1);
  const candidatas = [];

  for (const m of norm.matchAll(/\b(\d{1,2})[/.-](\d{1,2})[/.-](\d{4}|\d{2})\b/g)) {
    const anio = m[3].length === 2 ? 2000 + Number(m[3]) : Number(m[3]);
    candidatas.push({ indice: m.index, fecha: construirFecha(anio, Number(m[2]), Number(m[1])) });
  }
  for (const m of norm.matchAll(/\b(\d{1,2})(?:\s+de)?[\s.-]+([a-z]{3,10})\.?(?:[\s.-]+(?:de[\s.-]+)?(\d{4}))?/g)) {
    const mes = MESES[m[2]];
    if (!mes) continue;
    candidatas.push({ indice: m.index, fecha: construirFecha(m[3] ? Number(m[3]) : Number(hoy.slice(0, 4)), mes, Number(m[1])) });
  }
  return candidatas
    .filter(c => c.fecha && c.fecha <= maximo)
    .sort((a, b) => a.indice - b.indice)[0]?.fecha ?? null;
}

/** ¿El texto menciona esa persona? (por nombre o apellido, sin tildes ni mayúsculas, palabra completa) */
export function mencionaNombre(texto, nombre) {
  const palabras = normalizar(nombre).split(/\s+/).filter(p => p.length >= 3);
  if (palabras.length === 0) return false;
  const norm = ` ${normalizar(texto).replace(/[^\p{L}\p{N}]+/gu, ' ')} `;
  return palabras.some(p => norm.includes(` ${p} `));
}

/**
 * Qué se entiende del comprobante: { esTransferencia, monto, fecha }. Es transferencia si habla de
 * transferencia o comprobante y trae un monto.
 */
export function parsearComprobante(texto, hoy = fechaHoySantiago()) {
  const norm = normalizar(texto);
  const monto = extraerMontoComprobante(texto);
  return {
    esTransferencia: monto !== null && /transfer|comprobante|deposito/.test(norm),
    monto,
    fecha: extraerFechaComprobante(texto, hoy)
  };
}
