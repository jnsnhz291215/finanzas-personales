/**
 * Mensajes de error claros para el usuario y detalle completo en el log.
 *
 *   describirError(err, paso, objeto) -> { usuario, plano, causa, tipo }
 *
 * - `paso`: qué se estaba haciendo (descargar, leer_pdf, reconocer_formato, guardar_bd, crear_compra, mover_archivo, guardar_archivo,
 *   consultar, procesar, borrar, actualizar...).
 * - `objeto`: sobre qué (el nombre del archivo, «Apple» ($21.749), la cuenta...). Texto crudo: el helper lo escapa.
 * - `usuario`: mensaje en español listo para enviar con parse_mode HTML (ya escapado); `plano`: lo mismo sin HTML (para toasts).
 * - Traduce errores conocidos (red, timeout, duplicado, PDF ilegible, formato no reconocido, cuenta no encontrada, disco, base de datos
 *   ocupada, límites de Telegram); si es desconocido muestra el paso y el mensaje técnico corto.
 * - Nunca incluye tokens, URLs, rutas completas ni números largos (de tarjeta o cuenta) en lo que ve el usuario ni en lo que se registra.
 * - Registra en el log el detalle completo (mensaje, causa y stack, saneados) salvo que se pida `{ registrar: false }`.
 */

const REDES = ['ECONNRESET', 'ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'EPIPE', 'ENETUNREACH', 'EHOSTUNREACH', 'ECONNABORTED'];

/** Quita de un texto el token del bot, las URLs, las rutas completas y los números largos (de ahí quedan solo los 4 últimos dígitos) */
export function sanear(texto) {
  let t = String(texto ?? '');
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (token) t = t.split(token).join('***');
  return t
    .replace(/https?:\/\/\S+/gi, '<url>')
    .replace(/\bbot\d{6,}:[\w-]{20,}/g, 'bot***')
    .replace(/[A-Za-z]:\\(?:[\w.()-]+\\?)+/g, '<ruta>')
    .replace(/(?<![\w.])(?:\/[\w.()-]+){2,}/g, '<ruta>')
    .replace(/\b\d(?:[\s-]?\d){8,}\b/g, (m) => `****${m.replace(/\D/g, '').slice(-4)}`);
}

const escapar = (t) => String(t).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function codigos(err) {
  const lista = [];
  for (let e = err, i = 0; e && i < 4; e = e.cause, i++) {
    lista.push(e.code, e.errno, e.name, e.codigoApp, e?.response?.statusCode);
  }
  return lista.filter(c => c !== undefined && c !== null).map(String);
}

/** { tipo, causa } de un error: la causa es una frase corta en español que cabe tras «No pude ...: » */
export function clasificarError(err, paso = '') {
  const cods = codigos(err);
  const mensaje = `${err?.message ?? ''} ${err?.cause?.message ?? ''}`.toLowerCase();
  const tiene = (...c) => c.some(x => cods.includes(x));

  if (tiene('FORMATO_NO_RECONOCIDO')) return { tipo: 'formato', causa: 'no reconozco el formato del archivo' };
  if (tiene('CUENTA_NO_ENCONTRADA')) return { tipo: 'cuenta', causa: 'no encontré esa cuenta' };
  if (tiene('ETIMEDOUT', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT', 'TimeoutError', 'AbortError') || /timeout|timed out|se agotó/.test(mensaje)) {
    return { tipo: 'timeout', causa: 'tardó demasiado en responder' };
  }
  if (tiene(...REDES) || cods.some(c => c.startsWith('UND_ERR')) || /fetch failed|network|socket hang up|other side closed/.test(mensaje)) {
    return { tipo: 'red', causa: 'se cortó la conexión' };
  }
  if (tiene('429') || /too many requests|retry after/.test(mensaje)) return { tipo: 'limite', causa: 'Telegram pide esperar un momento' };
  if (/file is too big|too large|entity too large/.test(mensaje)) return { tipo: 'grande', causa: 'pesa más de 20 MB, el máximo que Telegram deja descargar' };
  if (tiene('ER_DUP_ENTRY', '1062', 'SQLITE_CONSTRAINT_UNIQUE', 'SQLITE_CONSTRAINT_PRIMARYKEY') || /unique constraint|duplicate entry/.test(mensaje)) {
    return { tipo: 'duplicado', causa: paso === 'crear_compra' ? 'ya existe una compra igual' : 'ya existe un registro igual' };
  }
  if (tiene('ER_LOCK_DEADLOCK', 'ER_LOCK_WAIT_TIMEOUT', 'SQLITE_BUSY', 'SQLITE_LOCKED')) return { tipo: 'bd_ocupada', causa: 'la base de datos estaba ocupada' };
  if (tiene('ER_DATA_TOO_LONG', 'ER_TRUNCATED_WRONG_VALUE', 'ER_WARN_DATA_OUT_OF_RANGE')) return { tipo: 'dato', causa: 'un dato es demasiado largo o no tiene un formato válido' };
  if (tiene('ER_NO_REFERENCED_ROW_2', 'ER_NO_REFERENCED_ROW', 'SQLITE_CONSTRAINT_FOREIGNKEY')) return { tipo: 'referencia', causa: 'depende de algo que ya no existe' };
  if (tiene('ENOSPC')) return { tipo: 'disco', causa: 'no hay espacio en el disco' };
  if (tiene('EACCES', 'EPERM')) return { tipo: 'permiso', causa: 'no tengo permiso para escribir ahí' };
  if (tiene('ENOENT')) return { tipo: 'archivo', causa: 'el archivo ya no está' };
  if (tiene('InvalidPDFException', 'FormatError', 'PasswordException') || /invalid pdf|bad xref|xref|pdf header|encrypted/.test(mensaje)) {
    return { tipo: 'pdf', causa: 'el PDF está dañado, protegido o no se puede leer' };
  }
  const corto = sanear(err?.message ?? 'sin detalle').replace(/\s+/g, ' ').trim().slice(0, 120);
  return { tipo: 'desconocido', causa: `error técnico: ${corto || 'sin detalle'}` };
}

const FRASES = {
  descargar: (o, c) => `No pude descargar ${o} desde Telegram: ${c}. Reenvíalo.`,
  leer_pdf: (o, c) => `No pude leer ${o}: ${c}.`,
  reconocer_formato: (o, c) => `No reconocí el formato de ${o}: ${c}.`,
  guardar_bd: (o, c) => `No pude guardar ${o} en la base de datos: ${c}.`,
  crear_compra: (o, c) => `No pude crear ${o}: ${c}.`,
  mover_archivo: (o, c) => `No pude mover ${o}: ${c}.`,
  guardar_archivo: (o, c) => `No pude guardar el archivo ${o}: ${c}.`,
  consultar: (o, c) => `No pude consultar ${o}: ${c}.`,
  procesar: (o, c) => `No pude procesar ${o}: ${c}.`,
  borrar: (o, c) => `No pude borrar ${o}: ${c}.`,
  actualizar: (o, c) => `No pude actualizar ${o}: ${c}.`,
  guardar: (o, c) => `No pude guardar ${o}: ${c}.`,
  vincular: (o, c) => `No pude vincular ${o}: ${c}.`,
  leer: (o, c) => `No pude leer ${o}: ${c}.`,
  ocr: (o, c) => `No pude leer el texto de ${o} con el OCR: ${c}.`,
  gemini: (o, c) => `No pude consultar a Gemini para ${o}: ${c}. Sigo solo con las reglas locales.`
};

/** Registra el detalle completo (con stack y causa) sin secretos */
export function registrarError(err, paso, objeto = '', { log = console.error } = {}) {
  const causa = err?.cause ? ` | causa: ${err.cause.name}: ${err.cause.code ?? ''} ${err.cause.message}` : '';
  log(sanear(`[error] paso=${paso} objeto="${objeto}" ${err?.name ?? 'Error'}: ${err?.message ?? ''}${causa}\n${err?.stack ?? ''}`));
}

function armar(paso, objeto, causa, tipo) {
  const o = sanear(objeto);
  const frase = (FRASES[paso] ?? ((ob, c) => `No pude ${String(paso).replace(/_/g, ' ')}${ob ? ` ${ob}` : ''}: ${c}.`))(o, causa);
  return { usuario: escapar(frase), plano: frase, toast: frase.slice(0, 190), causa, tipo };
}

export function describirError(err, paso, objeto = '', { registrar = true, log = console.error } = {}) {
  const { tipo, causa } = clasificarError(err, paso);
  if (registrar) registrarError(err, paso, objeto, { log });
  return armar(paso, objeto, causa, tipo);
}

/** Igual que describirError pero para un motivo que ya viene en español (por ejemplo el `error` de una validación): no es una excepción */
export function describirMotivo(paso, objeto, motivo) {
  const causa = sanear(String(motivo ?? 'sin detalle')).replace(/[.\s]+$/g, '');
  return armar(paso, objeto, causa.charAt(0).toLowerCase() + causa.slice(1), 'validacion');
}
