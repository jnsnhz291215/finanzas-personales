/**
 * Registro de los mensajes del chat (los que el bot envía y los que recibe) para que /limpiar pueda borrarlos. Telegram no deja a un bot
 * listar ni borrar el historial: solo borrar, mensaje por mensaje, los de menos de 48 horas y conociendo su message_id.
 *
 * Solo se guardan ids (chat, mensaje, fecha, origen); nunca el texto. Los registros de más de 48 h se purgan al iniciar y cada hora.
 */

const HORAS_48_MS = 48 * 60 * 60 * 1000;
// Margen para no intentar borrar justo en el límite de las 48 h
const MARGEN_MS = 10 * 60 * 1000;
export const VENTANA_BORRABLE_MS = HORAS_48_MS - MARGEN_MS;

async function consulta() {
  return (await import('../db.js')).query;
}

/** Guarda un mensaje (ignora el que ya estaba). Nunca lanza: registrar no debe romper el bot. */
export async function registrarMensaje(chatId, messageId, origen, ahora = Date.now()) {
  if (!chatId || !messageId) return false;
  try {
    const query = await consulta();
    await query('INSERT INTO mensajes_chat (chat_id, message_id, fecha, origen) VALUES (?, ?, ?, ?)', [chatId, messageId, ahora, origen]);
    return true;
  } catch {
    // ya estaba registrado (UNIQUE) o la BD no está disponible: no importa
    return false;
  }
}

/** Borra los registros de más de 48 h (ya no se pueden borrar de Telegram). Devuelve cuántos. */
export async function purgarMensajesViejos(ahora = Date.now()) {
  try {
    const query = await consulta();
    const [r] = await query('DELETE FROM mensajes_chat WHERE fecha < ?', [ahora - HORAS_48_MS]);
    return Number(r?.affectedRows ?? r?.changes ?? 0);
  } catch {
    return 0;
  }
}

/** Mensajes del chat que todavía se pueden borrar (menos de 48 h), los más recientes primero: [{ message_id, origen }] */
export async function listarBorrables(chatId, ahora = Date.now()) {
  const query = await consulta();
  const [filas] = await query(
    'SELECT message_id, origen FROM mensajes_chat WHERE chat_id = ? AND fecha >= ? ORDER BY message_id DESC',
    [chatId, ahora - VENTANA_BORRABLE_MS]
  );
  return filas.map(f => ({ message_id: Number(f.message_id), origen: f.origen }));
}

/** Olvida estos mensajes (ya se borraron o ya no existen) */
export async function olvidarMensajes(chatId, ids) {
  if (!ids.length) return;
  const query = await consulta();
  for (let i = 0; i < ids.length; i += 200) {
    const lote = ids.slice(i, i + 200);
    await query(`DELETE FROM mensajes_chat WHERE chat_id = ? AND message_id IN (${lote.map(() => '?').join(', ')})`, [chatId, ...lote]);
  }
}

/**
 * Qué mensajes borra /limpiar: todos los borrables salvo, si `conservar` > 0, los `conservar` más recientes de los que no están en
 * `excluir` (la orden /limpiar y su pregunta, que sí se borran). Devuelve { borrar: [ids], conservados: [ids] }.
 */
export function elegirMensajes(borrables, { conservar = 0, excluir = [] } = {}) {
  const fuera = new Set(excluir.map(Number));
  const ids = [...new Set([...borrables.map(b => Number(b.message_id)), ...fuera])].sort((a, b) => b - a);
  const normales = ids.filter(id => !fuera.has(id));
  const conservados = conservar > 0 ? normales.slice(0, conservar) : [];
  const guardar = new Set(conservados);
  return { borrar: ids.filter(id => !guardar.has(id)), conservados };
}

/**
 * Envuelve los envíos del bot (sendMessage, sendDocument, sendPhoto) para registrar cada mensaje que sale. Se llama una vez al crear el bot.
 */
export function registrarSalidas(bot) {
  for (const metodo of ['sendMessage', 'sendDocument', 'sendPhoto']) {
    const original = bot[metodo]?.bind(bot);
    if (!original) continue;
    bot[metodo] = async (...args) => {
      const resultado = await original(...args);
      if (resultado?.message_id && resultado?.chat?.id) registrarMensaje(resultado.chat.id, resultado.message_id, 'bot').catch(() => {});
      return resultado;
    };
  }
}

/** Purga al iniciar y cada hora */
export function programarPurga() {
  purgarMensajesViejos().catch(() => {});
  const temporizador = setInterval(() => purgarMensajesViejos().catch(() => {}), 60 * 60 * 1000);
  temporizador.unref?.();
  return temporizador;
}
