/**
 * /limpiar (alias /limpiarchat): borra los mensajes de este chat de las últimas 48 horas.
 *
 * Telegram no deja que un bot borre todo el historial: solo puede borrar, uno por uno, los mensajes de menos de 48 h y necesita su
 * message_id. Por eso mensajesChat.js registra el id de cada mensaje que el bot envía y de cada mensaje que recibe. Esto NO toca archivos
 * de storage ni datos de la base (los PDF y comprobantes siguen guardados): solo mensajes del chat.
 *
 *   /limpiar                       cuenta lo que puede borrar y pide confirmación (Limpiar / Cancelar)
 *   /limpiar todo menos lo último  igual, pero deja los 5 mensajes más recientes
 *
 * Botones: lpc_<clave> limpiar · lpx_<clave> cancelar.
 */

import { describirError } from './errores.js';
import {
  listarBorrables, olvidarMensajes, elegirMensajes
} from './mensajesChat.js';

const VIDA_PREGUNTA_MS = 5 * 60 * 1000;
// El aviso final se borra solo a los 30 s
const VIDA_AVISO_MS = 30 * 1000;
const CONSERVAR_ULTIMOS = 5;
const SIMULTANEOS = 5;

export const esPeticionConservar = (arg) => /^todo\s+menos\s+lo\s+[uú]ltimo$/i.test(String(arg ?? '').trim());

export function crearLimpiar(ctx) {
  const { bot, enviar, editar, responderCallback, esChatAutorizado } = ctx;
  const esperar = ctx.esperar ?? ((ms) => new Promise(r => setTimeout(r, ms)));
  // clave -> { chatId, conservar, excluir: [ids], hasta }
  const pendientes = new Map();
  let contador = 0;
  const enCurso = new Set();

  /** Borra un mensaje. true si se borró; false si ya no existía o ya no se puede (más de 48 h). Reintenta una vez si Telegram pide esperar. */
  async function borrar(chatId, messageId) {
    for (let intento = 0; intento < 2; intento++) {
      try {
        await bot.deleteMessage(chatId, messageId);
        return true;
      } catch (err) {
        const body = err?.response?.body;
        const espera = Number(body?.parameters?.retry_after);
        if (body?.error_code === 429 && espera > 0 && intento === 0) {
          await esperar(Math.min(espera, 10) * 1000);
          continue;
        }
        return false;
      }
    }
    return false;
  }

  /** Borra con unos pocos a la vez. Devuelve cuántos se borraron. */
  async function borrarVarios(chatId, ids) {
    let borrados = 0;
    let siguiente = 0;
    const trabajador = async () => {
      while (siguiente < ids.length) {
        const id = ids[siguiente++];
        if (await borrar(chatId, id)) borrados++;
      }
    };
    await Promise.all(Array.from({ length: Math.min(SIMULTANEOS, ids.length) }, trabajador));
    return borrados;
  }

  async function pedir(msg, conservar) {
    const chatId = msg.chat.id;
    const borrables = await listarBorrables(chatId);
    const clave = `${chatId}_${Date.now()}_${contador++}`;
    const { borrar: ids } = elegirMensajes(borrables, { conservar, excluir: [msg.message_id] });
    const texto =
      `Puedo borrar <b>${ids.length}</b> ${ids.length === 1 ? 'mensaje' : 'mensajes'} de este chat (los de las últimas 48 h)` +
      `${conservar > 0 ? `, dejando los últimos ${conservar}` : ''}.\n\n` +
      'Telegram no deja borrar los más antiguos: esos hay que borrarlos desde Telegram con «Borrar historial». ' +
      'No toco tus archivos ni tus datos: los PDF y comprobantes siguen guardados.';
    const enviado = await enviar(chatId, texto, {
      reply_markup: {
        inline_keyboard: [[
          { text: 'Limpiar', callback_data: `lpc_${clave}` },
          { text: 'Cancelar', callback_data: `lpx_${clave}` }
        ]]
      }
    });
    pendientes.set(clave, { chatId, conservar, excluir: [msg.message_id, enviado?.message_id].filter(Boolean), hasta: Date.now() + VIDA_PREGUNTA_MS });
    setTimeout(() => pendientes.delete(clave), VIDA_PREGUNTA_MS).unref?.();
  }

  async function limpiar(cb, chatId, clave) {
    const p = pendientes.get(clave);
    if (!p || p.chatId !== chatId || Date.now() > p.hasta) {
      await responderCallback(cb.id, { text: 'Este botón ya expiró' });
      return;
    }
    if (enCurso.has(chatId)) {
      await responderCallback(cb.id, { text: 'Ya estoy limpiando' });
      return;
    }
    enCurso.add(chatId);
    pendientes.delete(clave);
    try {
      await responderCallback(cb.id, { text: 'Limpiando...' });
      // Se vuelve a calcular: lo que se borra es lo que hay ahora
      const borrables = await listarBorrables(chatId);
      const { borrar: ids } = elegirMensajes(borrables, { conservar: p.conservar, excluir: p.excluir });
      const borrados = await borrarVarios(chatId, ids);
      // Existan o no ya en Telegram, dejan de registrarse
      await olvidarMensajes(chatId, ids);

      const aviso = await enviar(chatId,
        `Borré ${borrados} ${borrados === 1 ? 'mensaje' : 'mensajes'}. ` +
        'Los de más de 48 h hay que borrarlos desde Telegram con Borrar historial.'
      );
      // Este aviso se borra solo a los 30 s
      if (aviso?.message_id) {
        setTimeout(() => {
          borrar(chatId, aviso.message_id).then(() => olvidarMensajes(chatId, [aviso.message_id])).catch(() => {});
        }, VIDA_AVISO_MS).unref?.();
      }
    } catch (error) {
      await enviar(chatId, describirError(error, 'borrar', 'los mensajes del chat').usuario);
    } finally {
      enCurso.delete(chatId);
    }
  }

  async function manejarCallback(cb, chatId, data) {
    const m = /^lp([cx])_(.+)$/.exec(data);
    if (!m) return false;
    if (!esChatAutorizado(chatId)) {
      await responderCallback(cb.id, { text: 'No autorizado' });
      return true;
    }
    if (m[1] === 'x') {
      pendientes.delete(m[2]);
      await responderCallback(cb.id, { text: 'Cancelado' });
      await editar('Cancelado: no borré nada.', { chat_id: chatId, message_id: cb.message.message_id });
      return true;
    }
    await limpiar(cb, chatId, m[2]);
    return true;
  }

  function configurarComandos() {
    // "/limpiarcuenta" (alias de /resetcuenta) no coincide: tras "limpiar" solo puede venir @bot, un espacio o el fin
    bot.onText(/^\/(?:limpiar|limpiarchat)(?:@\w+)?(?:\s+(.+))?$/i, async (msg, match) => {
      const chatId = msg.chat.id;
      if (!esChatAutorizado(chatId)) {
        await enviar(chatId, 'No estás autorizado para usar este bot.');
        return;
      }
      const arg = (match[1] ?? '').trim();
      if (arg && !esPeticionConservar(arg)) {
        await enviar(chatId, 'Usa /limpiar solo, o /limpiar todo menos lo último para dejar los 5 mensajes más recientes.');
        return;
      }
      try {
        await pedir(msg, arg ? CONSERVAR_ULTIMOS : 0);
      } catch (error) {
        await enviar(chatId, describirError(error, 'consultar', 'los mensajes del chat').usuario);
      }
    });
  }

  return { configurarComandos, manejarCallback };
}
