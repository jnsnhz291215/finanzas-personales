/**
 * Lote de archivos en curso por chat (para /cancelar y el botón «Cancelar lote»).
 *
 * Lleva la cuenta de cuántos archivos llegaron y cuántos se procesaron, y los mensajes con preguntas del lote que siguen sin responder (para
 * quitarles el teclado y agregarles «Cancelado.» al cancelar). No guarda ni borra datos: cancelar nunca deshace lo ya guardado.
 */

// Preguntas del flujo de cartolas (cartolasBot.js y loteTerceros.js): sus botones empiezan con estos prefijos
const PREFIJOS_PREGUNTA = /^(?:lc|cx|ca|cb)[a-z0-9]?_/;

const lotes = new Map();

/** ¿Este teclado es el de una pregunta de un lote de cartolas? */
export function esPreguntaDeLote(opciones) {
  const filas = opciones?.reply_markup?.inline_keyboard;
  if (!Array.isArray(filas)) return false;
  return filas.flat().some(b => PREFIJOS_PREGUNTA.test(String(b?.callback_data ?? '')));
}

/** Empieza un lote nuevo (reemplaza al anterior). `total`: cuántos archivos se esperan; null si se va contando a medida que llegan. */
export function iniciarLote(chatId, total = null) {
  const lote = { id: Date.now(), total, recibidos: 0, procesados: 0, descargando: false, preguntas: new Map(), cancelado: false, creadoEn: Date.now() };
  lotes.set(chatId, lote);
  return lote;
}

/** El lote vigente (no cancelado); null si no hay */
export function loteActual(chatId) {
  const lote = lotes.get(chatId);
  return lote && !lote.cancelado ? lote : null;
}

/** Cuenta un archivo recibido; crea el lote si todavía no había (por ejemplo fotos de cartola) */
export function sumarRecibido(chatId, n = 1) {
  const lote = loteActual(chatId) ?? iniciarLote(chatId, null);
  lote.recibidos += n;
  return lote;
}

/** Mientras bot.js descarga los archivos del envío, el lote cuenta como en curso */
export function marcarDescargando(chatId, valor) {
  const lote = lotes.get(chatId);
  if (lote && !lote.cancelado) lote.descargando = Boolean(valor);
}

export function marcarProcesado(chatId, n = 1) {
  const lote = lotes.get(chatId);
  if (lote && !lote.cancelado) lote.procesados += n;
}

/** ¿Se canceló este lote (o el que está en curso)? `lote` es el objeto que devolvió loteActual al empezar */
export function estaCancelado(chatId, lote = null) {
  const actual = lotes.get(chatId);
  if (lote) return Boolean(lote.cancelado);
  return Boolean(actual?.cancelado);
}

/** Guarda una pregunta mandada durante el lote (su texto sirve para agregarle «Cancelado.») */
export function registrarPregunta(chatId, messageId, texto) {
  const lote = loteActual(chatId);
  if (lote && messageId) lote.preguntas.set(messageId, texto ?? '');
}

/** Una pregunta ya contestada deja de contar */
export function olvidarPregunta(chatId, messageId) {
  lotes.get(chatId)?.preguntas.delete(messageId);
}

export function hayLote(chatId) {
  return Boolean(loteActual(chatId));
}

/**
 * Cancela el lote: lo marca como cancelado y devuelve { total, procesados, preguntas: [[messageId, texto]] } (null si no había). Quien llama se
 * encarga de detener las colas y de quitarles el teclado a las preguntas (ver cerrarPreguntas).
 */
export function cancelarLote(chatId) {
  const lote = loteActual(chatId);
  if (!lote) return null;
  lote.cancelado = true;
  return {
    total: lote.total ?? lote.recibidos,
    recibidos: lote.recibidos,
    descargando: lote.descargando,
    procesados: lote.procesados,
    preguntas: [...lote.preguntas.entries()]
  };
}

/**
 * Quita el teclado de las preguntas pendientes y les agrega «Cancelado.». Una pregunta que ya no tiene teclado (ya se contestó y se editó)
 * no se toca. Devuelve cuántas preguntas seguían sin responder.
 */
export async function cerrarPreguntas(bot, chatId, preguntas) {
  let sinResponder = 0;
  for (const [messageId, texto] of preguntas) {
    try {
      await bot.editMessageReplyMarkup({ inline_keyboard: [] }, { chat_id: chatId, message_id: messageId });
    } catch {
      // ya no tenía teclado, o el mensaje ya no existe: no es una pregunta pendiente
      continue;
    }
    sinResponder++;
    if (texto) {
      try {
        await bot.editMessageText(`${texto}\n\n<i>Cancelado.</i>`, { chat_id: chatId, message_id: messageId, parse_mode: 'HTML' });
      } catch {
        // el teclado ya se quitó; el texto es un detalle
      }
    }
  }
  return sinResponder;
}

/** Texto de la respuesta al cancelar */
export function textoCancelacion({ total, procesados, sinResponder }) {
  return (
    `Cancelé el lote: procesé ${procesados} de ${total} ${total === 1 ? 'archivo' : 'archivos'}, ` +
    `quedaron ${sinResponder} ${sinResponder === 1 ? 'pregunta' : 'preguntas'} sin responder. ` +
    'Lo ya guardado sigue guardado; si quieres borrarlo usa /resetcuenta.'
  );
}

/** Frases que cancelan lo que está en curso ("cancela", "para", "detente"...) */
export function esOrdenDeCancelar(texto) {
  return /^\s*(?:cancela(?:r)?|para|parar|det[eé]nte|detener|stop|basta|alto)(?:\s+(?:todo|el\s+lote|esto|eso))?\s*[.!]*\s*$/i.test(String(texto ?? ''));
}
