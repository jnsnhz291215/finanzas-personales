/**
 * El texto que acompaña a una o varias cartolas: "son de la tarjeta 8263", "cartola de la 8263", "es de la crédito de
 * Valeska". De ahí se sacan los 4 dígitos, el tipo y el titular, con reglas locales (nunca Gemini), y se aplican a todas las
 * cartolas de ese envío. Funciones puras.
 *
 * Privacidad: de un número largo solo se conservan los 4 últimos dígitos.
 */

import { normalizar, capitalizarNombre } from './cuentas.js';

/** Cuánto tiempo vale un texto sobre las cartolas (el que va justo antes o justo después del envío) */
export const VENTANA_CONTEXTO_MS = 2 * 60 * 1000;

const PALABRAS_QUE_NO_SON_NOMBRE = new Set([
  'la', 'el', 'los', 'las', 'mi', 'mis', 'tarjeta', 'credito', 'debito', 'cuenta', 'cartola', 'cartolas', 'banco', 'rut', 'vista',
  'corriente', 'ahorro', 'estas', 'estos', 'esta', 'este', 'son', 'es', 'de'
]);

/**
 * Qué dice el texto sobre las cartolas. Devuelve
 *   { esCartola, digitos, numeroLargo, tipo, titular }
 * donde `esCartola` es true si el texto habla de cartolas ("cartola de la 8263", "son de la tarjeta 8263", "es de la crédito de
 * Valeska") y no solo menciona una tarjeta, y el resto es null si no se dijo. tipo: credito | debito | cuenta_corriente |
 * cuenta_vista | ahorro.
 */
// Con { caption: true } (el texto que acompaña a un archivo) también vale la forma corta que solo nombra la cuenta:
// "credito 8263", "tarjeta 8263", "tarjeta credito 8263", "credito valeska 8263".
export function leerContextoCartola(texto, { caption = false } = {}) {
  const original = String(texto ?? '').trim();
  const vacio = { esCartola: false, mencionaCartola: false, digitos: null, numeroLargo: false, tipo: null, titular: null };
  if (!original || original.startsWith('/') || original.length > 200) return vacio;

  const norm = normalizar(original).replace(/[¿?¡!,;:.]/g, ' ').replace(/\s+/g, ' ').trim();

  const habla = /\bcartolas?\b/.test(norm) ||
    /^(?:(?:estas?|este|estos|esta)\s+)?(?:son|es|eran)\s+de\s+(?:la|el|mi)\s+(?:tarjeta|cuenta|credito|debito|rut|vista|corriente|\d)/.test(norm) ||
    (caption && /^(?:(?:la|mi|una)\s+)?(?:tarjeta|credito|debito|cuenta(?:\s+(?:corriente|vista|rut))?)(?:\s+[a-z]+){0,3}\s+\**\d{4}$/.test(norm));

  // 4 a 19 dígitos (con espacios o guiones): se guardan solo los 4 últimos
  const numero = /(?<![\d$])(\d(?:[\s.-]?\d){3,18})(?!\d)(?!\s*(?:pesos|mil|lucas|luca|palos|k)\b)/.exec(original);
  const todos = numero ? numero[1].replace(/\D/g, '') : '';
  const digitos = todos.length >= 4 ? todos.slice(-4) : null;

  let tipo = null;
  if (/\bcredito\b/.test(norm)) tipo = 'credito';
  else if (/\bdebito\b/.test(norm)) tipo = 'debito';
  else if (/\bcuenta corriente\b/.test(norm)) tipo = 'cuenta_corriente';
  else if (/\b(?:cuenta vista|cuenta rut|\brut\b|vista)\b/.test(norm)) tipo = 'cuenta_vista';
  else if (/\bahorro\b/.test(norm)) tipo = 'ahorro';

  // Titular: "de Valeska" al final, o "titular X" / "a nombre de X"
  let titular = null;
  let m = /\b(?:titular|a nombre de)\s+(.+)$/i.exec(original);
  if (!m) m = /\bde\s+([A-Za-zÁÉÍÓÚÜÑáéíóúüñ][\p{L}'-]*(?:\s+[A-Za-zÁÉÍÓÚÜÑáéíóúüñ][\p{L}'-]*){0,2})\s*[.!]*$/u.exec(original);
  if (m) {
    const palabras = m[1].replace(/[.,;:!]+$/g, '').trim().split(/\s+/);
    const valido = palabras.length <= 3 && palabras.every(p => !/\d/.test(p) && !PALABRAS_QUE_NO_SON_NOMBRE.has(normalizar(p)));
    if (valido) titular = capitalizarNombre(palabras.join(' '));
  }

  return { esCartola: habla, mencionaCartola: /\bcartolas?\b/.test(norm), digitos, numeroLargo: todos.length > 4, tipo, titular };
}

/** ¿El contexto trae algo útil para identificar la cuenta? */
export function contextoUtil(contexto) {
  return Boolean(contexto && (contexto.digitos || contexto.tipo || contexto.titular));
}

/**
 * Cruza el contexto con la cuenta y con lo que se leyó en la cartola:
 *   { estado: 'coincide' | 'segun_texto' | 'no_coincide' | 'sin_cuenta' | 'sin_dato', cuenta, otraCuenta }
 * - coincide: la cuenta del texto tiene los dígitos que se leyeron en la cartola;
 * - segun_texto: la cartola no trae dígitos legibles, se confía en el texto;
 * - no_coincide: el texto y la cartola dicen dígitos distintos (otraCuenta: la que corresponde a los de la cartola, si existe);
 * - sin_cuenta: no existe una cuenta con esos dígitos (hay que ofrecer crearla);
 * - sin_dato: el contexto no permite identificar una cuenta.
 * `cuentas`: { id, nombre, tipo, ultimos4, ultimos4_cuenta }; `digitosCartola`: los 4 dígitos que se leyeron en la cartola.
 */
export function cruzarContextoConCuentas(contexto, cuentas, digitosCartola = []) {
  const esperado = contexto?.tipo
    ? { credito: 'tarjeta_credito', debito: 'tarjeta_debito', cuenta_corriente: 'cuenta_corriente', cuenta_vista: 'cuenta_vista', ahorro: 'cuenta_ahorro' }[contexto.tipo]
    : null;
  const coincideTipo = (c) => !esperado || c.tipo === esperado;

  let cuenta = null;
  if (contexto?.digitos) {
    const delTexto = cuentas.filter(c => c.ultimos4 === contexto.digitos || c.ultimos4_cuenta === contexto.digitos);
    cuenta = (delTexto.find(coincideTipo) ?? delTexto[0]) ?? null;
    if (!cuenta) return { estado: 'sin_cuenta', cuenta: null, otraCuenta: null };
  } else if (contexto?.titular && esperado) {
    // Sin dígitos ("es de la crédito de Valeska"): vale solo si hay una única cuenta de ese tipo y titular
    const t = normalizar(contexto.titular);
    const candidatas = cuentas.filter(c => coincideTipo(c) && c.titular && normalizar(c.titular).includes(t));
    if (candidatas.length !== 1) return { estado: 'sin_dato', cuenta: null, otraCuenta: null };
    cuenta = candidatas[0];
  } else {
    return { estado: 'sin_dato', cuenta: null, otraCuenta: null };
  }

  const propios = [cuenta.ultimos4, cuenta.ultimos4_cuenta].filter(Boolean);
  if (digitosCartola.length === 0) return { estado: 'segun_texto', cuenta, otraCuenta: null };
  if (digitosCartola.some(d => propios.includes(d))) return { estado: 'coincide', cuenta, otraCuenta: null };

  const otraCuenta = cuentas.find(c => c.id !== cuenta.id && digitosCartola.some(d => d === c.ultimos4 || d === c.ultimos4_cuenta)) ?? null;
  return { estado: 'no_coincide', cuenta, otraCuenta };
}
