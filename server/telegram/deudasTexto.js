/**
 * Frases sobre deudas con abonos libres (funciones puras, sin BD). Ver deudasBot.js y deudasLibres.js.
 *
 *   "le debo 300 mil a mi mamá"                                   -> crear deuda
 *   "abono 20 mil a la deuda de mi mamá"                           -> abono
 *   "le transferí 50 mil a mi mamá de una cuota, son 50 de 300.000 que me quedan"   -> abono; quedaban 300.000 antes (quedan 250.000)
 *   "le transferí 50 mil a mi mamá, me quedan 300 mil"             -> abono; ambiguo: ¿300.000 antes o después?
 *
 * Una transferencia a alguien solo se trata como abono si el mensaje habla de una cuota, un abono, una deuda o de lo que queda: sin eso
 * es una transferencia normal y sigue su camino.
 */

import { analizarMonto } from './parser.js';
import { nombreDePersona } from '../deudasLibres.js';

const MONTO = String.raw`(\$?\s*[\d][\d.,]*(?:\s*(?:mil|k|lucas?|palos?|millon(?:es)?))?)`;
const PERSONA = String.raw`((?:mi\s+)?(?:mam[aá]|mami|madre|pap[aá]|papi|padre|hermano|hermana|t[ií]a|t[ií]o|abuela|abuelo)|[A-ZÁÉÍÓÚÑ][\p{L}'-]+(?:\s+[A-ZÁÉÍÓÚÑ][\p{L}'-]+)?)`;

const aMonto = (t) => (t ? analizarMonto(String(t).trim())?.monto ?? null : null);

/**
 * Qué dice el mensaje. Devuelve null si no es de deudas, o
 *   { tipo: 'crear', persona, total }
 *   { tipo: 'abono', persona, monto, antes?: number, despues?: number, esTransferencia: boolean }
 * `antes`: lo que quedaba antes del abono ("son 50 de 300.000 que me quedan"); `despues`: lo que queda tras el abono ("me quedan 300 mil").
 */
export function interpretarDeuda(texto) {
  const original = String(texto ?? '').trim();
  if (!original || original.startsWith('/') || original.length > 300) return null;

  // "le debo 300 mil a mi mamá" / "debo 300.000 a Pedro"
  let m = new RegExp(String.raw`^(?:le\s+)?debo\s+${MONTO}\s+a\s+${PERSONA}\s*[.!]?$`, 'iu').exec(original);
  if (m) {
    const total = aMonto(m[1]);
    return total ? { tipo: 'crear', persona: nombreDePersona(m[2]), total } : null;
  }

  // "abono 20 mil a la deuda de mi mamá" / "abono de 20 mil a la deuda con Pedro"
  m = new RegExp(String.raw`^abon(?:o|é|e|amos)\s+(?:de\s+)?${MONTO}\s+a\s+la\s+deuda\s+(?:de|con)\s+${PERSONA}\s*[.!]?$`, 'iu').exec(original);
  if (m) {
    const monto = aMonto(m[1]);
    return monto ? { tipo: 'abono', persona: nombreDePersona(m[2]), monto, esTransferencia: false } : null;
  }

  // "le transferí 50 mil a mi mamá de una cuota, son 50 de 300.000 que me quedan"
  m = new RegExp(String.raw`^(?:le\s+)?(?:transfer[ií]|deposit[eé]|pagu[eé]|abon[eé])\s+(?:de\s+)?${MONTO}\s+a\s+${PERSONA}(?=[\s,.;:!?]|$)(.*)$`, 'iu').exec(original);
  if (!m) return null;
  const monto = aMonto(m[1]);
  const resto = m[3] ?? '';
  const habla = /\b(?:cuota|abono|abon[eé]|deuda|quedan?|queda)\b/i.test(resto);
  if (!monto || !habla) return null;

  const r = { tipo: 'abono', persona: nombreDePersona(m[2]), monto, esTransferencia: true };
  // "son 50 de 300.000 que me quedan": quedaban 300.000 antes del abono
  const antes = new RegExp(String.raw`\bson?\s+[\d.,]+(?:\s*(?:mil|k|lucas?))?\s+de\s+${MONTO}\s+que\s+(?:me\s+)?quedan?`, 'iu').exec(resto);
  if (antes) {
    r.antes = aMonto(antes[1]);
    return r;
  }
  // "me quedan 300 mil": no se sabe si es antes o después del abono
  const despues = new RegExp(String.raw`\b(?:me\s+)?quedan?\s+(?:por\s+pagar\s+)?${MONTO}`, 'iu').exec(resto);
  if (despues) r.despues = aMonto(despues[1]);
  return r;
}

/**
 * Opciones para crear una deuda que todavía no existe a partir de un abono con la cifra que queda.
 *   - Con `antes` (quedaban 300.000): total 300.000, este abono lo deja en 250.000, o solo la deuda pendiente sin ligar el abono.
 *   - Con `despues` (quedan 300.000; ambiguo): total 350.000 (300.000 pendientes + este abono) o solo 300.000 pendientes después de este abono.
 * Devuelve [{ id: 'a'|'b', total, abonar: boolean, pendiente }].
 */
export function opcionesDeudaNueva({ monto, antes = null, despues = null }) {
  if (antes) {
    return [
      { id: 'a', total: antes, abonar: true, pendiente: Math.max(0, antes - monto) },
      { id: 'b', total: Math.max(0, antes - monto), abonar: false, pendiente: Math.max(0, antes - monto) }
    ];
  }
  if (despues) {
    return [
      { id: 'a', total: despues + monto, abonar: true, pendiente: despues },
      { id: 'b', total: despues, abonar: false, pendiente: despues }
    ];
  }
  return [];
}
