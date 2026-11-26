/**
 * Botones con tiempo límite ("Deshacer (10 min)"): al vencer, el bot los quita solo.
 *
 *   registrar({ chatId, messageId, venceEn, texto, aviso, acciones, permanentes })
 *       Programa el vencimiento de los botones de un mensaje que ya se envió. `texto` es el texto (HTML) del mensaje, `aviso` la línea
 *       que se le agrega al vencer ("Deshacer ya no está disponible."), `acciones` los callback_data que vencen y `permanentes` las filas
 *       de botones que se quedan (por defecto ninguna). Se guarda en la BD (botones_temporales) para sobrevivir a un reinicio.
 *   cancelar(chatId, messageId)       Cancela el temporizador (por ejemplo, cuando ya se usó el botón).
 *   alTocar(cb)                       Se llama al recibir un botón: si es uno de los que vencen, cancela su temporizador.
 *   quitarTeclado(chatId, messageId)  Quita el teclado de un mensaje (un botón vencido que alguien toca).
 *   restaurar()                       Al iniciar el bot: quita los vencidos y reprograma los pendientes.
 *
 * Si el mensaje ya se editó o se borró, el error de Telegram ("message is not modified", "message to edit not found") se ignora sin
 * avisar al usuario.
 */

const IGNORABLES = /message is not modified|message to edit not found|message can't be edited|MESSAGE_ID_INVALID|chat not found|bot was blocked/i;
// Un temporizador de JavaScript no admite más de ~24 días
const MAX_TIMEOUT_MS = 2 ** 31 - 1;

export function crearBotonesTemporales({ bot, consulta = async () => (await import('../db.js')).query, log = console.error } = {}) {
  // `${chatId}:${messageId}` -> { entrada, timer }
  const activos = new Map();
  const clave = (chatId, messageId) => `${chatId}:${messageId}`;

  // Las escrituras a la BD van en orden (un cancelar nunca se adelanta al guardar del mismo botón)
  let cadena = Promise.resolve();
  const enOrden = (tarea) => { cadena = cadena.then(tarea, tarea); return cadena; };

  const descripcionError = (err) => String(err?.response?.body?.description ?? err?.message ?? '');

  function guardar(e) {
    return enOrden(async () => {
    try {
      const query = await consulta();
      await query('DELETE FROM botones_temporales WHERE chat_id = ? AND message_id = ?', [e.chatId, e.messageId]);
      await query(
        'INSERT INTO botones_temporales (chat_id, message_id, vence_en, texto, aviso, acciones, permanentes) VALUES (?, ?, ?, ?, ?, ?, ?)',
        [e.chatId, e.messageId, e.venceEn, e.texto ?? null, e.aviso, JSON.stringify(e.acciones ?? []), JSON.stringify(e.permanentes ?? [])]
      );
    } catch (error) {
      // Sin persistencia sigue funcionando el temporizador en memoria
      log(`[botones] no pude guardar el vencimiento de un botón: ${error.code ?? error.name}`);
    }
    });
  }

  function olvidar(chatId, messageId) {
    return enOrden(async () => {
    try {
      const query = await consulta();
      await query('DELETE FROM botones_temporales WHERE chat_id = ? AND message_id = ?', [chatId, messageId]);
    } catch (error) {
      log(`[botones] no pude borrar el vencimiento de un botón: ${error.code ?? error.name}`);
    }
    });
  }

  /** Quita el teclado de un mensaje; ignora que ya no exista o que ya esté sin teclado */
  async function quitarTeclado(chatId, messageId, permanentes = []) {
    try {
      await bot.editMessageReplyMarkup({ inline_keyboard: permanentes }, { chat_id: chatId, message_id: messageId });
      return true;
    } catch (err) {
      if (!IGNORABLES.test(descripcionError(err))) log(`[botones] no pude quitar un teclado: ${descripcionError(err).slice(0, 120)}`);
      return false;
    }
  }

  /** Vence: deja solo los botones permanentes y agrega el aviso al texto */
  async function expirar(e) {
    activos.delete(clave(e.chatId, e.messageId));
    await olvidar(e.chatId, e.messageId);
    const aviso = `<i>${e.aviso}</i>`;
    if (e.texto) {
      try {
        await bot.editMessageText(`${e.texto}\n\n${aviso}`, {
          chat_id: e.chatId,
          message_id: e.messageId,
          parse_mode: 'HTML',
          reply_markup: { inline_keyboard: e.permanentes ?? [] }
        });
        return;
      } catch (err) {
        const motivo = descripcionError(err);
        // El mensaje ya cambió o ya no existe: no hay nada más que hacer, y no se le avisa a nadie
        if (IGNORABLES.test(motivo)) return;
        log(`[botones] no pude actualizar el texto de un mensaje vencido: ${motivo.slice(0, 120)}`);
      }
    }
    // Plan B: al menos quitar los botones
    await quitarTeclado(e.chatId, e.messageId, e.permanentes ?? []);
  }

  function programar(e) {
    const k = clave(e.chatId, e.messageId);
    clearTimeout(activos.get(k)?.timer);
    const espera = Math.max(0, Math.min(MAX_TIMEOUT_MS, e.venceEn - Date.now()));
    const timer = setTimeout(() => {
      // Si faltaba más que el máximo de un temporizador, se vuelve a programar
      if (e.venceEn - Date.now() > 1000) return programar(e);
      expirar(e).catch(() => {});
    }, espera);
    timer.unref?.();
    activos.set(k, { entrada: e, timer });
  }

  function registrar({ chatId, messageId, venceEn, texto = null, aviso, acciones = [], permanentes = [] }) {
    if (!chatId || !messageId || !venceEn || !aviso) return false;
    const e = { chatId: Number(chatId), messageId: Number(messageId), venceEn: Number(venceEn), texto, aviso, acciones, permanentes };
    programar(e);
    guardar(e).catch(() => {});
    return true;
  }

  function cancelar(chatId, messageId) {
    const k = clave(chatId, messageId);
    const activo = activos.get(k);
    if (!activo) return false;
    clearTimeout(activo.timer);
    activos.delete(k);
    olvidar(Number(chatId), Number(messageId)).catch(() => {});
    return true;
  }

  /** Un botón que vence se usó: se cancela su temporizador (el módulo que lo atiende ya se encarga de editar el mensaje) */
  function alTocar(cb) {
    const m = cb?.message;
    if (!m) return false;
    const activo = activos.get(clave(m.chat.id, m.message_id));
    if (!activo || !(activo.entrada.acciones ?? []).includes(cb.data)) return false;
    return cancelar(m.chat.id, m.message_id);
  }

  /** Al iniciar el bot: los vencidos pierden su teclado ahora y los pendientes se reprograman */
  async function restaurar() {
    try {
      const query = await consulta();
      const [filas] = await query('SELECT chat_id, message_id, vence_en, texto, aviso, acciones, permanentes FROM botones_temporales');
      let vencidos = 0;
      let pendientes = 0;
      for (const f of filas) {
        const e = {
          chatId: Number(f.chat_id),
          messageId: Number(f.message_id),
          venceEn: Number(f.vence_en),
          texto: f.texto ?? null,
          aviso: f.aviso,
          acciones: JSON.parse(f.acciones || '[]'),
          permanentes: JSON.parse(f.permanentes || '[]')
        };
        if (e.venceEn <= Date.now()) {
          vencidos++;
          await expirar(e);
        } else {
          pendientes++;
          programar(e);
        }
      }
      if (vencidos + pendientes > 0) console.log(`✓ Botones con vencimiento: ${vencidos} vencidos limpiados, ${pendientes} reprogramados`);
    } catch (error) {
      log(`[botones] no pude restaurar los vencimientos: ${error.code ?? error.name}`);
    }
  }

  return { registrar, cancelar, alTocar, quitarTeclado, restaurar };
}
