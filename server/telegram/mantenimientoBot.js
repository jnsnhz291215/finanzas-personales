/**
 * /mantenimiento: tareas fijas de mantenimiento sin abrir una terminal.
 *
 * Seguridad: NO ejecuta comandos libres ni texto del usuario como shell. Solo existe una lista cerrada de tareas definida aquí en el código
 * (TAREAS); cada una es una función de este proceso (nunca `shell: true`). El botón lleva solo el identificador de la tarea, que se busca en
 * la lista; cualquier otro valor se rechaza. Solo los chats autorizados (los mismos que /update) pueden usarlo, y cada ejecución deja en el
 * log quién la pidió y qué tarea fue.
 *
 * Para agregar una tarea: sumar una entrada a TAREAS con { id, etiqueta, descripcion, confirmar, ejecutar }. `confirmar: true` pide una
 * segunda confirmación antes de ejecutarla (toda tarea que cambia datos debe llevarla). `ejecutar(ctx)` devuelve las líneas (texto plano,
 * sin datos sensibles) con el resultado en números.
 *
 * Botones (prefijo mt): mtl_x lista · mtt_<id> elegir tarea · mty_<id> confirmar · mtx_x cancelar.
 */

import { describirError } from './errores.js';

/** Lista cerrada de tareas permitidas */
export const TAREAS = [
  {
    id: 'fechas_contar',
    etiqueta: 'Reparar fechas (solo contar)',
    descripcion: 'Cuenta cuántos registros con fecha inválida habría que reparar. No cambia nada.',
    confirmar: false,
    async ejecutar() {
      const { repararFechas } = await import('../repararFechas.js');
      return lineasDeFechas(await repararFechas({ aplicar: false }), false);
    }
  },
  {
    id: 'fechas_aplicar',
    etiqueta: 'Reparar fechas (aplicar)',
    descripcion: 'Repara las fechas con año inválido (períodos de cartolas, movimientos, cargos leídos y compras en cuotas), en una transacción.',
    confirmar: true,
    async ejecutar() {
      const { repararFechas } = await import('../repararFechas.js');
      return lineasDeFechas(await repararFechas({ aplicar: true }), true);
    }
  }
  // Próximas tareas fijas: simular migrar-storage, estado de pm2 del proceso, últimas líneas del log propio sin secretos...
];

export const tareaPorId = (id) => TAREAS.find(t => t.id === id) ?? null;

/** Resultado de repararFechas en líneas con números (nada sensible) */
export function lineasDeFechas(r, aplicado) {
  const verbo = aplicado ? 'reparados' : 'por reparar';
  return [
    `Períodos de cartolas ${verbo}: ${r.archivos}`,
    `Movimientos ${verbo}: ${r.movimientos}`,
    `Cargos leídos ${verbo}: ${r.cargos}`,
    `Compras en cuotas ${verbo}: ${r.compras}`,
    `Sin poder corregir: ${r.movimientosSinCorregir} movimientos y ${r.cargosSinCorregir} cargos leídos`
  ];
}

export function crearMantenimiento(ctx) {
  const { bot, enviar, editar, responderCallback, esc, esChatAutorizado } = ctx;
  const registro = ctx.log ?? console.log;
  let enProceso = false;

  const quien = (chatId) => `chat ${chatId}`;

  async function mostrarLista(chatId, messageId = null) {
    const texto = '<b>Mantenimiento</b>\nElige una tarea. Solo hay tareas fijas; no se ejecuta nada más.\n\n' +
      TAREAS.map(t => `<b>${esc(t.etiqueta)}</b>: ${esc(t.descripcion)}`).join('\n');
    const opciones = {
      reply_markup: {
        inline_keyboard: [
          ...TAREAS.map(t => [{ text: t.etiqueta, callback_data: `mtt_${t.id}` }]),
          [{ text: 'Cerrar', callback_data: 'mtx_x' }]
        ]
      }
    };
    if (messageId) {
      const editado = await editar(texto, { chat_id: chatId, message_id: messageId, ...opciones });
      if (editado) return;
    }
    await enviar(chatId, texto, opciones);
  }

  async function ejecutar(chatId, messageId, tarea) {
    if (enProceso) {
      await editar('Ya hay una tarea de mantenimiento en curso. Espera a que termine.', { chat_id: chatId, message_id: messageId });
      return;
    }
    enProceso = true;
    registro(`[mantenimiento] ${quien(chatId)} ejecuta la tarea "${tarea.id}"`);
    try {
      await editar(`Ejecutando: ${esc(tarea.etiqueta)}...`, { chat_id: chatId, message_id: messageId });
      const lineas = await tarea.ejecutar({ chatId });
      registro(`[mantenimiento] ${quien(chatId)} terminó la tarea "${tarea.id}"`);
      await editar(
        `<b>${esc(tarea.etiqueta)}</b>\n\n${lineas.map(l => esc(l)).join('\n')}`,
        {
          chat_id: chatId,
          message_id: messageId,
          reply_markup: { inline_keyboard: [[{ text: 'Otra tarea', callback_data: 'mtl_x' }, { text: 'Cerrar', callback_data: 'mtx_x' }]] }
        }
      );
    } catch (error) {
      registro(`[mantenimiento] ${quien(chatId)}: la tarea "${tarea.id}" falló`);
      await editar(describirError(error, 'mantenimiento', `la tarea «${tarea.etiqueta}»`).usuario, { chat_id: chatId, message_id: messageId });
    } finally {
      enProceso = false;
    }
  }

  async function manejarCallback(cb, chatId, data) {
    const m = /^mt([ltyx])_(.+)$/.exec(data);
    if (!m) return false;
    const messageId = cb.message.message_id;
    if (!esChatAutorizado(chatId)) {
      await responderCallback(cb.id, { text: 'No autorizado' });
      return true;
    }
    const [, tipo, valor] = m;

    if (tipo === 'x') {
      await responderCallback(cb.id, {});
      await editar('Listo.', { chat_id: chatId, message_id: messageId });
      return true;
    }
    if (tipo === 'l') {
      await responderCallback(cb.id, {});
      await mostrarLista(chatId, messageId);
      return true;
    }

    // Elegir o confirmar: el identificador se busca en la lista cerrada; cualquier otro valor se rechaza
    const tarea = tareaPorId(valor);
    if (!tarea) {
      await responderCallback(cb.id, { text: 'Tarea no válida' });
      return true;
    }
    await responderCallback(cb.id, {});

    if (tipo === 't' && tarea.confirmar) {
      await editar(
        `<b>${esc(tarea.etiqueta)}</b>\n\n${esc(tarea.descripcion)}\n\nEsto cambia datos. ¿La ejecuto?`,
        {
          chat_id: chatId,
          message_id: messageId,
          reply_markup: { inline_keyboard: [[{ text: 'Sí, ejecutar', callback_data: `mty_${tarea.id}` }, { text: 'Cancelar', callback_data: 'mtl_x' }]] }
        }
      );
      return true;
    }
    // Una tarea que pide confirmación solo se ejecuta desde el botón de confirmar
    if (tipo === 'y' && !tarea.confirmar) return true;
    await ejecutar(chatId, messageId, tarea);
    return true;
  }

  function configurarComandos() {
    bot.onText(/^\/mantenimiento(?:@\w+)?\s*$/i, async (msg) => {
      const chatId = msg.chat.id;
      if (!esChatAutorizado(chatId)) {
        await enviar(chatId, 'No estás autorizado para usar este bot.');
        return;
      }
      registro(`[mantenimiento] ${quien(chatId)} abre /mantenimiento`);
      await mostrarLista(chatId);
    });
  }

  return { configurarComandos, manejarCallback };
}
