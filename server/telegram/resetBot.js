/**
 * Reinicio total de los datos desde el bot (/reset o "empezar de cero") y restauración del último
 * respaldo ("restaurar último respaldo"). Muy protegido contra errores:
 *
 *  1. Muestra lo que se va a borrar, con conteos, y pide elegir con botones.
 *  2. Pide escribir una frase exacta (BORRAR TODO, BORRAR MOVIMIENTOS o RESTAURAR RESPALDO) en 2
 *     minutos; cualquier otra cosa cancela.
 *  3. Hace un respaldo antes de tocar nada (si falla, no se borra) y borra en una transacción.
 *
 * Solo para los chats autorizados. El comando no está en el menú "/" de Telegram. La lógica de
 * datos está en server/reset.js.
 */

import {
  contarDatos,
  lineasConteos,
  ejecutarReset,
  ultimoRespaldo,
  restaurarRespaldo,
  fraseDe,
  fraseCorrecta
} from '../reset.js';

const ESPERA_BOTONES_MS = 5 * 60 * 1000;
const ESPERA_FRASE_MS = 2 * 60 * 1000;

export function crearReset(ctx) {
  const { bot, enviar, editar, responderCallback, esc, esChatAutorizado } = ctx;

  // Botones sin responder: clave -> { accion }
  const pendientes = new Map();
  // Frase esperada: chatId -> { accion, hasta, respaldo }
  const esperandoFrase = new Map();
  let enProceso = false;
  let contador = 0;

  const nuevaClave = (chatId) => `${chatId}_${Date.now()}_${contador++}`;

  function guardarPendiente(chatId, datos) {
    const key = nuevaClave(chatId);
    pendientes.set(key, datos);
    setTimeout(() => pendientes.delete(key), ESPERA_BOTONES_MS);
    return key;
  }

  // -------------------------------------------------------------------------
  // Paso 1: qué se va a borrar
  // -------------------------------------------------------------------------

  async function pedirReset(chatId) {
    if (!esChatAutorizado(chatId)) {
      await enviar(chatId, 'No estás autorizado para usar este bot.');
      return true;
    }
    try {
      const conteos = await contarDatos();
      const key = guardarPendiente(chatId, { tipo: 'reset' });
      await enviar(chatId,
        '<b>Reiniciar los datos</b>\n\n' +
        'Esto es lo que tienes ahora:\n' +
        lineasConteos(conteos).map(l => esc(l)).join('\n') +
        '\n\n<b>Borrar movimientos y archivos:</b> borra movimientos, pagos de préstamos, importaciones de cartolas y los archivos ' +
        'de storage. Mantiene cuentas, datos de transferencia, plan de ahorro, cuotas y categorías.\n' +
        '<b>Borrar todo:</b> además borra cuentas, cuotas, plan, gastos fijos, datos de transferencia, reglas y categorías, y vuelve a ' +
        'crear las categorías base y la cuenta Efectivo.\n\n' +
        'Antes de borrar hago un respaldo automático en storage/respaldos/ que el reset no borra.',
        {
          reply_markup: {
            inline_keyboard: [
              [{ text: 'Borrar movimientos y archivos', callback_data: `rsm_${key}` }],
              [{ text: 'Borrar todo', callback_data: `rst_${key}` }],
              [{ text: 'Cancelar', callback_data: `rsx_${key}` }]
            ]
          }
        }
      );
    } catch (error) {
      console.error('[reset] error al contar los datos:', error.code ?? error.name);
      await enviar(chatId, 'No pude leer los datos. No cambié nada.');
    }
    return true;
  }

  async function pedirRestaurar(chatId) {
    if (!esChatAutorizado(chatId)) {
      await enviar(chatId, 'No estás autorizado para usar este bot.');
      return true;
    }
    try {
      const respaldo = await ultimoRespaldo();
      if (!respaldo) {
        await enviar(chatId, 'No hay respaldos de un reset para restaurar.');
        return true;
      }
      const key = guardarPendiente(chatId, { tipo: 'restaurar', nombre: respaldo.nombre });
      await enviar(chatId,
        '<b>Restaurar el último respaldo</b>\n\n' +
        `Respaldo: ${esc(respaldo.ruta)}\n` +
        `Incluye: base de datos${respaldo.conArchivos ? ' y archivos' : ''}.\n\n` +
        'Reemplaza los datos actuales por los del respaldo. Antes hago otro respaldo del estado de ahora, por si te arrepientes.',
        {
          reply_markup: {
            inline_keyboard: [[
              { text: 'Restaurar', callback_data: `rsr_${key}` },
              { text: 'Cancelar', callback_data: `rsx_${key}` }
            ]]
          }
        }
      );
    } catch (error) {
      console.error('[reset] error al buscar el respaldo:', error.code ?? error.name);
      await enviar(chatId, 'No pude buscar el respaldo. No cambié nada.');
    }
    return true;
  }

  // -------------------------------------------------------------------------
  // Paso 2: la frase exacta
  // -------------------------------------------------------------------------

  async function pedirFrase(cb, chatId, accion, extra = {}) {
    const messageId = cb.message.message_id;
    esperandoFrase.set(chatId, { accion, hasta: Date.now() + ESPERA_FRASE_MS, ...extra });
    await editar(
      `Para confirmar, escribe exactamente <code>${esc(fraseDe(accion))}</code> en los próximos 2 minutos.\n` +
      'Cualquier otra cosa cancela.',
      { chat_id: chatId, message_id: messageId }
    );
    await responderCallback(cb.id, {});
  }

  /**
   * Mientras se espera la frase, el siguiente texto del chat la confirma o cancela. Devuelve true
   * si consumió el mensaje.
   */
  async function manejarTexto(msg) {
    const chatId = msg.chat.id;
    const espera = esperandoFrase.get(chatId);
    if (!espera || typeof msg.text !== 'string') return false;
    esperandoFrase.delete(chatId);

    if (Date.now() > espera.hasta) {
      await enviar(chatId, 'Pasaron más de 2 minutos: cancelé la acción. No cambié nada.');
      return false;
    }
    if (!fraseCorrecta(msg.text, espera.accion)) {
      await enviar(chatId, 'No escribiste la frase exacta: cancelé la acción. No cambié nada.');
      return true;
    }

    if (espera.accion === 'restaurar') await ejecutarRestauracion(chatId, espera.nombre);
    else await ejecutarBorrado(chatId, espera.accion);
    return true;
  }

  // -------------------------------------------------------------------------
  // Paso 3: respaldo y borrado
  // -------------------------------------------------------------------------

  async function ejecutarBorrado(chatId, accion) {
    if (enProceso) {
      await enviar(chatId, 'Ya hay un reset o una restauración en curso.');
      return;
    }
    enProceso = true;
    try {
      await enviar(chatId, 'Haciendo el respaldo y borrando...');
      const r = await ejecutarReset(accion === 'todo' ? 'todo' : 'movimientos', chatId);

      const lineas = accion === 'todo'
        ? lineasConteos(r.antes)
        : [`Movimientos: ${r.antes.movimientos}`];
      await enviar(chatId,
        '<b>Reset terminado</b>\n\n' +
        `Borré:\n${lineas.map(l => esc(l)).join('\n')}\n` +
        `Archivos borrados: ${r.archivosBorrados}\n` +
        (accion === 'todo' ? '\nDejé las categorías base y la cuenta Efectivo.\n' : '') +
        `\nRespaldo: ${esc(r.respaldo.ruta)} (dentro de storage)\n` +
        'Para volver atrás escribe «restaurar último respaldo».'
      );
    } catch (error) {
      console.error('[reset] error:', error.codigo ?? error.code ?? error.name);
      await enviar(chatId, error.message === 'no se pudo crear el respaldo'
        ? 'No pude hacer el respaldo, así que no borré nada.'
        : 'Ocurrió un error durante el borrado. La base de datos se deshizo a como estaba; revisa el servidor y el respaldo en storage/respaldos/.'
      );
    } finally {
      enProceso = false;
    }
  }

  async function ejecutarRestauracion(chatId, nombre) {
    if (enProceso) {
      await enviar(chatId, 'Ya hay un reset o una restauración en curso.');
      return;
    }
    enProceso = true;
    try {
      const respaldo = await ultimoRespaldo();
      if (!respaldo || respaldo.nombre !== nombre) {
        await enviar(chatId, 'El respaldo cambió o ya no existe. No restauré nada.');
        return;
      }
      await enviar(chatId, 'Restaurando...');
      const r = await restaurarRespaldo(respaldo, chatId);
      await enviar(chatId,
        '<b>Restauración terminada</b>\n\n' +
        `Volví a ${esc(respaldo.ruta)}.\n` +
        `El estado anterior quedó respaldado en ${esc(r.respaldoPrevio.ruta)}.`
      );
    } catch (error) {
      console.error('[reset] error al restaurar:', error.codigo ?? error.code ?? error.name);
      await enviar(chatId, 'No pude restaurar el respaldo. Revisa el servidor; los respaldos siguen en storage/respaldos/.');
    } finally {
      enProceso = false;
    }
  }

  // -------------------------------------------------------------------------
  // Comandos y botones
  // -------------------------------------------------------------------------

  function configurarComandos() {
    bot.onText(/^\/reset(?:@\w+)?\s*$/i, async (msg) => {
      await pedirReset(msg.chat.id);
    });
  }

  /** Botones de este módulo. Devuelve true si el callback era suyo. */
  async function manejarCallback(cb, chatId, data) {
    const m = data.match(/^rs([mtrx])_(.+)$/);
    if (!m) return false;
    const messageId = cb.message.message_id;
    const pendiente = pendientes.get(m[2]);

    if (m[1] === 'x') {
      pendientes.delete(m[2]);
      esperandoFrase.delete(chatId);
      await editar('Cancelado. No cambié nada.', { chat_id: chatId, message_id: messageId });
      await responderCallback(cb.id, { text: 'Cancelado' });
      return true;
    }

    if (!pendiente) {
      await responderCallback(cb.id, { text: 'Solicitud expirada' });
      return true;
    }
    pendientes.delete(m[2]);

    if (m[1] === 'm' && pendiente.tipo === 'reset') await pedirFrase(cb, chatId, 'movimientos');
    else if (m[1] === 't' && pendiente.tipo === 'reset') await pedirFrase(cb, chatId, 'todo');
    else if (m[1] === 'r' && pendiente.tipo === 'restaurar') await pedirFrase(cb, chatId, 'restaurar', { nombre: pendiente.nombre });
    else await responderCallback(cb.id, { text: 'Solicitud no válida' });
    return true;
  }

  return { configurarComandos, manejarCallback, manejarTexto, pedirReset, pedirRestaurar };
}
