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

import { botonCerrar } from './cerrar.js';
import { describirError } from './errores.js';
import { ultimasLineasDeError } from './bufferErrores.js';

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
  },
  {
    id: 'gemini_probar',
    etiqueta: 'Probar Gemini',
    descripcion: 'Una llamada mínima con texto fijo («Responde OK», sin datos tuyos) a cada modelo configurado. Dice si la clave existe (solo su largo), el modelo, el tiempo y, si falla, el código HTTP y el status de Google.',
    confirmar: false,
    async ejecutar() {
      const { diagnosticarGemini, modelosParaProbar } = await import('./gemini.js');
      return lineasDeGemini(await diagnosticarGemini(), modelosParaProbar());
    }
  },
  {
    id: 'errores_ver',
    etiqueta: 'Últimos errores del bot',
    descripcion: 'Las últimas 30 líneas de error del proceso (log de PM2 o memoria), sin tokens, keys, URLs, RUT ni números largos.',
    confirmar: false,
    async ejecutar() {
      const { origen, lineas } = await ultimasLineasDeError(30);
      if (lineas.length === 0) return [`Sin errores registrados (fuente: ${origen}).`];
      // Telegram admite ~4.000 caracteres: se muestran las más recientes que quepan
      const salida = [];
      let largo = 0;
      for (const l of [...lineas].reverse()) {
        if (largo + l.length + 1 > 3000) break;
        salida.unshift(l);
        largo += l.length + 1;
      }
      return [`Fuente: ${origen}. Últimas ${salida.length} líneas:`, '', ...salida];
    }
  }
  // Próximas tareas fijas: simular migrar-storage, estado de pm2 del proceso, últimas líneas del log propio sin secretos...
];

export const tareaPorId = (id) => TAREAS.find(t => t.id === id) ?? null;

/**
 * Resultado de diagnosticarGemini en líneas. De la clave solo se dice si existe y cuántos caracteres tiene; nunca su valor ni partes de él.
 * Un error se traduce con describirError (paso "gemini") y se muestra con su código HTTP y el status de Google.
 */
export function lineasDeGemini(informe, modelos) {
  const lineas = [
    informe.claveDefinida
      ? `Clave GEMINI_API_KEY: definida (${informe.largoClave} caracteres)`
      : 'Clave GEMINI_API_KEY: NO está definida (el bot usa solo las reglas locales)',
    `GEMINI_MODEL: ${informe.modeloConfigurado ? 'definida' : 'no definida (se usa el modelo por defecto)'}`,
    `Modelos a probar: ${modelos.join(', ')}`
  ];
  if (!informe.claveDefinida) return lineas;
  lineas.push('');
  for (const r of informe.resultados) {
    if (r.ok) {
      lineas.push(`${r.modelo}: respondió OK en ${r.ms} ms`);
      continue;
    }
    const d = describirError(r.error, 'gemini', r.modelo);
    const http = r.error?.http ? `HTTP ${r.error.http}` : 'sin respuesta HTTP';
    const estado = r.error?.estado ? ` ${r.error.estado}` : '';
    lineas.push(`${r.modelo}: FALLÓ en ${r.ms} ms (${http}${estado}): ${d.causa}`);
  }
  const buenos = informe.resultados.filter(r => r.ok).length;
  lineas.push('', buenos === 0
    ? 'Ningún modelo respondió: el bot sigue funcionando solo con las reglas locales.'
    : `${buenos} de ${informe.resultados.length} modelos respondieron.`);
  return lineas;
}

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
          botonCerrar()
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
          reply_markup: { inline_keyboard: [[{ text: 'Otra tarea', callback_data: 'mtl_x' }, ...botonCerrar()]] }
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
