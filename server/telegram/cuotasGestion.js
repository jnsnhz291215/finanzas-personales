/**
 * Renombrar y agrupar compras en cuotas con lenguaje natural (funciones puras, sin BD). Ver cuotasGestionBot.js.
 *
 *   "renombra la cuota Apple de 21.749 a AppleCare"      /renombrarcuota Apple 21.749 a AppleCare
 *   "la de apple de 202 mil es el Mac"
 *   "junta Apple 202.332 y Apple 21.749 como Mac"        /agruparcuotas Apple 202.332 y Apple 21.749 como Mac
 *   "el AppleCare es parte del Mac"
 *   "desagrupa el Mac"                                   /agruparcuotas desagrupar Mac
 *
 * Renombrar solo cambia el nombre con que se MUESTRA (nombre_mostrar); el nombre real (alias y alias_cartola) sigue siendo el que empareja
 * con las cartolas. Agrupar es solo visual y de totales.
 */

import { analizarMonto } from './parser.js';
import { normalizar } from './cuotas.js';

const PALABRAS_VACIAS = new Set(['de', 'del', 'la', 'el', 'los', 'las', 'cuota', 'cuotas', 'compra', 'compras', 'por', 'con', 'mi', 'que']);

/** Quita comillas y puntuación de los bordes de un nombre */
function limpiarNombre(texto) {
  return String(texto ?? '').replace(/^[\s"“”'«»]+|[\s"“”'«».,;:!?]+$/g, '').replace(/\s+/g, ' ').trim().slice(0, 100);
}

/** "apple de 21.749", "apple 202 mil" o "apple" -> { nombre: 'apple', monto: 21749 | null } */
export function parsearReferencia(texto) {
  const t = String(texto ?? '').replace(/^(?:la|el|las|los)\s+/i, '').replace(/^(?:cuota|compra)\s+(?:de\s+)?/i, '').trim();
  const analisis = analizarMonto(t);
  const sinMonto = analisis ? `${t.slice(0, analisis.inicio)} ${t.slice(analisis.fin)}` : t;
  const nombre = normalizar(sinMonto)
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .split(/\s+/)
    .filter(p => p && !PALABRAS_VACIAS.has(p))
    .join(' ');
  return { nombre, monto: analisis ? analisis.monto : null };
}

/** Texto de la orden sin el comando ("/renombrarcuota ...") */
const sinComando = (texto) => String(texto ?? '').trim().replace(/^\/\w+(?:@\w+)?\s*/, '');

/**
 * Orden de renombrar: { ref: { nombre, monto }, nuevo } o null.
 * Frases con verbo ("renombra la cuota Apple de 21.749 a AppleCare"), la forma corta "la de apple de 202 mil es el Mac" y, con el comando,
 * "Apple 21.749 a AppleCare".
 */
export function parsearRenombrar(texto) {
  const original = String(texto ?? '').trim();
  const esComando = /^\/(?:renombrarcuota|renombrar)\b/i.test(original);
  const t = sinComando(original);
  let m = /^renombr(?:a|ar|ame)\s+(?:la\s+|el\s+)?(?:cuota\s+|compra\s+)?(.+?)\s+(?:a|como|por)\s+(.+)$/i.exec(t);
  if (!m && esComando) m = /^(?:la\s+|el\s+)?(?:cuota\s+|compra\s+)?(.+?)\s+(?:a|como|por)\s+(.+)$/i.exec(t);
  if (!m && !esComando) m = /^la\s+(?:cuota\s+|compra\s+)?(?:de\s+)?(.+?)\s+(?:es|ser[aá])\s+(?:el\s+|la\s+|mi\s+)?(.+)$/i.exec(t);
  if (!m) return null;
  const ref = parsearReferencia(m[1]);
  const nuevo = limpiarNombre(m[2]);
  if (!ref.nombre && !ref.monto) return null;
  if (!nuevo) return null;
  return { ref, nuevo, esComando };
}

/**
 * Orden de agrupar: { tipo: 'agrupar', refs: [...], grupo } | { tipo: 'parte', ref, grupo } | { tipo: 'desagrupar', nombre } | null.
 */
export function parsearAgrupar(texto) {
  const original = String(texto ?? '').trim();
  const esComando = /^\/agruparcuotas\b/i.test(original);
  const t = sinComando(original);

  let m = /^(?:desagrup(?:a|ar)|separa(?:r)?|sac(?:a|ar))\s+(?:el\s+grupo\s+|la\s+compra\s+|el\s+|la\s+)?(.+)$/i.exec(t);
  if (m) return { tipo: 'desagrupar', nombre: limpiarNombre(m[1]) };

  m = /^(?:el|la)\s+(.+?)\s+es\s+parte\s+(?:del|de\s+la|de\s+el)\s+(.+)$/i.exec(t);
  if (m) {
    const ref = parsearReferencia(m[1]);
    return ref.nombre || ref.monto ? { tipo: 'parte', ref, grupo: limpiarNombre(m[2]) } : null;
  }

  m = /^(?:junta(?:r)?|agrupa(?:r)?|une|unir)\s+(.+?)\s+(?:como|en|bajo)\s+(.+)$/i.exec(t);
  if (!m && esComando) m = /^(.+?)\s+(?:como|en|bajo)\s+(.+)$/i.exec(t);
  if (!m) return null;
  const refs = m[1].split(/\s+y\s+|\s*,\s*|\s+con\s+/i).map(parsearReferencia).filter(r => r.nombre || r.monto);
  const grupo = limpiarNombre(m[2]);
  return refs.length >= 2 && grupo ? { tipo: 'agrupar', refs, grupo } : null;
}

/**
 * Fijar a mano cuántas cuotas van pagadas: { ref: { nombre, monto }, n } o null.
 *   «del Mac van 6 pagadas»   «la última cuota pagada del Mac es la 6»   /cuotaspagadas Mac 6   /cuotaspagadas Apple 21.749 6
 */
export function parsearCuotasPagadas(texto) {
  const original = String(texto ?? '').trim();
  const esComando = /^\/cuotaspagadas\b/i.test(original);
  const t = sinComando(original);
  let m = /^del?\s+(?:la\s+|el\s+)?(.+?)\s+van\s+(\d{1,3})\s+(?:cuotas\s+)?pagadas?\s*[.!]?$/i.exec(t);
  if (!m) m = /^la\s+[uú]ltima\s+cuota\s+pagada\s+del?\s+(?:la\s+|el\s+)?(.+?)\s+es\s+(?:la\s+)?(\d{1,3})\s*[.!]?$/i.exec(t);
  if (!m && esComando) m = /^(.+?)\s+(?:van\s+|es\s+la\s+|en\s+)?(\d{1,3})\s*(?:pagadas?)?\s*$/i.exec(t);
  if (!m) return null;
  const ref = parsearReferencia(m[1]);
  if (!ref.nombre && !ref.monto) return null;
  return { ref, n: Number(m[2]), esComando };
}

/** ¿El valor de la cuota de la compra calza con el que dijo el usuario? Exacto (±1) o, si dijo "202 mil", dentro de esos mil pesos */
export function montoCalza(montoCuota, dicho) {
  if (!dicho) return true;
  const cuota = Number(montoCuota);
  if (Math.abs(cuota - dicho) <= 1) return true;
  if (dicho % 1000 === 0) return Math.floor(cuota / 1000) * 1000 === dicho || Math.round(cuota / 1000) * 1000 === dicho;
  return false;
}

/** Compras que calzan con la referencia: todas las palabras del nombre (en su nombre real o mostrado) y, si se dijo, el valor de la cuota */
export function buscarPorReferencia(compras, ref) {
  const palabras = String(ref?.nombre ?? '').split(/\s+/).filter(Boolean);
  return compras.filter(c => {
    const nombres = ` ${normalizar(c.alias)} ${normalizar(c.nombre_mostrar ?? '')} `.replace(/[^\p{L}\p{N}\s]/gu, ' ');
    return palabras.every(p => nombres.includes(p)) && montoCalza(c.monto_cuota, ref?.monto ?? null);
  });
}
