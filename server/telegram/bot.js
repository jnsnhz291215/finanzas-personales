import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const TelegramBot = require('node-telegram-bot-api');

import { query } from '../db.js';
import { parsearMensaje, parsearMontoExacto, MEDIOS_PAGO_NOMBRES } from './parser.js';
import { interpretarMovimiento, geminiDisponible } from './gemini.js';
import { fechaHoySantiago, formatearFechaCL } from './fechas.js';
import {
  TIPOS_MOVIMIENTO,
  ETIQUETAS_TIPO,
  requiereDestino,
  resolverTipos,
  sqlExcluirInternos
} from '../tiposMovimiento.js';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs/promises';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

let bot = null;
let allowedChatIds = [];
let isRunning = false;

// Estado temporal para confirmaciones
const pendingTransactions = new Map();

// Códigos cortos de tipo para callback_data (Telegram limita a 64 bytes)
const CODIGOS_TIPO = {
  compra: 'cp',
  pago_tarjeta: 'pt',
  transferencia_propia: 'tp',
  transferencia_terceros: 'tt',
  ingreso: 'in',
  otro: 'ot'
};
const TIPO_POR_CODIGO = Object.fromEntries(Object.entries(CODIGOS_TIPO).map(([tipo, codigo]) => [codigo, tipo]));

/**
 * Escapa texto dinámico para parse_mode HTML de Telegram (&, < y >)
 */
function esc(texto) {
  return String(texto ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/**
 * Registra un error de Telegram mostrando solo error_code y description.
 * Nunca imprime el objeto completo: la respuesta incluye la URL con el token.
 */
function logErrorTelegram(contexto, err) {
  const body = err?.response?.body;
  const codigo = body?.error_code ?? err?.code ?? 'desconocido';
  let descripcion = body?.description ?? err?.message ?? 'sin descripción';
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (token) descripcion = String(descripcion).split(token).join('***');
  console.error(`[telegram] ${contexto}: error_code=${codigo} description=${descripcion}`);
}

/** sendMessage con HTML por defecto; nunca lanza */
async function enviar(chatId, texto, opts = {}) {
  try {
    return await bot.sendMessage(chatId, texto, { parse_mode: 'HTML', ...opts });
  } catch (err) {
    logErrorTelegram('sendMessage', err);
    return null;
  }
}

/** editMessageText con HTML por defecto; nunca lanza */
async function editar(texto, opts = {}) {
  try {
    return await bot.editMessageText(texto, { parse_mode: 'HTML', ...opts });
  } catch (err) {
    logErrorTelegram('editMessageText', err);
    return null;
  }
}

/** answerCallbackQuery; nunca lanza */
async function responderCallback(callbackId, opts = {}) {
  try {
    return await bot.answerCallbackQuery(callbackId, opts);
  } catch (err) {
    logErrorTelegram('answerCallbackQuery', err);
    return null;
  }
}

/**
 * Inicializa el bot de Telegram
 */
export async function iniciarBot() {
  const token = process.env.TELEGRAM_BOT_TOKEN;

  if (!token) {
    console.log('⚠ TELEGRAM_BOT_TOKEN no configurado - Bot de Telegram deshabilitado');
    console.log('  Configura TELEGRAM_BOT_TOKEN en .env para habilitar el bot');
    return;
  }

  // Parsear chat IDs permitidos
  const allowedIdsStr = process.env.TELEGRAM_ALLOWED_CHAT_IDS || '';
  allowedChatIds = allowedIdsStr
    .split(',')
    .map(id => id.trim())
    .filter(id => id.length > 0)
    .map(id => parseInt(id));

  try {
    // Usar long polling (no webhook)
    bot = new TelegramBot(token, {
      polling: true,
      filepath: false // Descargar archivos manualmente
    });

    isRunning = true;

    bot.on('polling_error', (err) => logErrorTelegram('polling_error', err));

    configurarComandos();
    configurarManejadores();

    console.log('✓ Bot de Telegram iniciado (long polling)');
    if (allowedChatIds.length > 0) {
      console.log(`  Chat IDs autorizados: ${allowedChatIds.join(', ')}`);
    } else {
      console.log('  ⚠ Sin chat IDs configurados - usa /miid para obtener tu chat ID');
    }
  } catch (error) {
    console.error('Error al iniciar bot de Telegram:', error.message);
    isRunning = false;
  }
}

/**
 * Detiene el bot
 */
export async function detenerBot() {
  if (bot && isRunning) {
    await bot.stopPolling();
    isRunning = false;
    console.log('✓ Bot de Telegram detenido');
  }
}

/**
 * Verifica si el chat está autorizado
 */
function esChatAutorizado(chatId) {
  // Si no hay IDs configurados, rechazar todos excepto /miid
  if (allowedChatIds.length === 0) {
    return false;
  }
  return allowedChatIds.includes(chatId);
}

/**
 * Configura los comandos del bot
 */
function configurarComandos() {
  // Comando /miid - disponible para todos (para obtener el chat ID)
  bot.onText(/\/miid/, async (msg) => {
    const chatId = msg.chat.id;
    await enviar(chatId, `Tu chat ID es: <code>${esc(chatId)}</code>\n\nAgrega este ID a TELEGRAM_ALLOWED_CHAT_IDS en tu archivo .env`);
  });

  // Comando /start
  bot.onText(/\/start/, async (msg) => {
    const chatId = msg.chat.id;

    if (!esChatAutorizado(chatId)) {
      await enviar(chatId, '❌ No estás autorizado para usar este bot.\n\nUsa /miid para obtener tu chat ID y configúralo en el servidor.');
      return;
    }

    await enviar(chatId,
      '¡Hola! 👋\n\n' +
      'Soy tu asistente de finanzas personales.\n\n' +
      'Puedes registrar gastos e ingresos escribiendo en lenguaje natural, por ejemplo:\n' +
      '• "ayer pagué 12.500 en el super con débito"\n' +
      '• "gasté 5 lucas en uber"\n' +
      '• "me pagaron 300.000 de sueldo"\n\n' +
      'También puedes enviar archivos de cartola (CSV, Excel, PDF) para importarlos.\n\n' +
      'Usa /ayuda para ver todos los comandos disponibles.'
    );
  });

  // Comando /ayuda
  bot.onText(/\/ayuda/, async (msg) => {
    const chatId = msg.chat.id;

    if (!esChatAutorizado(chatId)) {
      await enviar(chatId, '❌ No estás autorizado para usar este bot.');
      return;
    }

    await enviar(chatId,
      '📋 <b>Comandos disponibles:</b>\n\n' +
      '<b>Registro de movimientos:</b>\n' +
      'Escribe en lenguaje natural, por ejemplo:\n' +
      '• "ayer pagué 12.500 en el super con débito"\n' +
      '• "gasté 5 lucas en uber con la CMR"\n' +
      '• "me pagaron 300.000 de sueldo"\n\n' +
      '<b>Consultas:</b>\n' +
      '/resumen - Resumen del mes actual\n' +
      '/ultimos - Últimos 10 movimientos\n' +
      '/borrar_ultimo - Eliminar el último movimiento (con confirmación)\n\n' +
      '<b>Importar cartolas:</b>\n' +
      'Envía un archivo CSV, Excel o PDF de tu cartola bancaria.\n\n' +
      '<b>Otros:</b>\n' +
      '/ayuda - Mostrar esta ayuda\n' +
      '/miid - Obtener tu chat ID'
    );
  });

  // Comando /resumen
  bot.onText(/\/resumen/, async (msg) => {
    const chatId = msg.chat.id;

    if (!esChatAutorizado(chatId)) {
      await enviar(chatId, '❌ No estás autorizado para usar este bot.');
      return;
    }

    try {
      // Mes y año actuales en hora de Chile
      const [anio, mes] = fechaHoySantiago().split('-').map(Number);

      const [movimientos] = await query(
        `SELECT tipo, SUM(monto) as total
         FROM movimientos
         WHERE MONTH(fecha) = ? AND YEAR(fecha) = ?
           AND ${sqlExcluirInternos()}
         GROUP BY tipo`,
        [mes, anio]
      );

      let totalIngresos = 0;
      let totalGastos = 0;

      movimientos.forEach(m => {
        if (m.tipo === 'abono') totalIngresos = m.total;
        if (m.tipo === 'cargo') totalGastos = m.total;
      });

      const saldo = totalIngresos - totalGastos;
      const mesNombre = new Date(anio, mes - 1).toLocaleString('es-CL', { month: 'long' });

      await enviar(chatId,
        `📊 <b>Resumen de ${esc(mesNombre)} ${anio}</b>\n\n` +
        `💰 Ingresos: $${formatearMonto(totalIngresos)}\n` +
        `💸 Gastos: $${formatearMonto(totalGastos)}\n` +
        `━━━━━━━━━━━━━━\n` +
        `${saldo >= 0 ? '✅' : '❌'} Saldo: $${formatearMonto(saldo)}`
      );
    } catch (error) {
      console.error('Error al obtener resumen:', error);
      await enviar(chatId, '❌ Error al obtener el resumen.');
    }
  });

  // Comando /ultimos
  bot.onText(/\/ultimos/, async (msg) => {
    const chatId = msg.chat.id;

    if (!esChatAutorizado(chatId)) {
      await enviar(chatId, '❌ No estás autorizado para usar este bot.');
      return;
    }

    try {
      const [movimientos] = await query(
        `SELECT m.*, c.nombre as cuenta_nombre, cat.nombre as categoria_nombre
         FROM movimientos m
         LEFT JOIN cuentas c ON m.cuenta_id = c.id
         LEFT JOIN categorias cat ON m.categoria_id = cat.id
         ORDER BY m.fecha DESC, m.creado_en DESC
         LIMIT 10`
      );

      if (movimientos.length === 0) {
        await enviar(chatId, 'No hay movimientos registrados.');
        return;
      }

      let mensaje = '📝 <b>Últimos 10 movimientos:</b>\n\n';

      movimientos.forEach((m, i) => {
        const icono = m.tipo === 'cargo' ? '💸' : '💰';
        const fecha = formatearFechaCL(m.fecha);
        const categoria = esc(m.categoria_nombre || 'Sin categoría');
        mensaje += `${i + 1}. ${icono} $${formatearMonto(m.monto)} - ${esc(m.descripcion)}\n`;
        mensaje += `   📅 ${fecha} • ${categoria}\n\n`;
      });

      await enviar(chatId, mensaje);
    } catch (error) {
      console.error('Error al obtener últimos movimientos:', error);
      await enviar(chatId, '❌ Error al obtener los movimientos.');
    }
  });

  // Comando /borrar_ultimo
  bot.onText(/\/borrar_ultimo/, async (msg) => {
    const chatId = msg.chat.id;

    if (!esChatAutorizado(chatId)) {
      await enviar(chatId, '❌ No estás autorizado para usar este bot.');
      return;
    }

    try {
      const [movimientos] = await query(
        `SELECT m.*, c.nombre as cuenta_nombre
         FROM movimientos m
         LEFT JOIN cuentas c ON m.cuenta_id = c.id
         ORDER BY m.creado_en DESC
         LIMIT 1`
      );

      if (movimientos.length === 0) {
        await enviar(chatId, 'No hay movimientos para borrar.');
        return;
      }

      const mov = movimientos[0];
      const fecha = formatearFechaCL(mov.fecha);

      await enviar(chatId,
        `¿Eliminar este movimiento?\n\n` +
        `${mov.tipo === 'cargo' ? '💸' : '💰'} $${formatearMonto(mov.monto)}\n` +
        `📝 ${esc(mov.descripcion)}\n` +
        `📅 ${fecha}`,
        {
          reply_markup: {
            inline_keyboard: [[
              { text: '✅ Sí, eliminar', callback_data: `delete_${mov.id}` },
              { text: '❌ Cancelar', callback_data: 'cancel_delete' }
            ]]
          }
        }
      );
    } catch (error) {
      console.error('Error al buscar último movimiento:', error);
      await enviar(chatId, '❌ Error al buscar el movimiento.');
    }
  });
}

/**
 * Configura los manejadores de mensajes y callbacks
 */
function configurarManejadores() {
  // Manejador de mensajes de texto (registro de transacciones)
  bot.on('message', async (msg) => {
    const chatId = msg.chat.id;

    // Ignorar comandos (ya manejados)
    if (msg.text && msg.text.startsWith('/')) {
      return;
    }

    if (!esChatAutorizado(chatId)) {
      if (msg.text && !msg.text.startsWith('/miid')) {
        await enviar(chatId, '❌ No estás autorizado para usar este bot. Usa /miid para obtener tu chat ID.');
      }
      return;
    }

    // Manejar archivos (cartolas)
    if (msg.document) {
      await manejarArchivo(msg);
      return;
    }

    if (msg.photo) {
      await manejarFoto(msg);
      return;
    }

    // Un número solo corrige el monto del movimiento pendiente
    if (msg.text && await actualizarMontoPendiente(msg)) {
      return;
    }

    // Parsear mensaje de texto como transacción
    if (msg.text) {
      await registrarTransaccion(msg);
    }
  });

  // Manejador de callbacks (botones inline)
  bot.on('callback_query', async (cb) => {
    const chatId = cb.message.chat.id;
    const data = cb.data;

    if (!esChatAutorizado(chatId)) {
      await responderCallback(cb.id, { text: '❌ No autorizado' });
      return;
    }

    // Guardar transacción
    if (data.startsWith('save_')) {
      const txId = data.replace('save_', '');
      const tx = pendingTransactions.get(txId);

      if (!tx) {
        await responderCallback(cb.id, { text: '❌ Transacción expirada' });
        return;
      }

      if (requiereDestino(tx.tipo_movimiento) && !tx.cuenta_destino_id) {
        await responderCallback(cb.id, { text: 'Falta elegir la cuenta destino' });
        return;
      }

      try {
        await guardarMovimiento(tx);
        pendingTransactions.delete(txId);

        await editar(
          `✅ <b>Movimiento guardado</b>\n\n` +
          `${tx.tipo === 'cargo' ? '💸' : '💰'} $${formatearMonto(tx.monto)}\n` +
          `📝 ${esc(tx.descripcion)}\n` +
          `Tipo: ${esc(ETIQUETAS_TIPO[tx.tipo_movimiento] ?? tx.tipo_movimiento)}\n` +
          `📅 ${formatearFechaCL(tx.fecha)}\n` +
          (tx.cuentaDestinoNombre ? `Cuenta destino: ${esc(tx.cuentaDestinoNombre)}\n` : '') +
          `🏷 ${esc(tx.categoria || 'Sin categoría')}`,
          {
            chat_id: chatId,
            message_id: cb.message.message_id
          }
        );

        await responderCallback(cb.id, { text: '✅ Guardado' });
      } catch (error) {
        // Mensaje de la BD para diagnosticar (p. ej. "NOT NULL constraint failed: movimientos.cuenta_id")
        console.error('Error al guardar movimiento:', error.code ?? '', error.message);
        await responderCallback(cb.id, { text: '❌ Error al guardar' });
      }
    }

    // Cancelar transacción
    if (data.startsWith('cancel_')) {
      const txId = data.replace('cancel_', '');
      pendingTransactions.delete(txId);

      await editar(
        '❌ Cancelado',
        {
          chat_id: chatId,
          message_id: cb.message.message_id
        }
      );

      await responderCallback(cb.id, { text: 'Cancelado' });
    }

    // Eliminar movimiento
    if (data.startsWith('delete_')) {
      const movId = data.replace('delete_', '');

      try {
        await query('DELETE FROM movimientos WHERE id = ?', [movId]);

        await editar(
          '✅ Movimiento eliminado',
          {
            chat_id: chatId,
            message_id: cb.message.message_id
          }
        );

        await responderCallback(cb.id, { text: '✅ Eliminado' });
      } catch (error) {
        console.error('Error al eliminar movimiento:', error);
        await responderCallback(cb.id, { text: '❌ Error' });
      }
    }

    if (data === 'cancel_delete') {
      await editar(
        '❌ Cancelado',
        {
          chat_id: chatId,
          message_id: cb.message.message_id
        }
      );
      await responderCallback(cb.id, { text: 'Cancelado' });
    }

    // Elegir cuenta destino
    if (data.startsWith('dest_')) {
      const partes = data.match(/^dest_(.+)_(\d+)$/);
      const tx = partes && pendingTransactions.get(partes[1]);
      if (!tx) {
        await responderCallback(cb.id, { text: '❌ Transacción expirada' });
        return;
      }

      try {
        const [cuentas] = await query('SELECT id, nombre FROM cuentas WHERE id = ?', [partes[2]]);
        if (cuentas.length === 0 || cuentas[0].id === tx.cuenta_id) {
          await responderCallback(cb.id, { text: 'Cuenta no válida' });
          return;
        }
        tx.cuenta_destino_id = cuentas[0].id;
        tx.cuentaDestinoNombre = cuentas[0].nombre;

        await refrescarConfirmacion(chatId, cb.message.message_id, partes[1], tx);
        await responderCallback(cb.id, { text: 'Cuenta destino elegida' });
      } catch (error) {
        console.error('Error al elegir cuenta destino:', error.code ?? '', error.message);
        await responderCallback(cb.id, { text: '❌ Error' });
      }
    }

    // Abrir el menú para cambiar el tipo
    if (data.startsWith('tmenu_')) {
      const txId = data.replace('tmenu_', '');
      const tx = pendingTransactions.get(txId);
      if (!tx) {
        await responderCallback(cb.id, { text: '❌ Transacción expirada' });
        return;
      }

      await editar(textoConfirmacion(tx), {
        chat_id: chatId,
        message_id: cb.message.message_id,
        ...tecladoTipos(txId)
      });
      await responderCallback(cb.id, { text: 'Elige el tipo' });
    }

    // Aplicar el tipo elegido
    if (data.startsWith('tset_')) {
      const partes = data.match(/^tset_(.+)_([a-z]{2})$/);
      const tx = partes && pendingTransactions.get(partes[1]);
      const nuevoTipo = partes && TIPO_POR_CODIGO[partes[2]];
      if (!tx || !nuevoTipo) {
        await responderCallback(cb.id, { text: '❌ Transacción expirada' });
        return;
      }

      try {
        const { tipo, tipo_movimiento: tipoMovimiento } = resolverTipos({ tipo: tx.tipo, tipo_movimiento: nuevoTipo });
        tx.tipo = tipo;
        tx.tipo_movimiento = tipoMovimiento;
        if (!requiereDestino(tipoMovimiento)) {
          tx.cuenta_destino_id = null;
          tx.cuentaDestinoNombre = null;
        }

        await refrescarConfirmacion(chatId, cb.message.message_id, partes[1], tx);
        await responderCallback(cb.id, { text: `Tipo: ${ETIQUETAS_TIPO[tipoMovimiento]}` });
      } catch (error) {
        console.error('Error al cambiar el tipo:', error.code ?? '', error.message);
        await responderCallback(cb.id, { text: '❌ Error' });
      }
    }

    // Volver del menú de tipos sin cambiar nada
    if (data.startsWith('tback_')) {
      const txId = data.replace('tback_', '');
      const tx = pendingTransactions.get(txId);
      if (!tx) {
        await responderCallback(cb.id, { text: '❌ Transacción expirada' });
        return;
      }

      await refrescarConfirmacion(chatId, cb.message.message_id, txId, tx);
      await responderCallback(cb.id, {});
    }

    // Confirmar importación de cartola
    if (data.startsWith('import_')) {
      const fileId = data.replace('import_', '');
      // TODO: Implementar confirmación de importación
      await responderCallback(cb.id, { text: '⏳ Importando...' });
    }
  });
}

/**
 * Arma el texto del mensaje de confirmación de un movimiento pendiente
 */
function textoConfirmacion(tx) {
  const esCompra = tx.tipo_movimiento === 'compra';
  const esIngreso = tx.tipo_movimiento === 'ingreso';
  const etiqueta = esCompra ? '💸 Gasto' : esIngreso ? '💰 Ingreso' : (tx.tipo === 'abono' ? '💰 Monto' : '💸 Monto');
  const lineaMonto = tx.aproximado
    ? `${etiqueta}\n💵 Monto aproximado: $${formatearMonto(tx.monto)}\n`
    : `${etiqueta}: $${formatearMonto(tx.monto)}\n`;

  const conDestino = requiereDestino(tx.tipo_movimiento);
  const faltaDestino = conDestino && !tx.cuenta_destino_id;

  return (
    `<b>Confirmar movimiento:</b>\n\n` +
    lineaMonto +
    `Tipo: ${esc(ETIQUETAS_TIPO[tx.tipo_movimiento] ?? tx.tipo_movimiento)}\n` +
    `📝 ${esc(tx.descripcion)}\n` +
    `📅 ${formatearFechaCL(tx.fecha)}\n` +
    (conDestino
      ? `Cuenta origen: ${esc(tx.cuentaNombre ?? 'sin indicar')}\n` +
        `Cuenta destino: ${tx.cuentaDestinoNombre ? esc(tx.cuentaDestinoNombre) : 'sin indicar'}\n`
      : '') +
    `💳 Medio de pago: ${tx.medioPago ? esc(tx.medioPago) : 'sin indicar'}\n` +
    `🏷 Categoría: ${tx.categoria ? esc(tx.categoria) : 'sin categoría'}\n` +
    `${faltaDestino ? '\nElige la cuenta destino:' : ''}` +
    `${tx.aproximado ? '\n💡 Si sabes el monto exacto, respóndeme con el número antes de guardar.' : ''}`
  );
}

/**
 * Teclado de la confirmación. Si el tipo exige cuenta destino y falta, ofrece las cuentas
 * activas (sin Guardar hasta elegir una). Siempre incluye "Cambiar tipo".
 */
async function armarTeclado(txId, tx) {
  const filas = [];
  const faltaDestino = requiereDestino(tx.tipo_movimiento) && !tx.cuenta_destino_id;

  if (faltaDestino) {
    const [cuentas] = await query(
      'SELECT id, nombre FROM cuentas WHERE activa = 1 AND id != ? ORDER BY nombre',
      [tx.cuenta_id]
    );
    for (let i = 0; i < cuentas.length; i += 2) {
      filas.push(
        cuentas.slice(i, i + 2).map(c => ({
          text: String(c.nombre).slice(0, 30),
          callback_data: `dest_${txId}_${c.id}`
        }))
      );
    }
    filas.push([
      { text: 'Cambiar tipo', callback_data: `tmenu_${txId}` },
      { text: '❌ Cancelar', callback_data: `cancel_${txId}` }
    ]);
  } else {
    filas.push([
      { text: '✅ Guardar', callback_data: `save_${txId}` },
      { text: '❌ Cancelar', callback_data: `cancel_${txId}` }
    ]);
    filas.push([{ text: 'Cambiar tipo', callback_data: `tmenu_${txId}` }]);
  }

  return { reply_markup: { inline_keyboard: filas } };
}

/** Teclado para elegir el tipo de movimiento */
function tecladoTipos(txId) {
  const filas = [];
  for (let i = 0; i < TIPOS_MOVIMIENTO.length; i += 2) {
    filas.push(
      TIPOS_MOVIMIENTO.slice(i, i + 2).map(t => ({
        text: ETIQUETAS_TIPO[t],
        callback_data: `tset_${txId}_${CODIGOS_TIPO[t]}`
      }))
    );
  }
  filas.push([{ text: 'Volver', callback_data: `tback_${txId}` }]);
  return { reply_markup: { inline_keyboard: filas } };
}

/**
 * Vuelve a dibujar la confirmación en el mensaje indicado (texto y botones al día).
 * Devuelve el resultado de editar (null si Telegram no pudo editarlo).
 */
async function refrescarConfirmacion(chatId, messageId, txId, tx) {
  return editar(textoConfirmacion(tx), {
    chat_id: chatId,
    message_id: messageId,
    ...(await armarTeclado(txId, tx))
  });
}

/**
 * Si el mensaje es solo un monto y hay un movimiento pendiente en ese chat,
 * reemplaza el monto del pendiente. Devuelve true si lo consumió.
 */
async function actualizarMontoPendiente(msg) {
  const chatId = msg.chat.id;
  const monto = parsearMontoExacto(msg.text);
  if (!monto) return false;

  // Último pendiente de este chat (el Map conserva el orden de inserción)
  let txId = null;
  for (const id of pendingTransactions.keys()) {
    if (id.startsWith(`${chatId}_`)) txId = id;
  }
  if (!txId) return false;

  const tx = pendingTransactions.get(txId);
  tx.monto = monto;
  tx.aproximado = false;

  const editado = tx.messageId
    ? await refrescarConfirmacion(chatId, tx.messageId, txId, tx)
    : null;

  // Si no se pudo editar la confirmación original, enviar una nueva
  if (!editado) {
    const enviado = await enviar(chatId, textoConfirmacion(tx), await armarTeclado(txId, tx));
    tx.messageId = enviado?.message_id ?? tx.messageId;
  }
  return true;
}

/**
 * Cuentas para resolver nombres y medios de pago, la activa más antigua primero
 */
async function listarCuentas() {
  const [cuentas] = await query('SELECT id, nombre, tipo, activa FROM cuentas ORDER BY activa DESC, creado_en ASC, id ASC');
  return cuentas;
}

function sinTildes(texto) {
  return String(texto).toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
}

/**
 * Busca entre las cuentas la que corresponde a un nombre o medio de pago
 * (nombre exacto, nombre que lo contiene o tipo de cuenta: débito -> tarjeta_debito).
 * Devuelve null si ninguna calza.
 */
function elegirCuenta(cuentas, etiqueta) {
  if (!etiqueta) return null;
  const buscado = sinTildes(etiqueta);
  const activaPrimero = [...cuentas].sort((a, b) => Number(b.activa) - Number(a.activa));

  return (
    activaPrimero.find(c => sinTildes(c.nombre) === buscado) ||
    activaPrimero.find(c => sinTildes(c.nombre).includes(buscado)) ||
    activaPrimero.find(c => sinTildes(c.tipo).includes(buscado)) ||
    null
  );
}

/**
 * Cuenta por defecto: la activa más antigua. Con `evitar` se excluye una cuenta y,
 * si hay alternativa, se prefiere una que no sea tarjeta de crédito (origen de un pago).
 */
function cuentaPorDefecto(cuentas, evitar = null) {
  const candidatas = cuentas.filter(c => c.id !== evitar);
  return candidatas.find(c => c.tipo !== 'tarjeta_credito') || candidatas[0] || null;
}

/**
 * Consulta a Gemini con el contexto actual. Devuelve null si no está configurado
 * o si algo falla; nunca lanza.
 */
async function interpretarConGemini(texto, cuentas) {
  if (!geminiDisponible()) return null;

  try {
    const [categorias] = await query('SELECT nombre FROM categorias');
    return await interpretarMovimiento(texto, {
      hoy: fechaHoySantiago(),
      categorias: categorias.map(c => c.nombre),
      mediosPago: MEDIOS_PAGO_NOMBRES,
      cuentas: cuentas.filter(c => Number(c.activa)).map(c => c.nombre)
    });
  } catch (error) {
    console.error('[gemini] no se pudo preparar el contexto:', error.message);
    return null;
  }
}

/**
 * Mezcla el resultado de las reglas con el de Gemini.
 * Si las reglas ya tenían monto, se conserva todo lo suyo y Gemini solo completa
 * categoría y medio de pago; además, si las reglas no reconocieron un tipo (compra por
 * defecto) y Gemini sí, se adopta su tipo y cuenta destino. Si no había monto, se usa
 * la interpretación de Gemini.
 */
function combinarConGemini(reglas, ia) {
  if (reglas.monto) {
    const combinado = {
      ...reglas,
      categoriaDetectada: reglas.categoriaDetectada || ia.categoria,
      medioPago: reglas.medioPago || ia.medioPago
    };
    if (reglas.tipoMovimiento === 'compra' && ia.tipoMovimiento !== 'compra') {
      combinado.tipoMovimiento = ia.tipoMovimiento;
      combinado.tipo = ia.tipo;
      combinado.cuentaDestino = reglas.cuentaDestino || ia.cuentaDestino;
    }
    return combinado;
  }

  return {
    monto: ia.monto,
    aproximado: ia.aproximado,
    fecha: ia.fecha,
    medioPago: ia.medioPago || reglas.medioPago,
    tipo: ia.tipo,
    tipoMovimiento: ia.tipoMovimiento,
    cuentaOrigen: reglas.cuentaOrigen,
    cuentaDestino: ia.cuentaDestino || reglas.cuentaDestino,
    categoriaDetectada: ia.categoria || reglas.categoriaDetectada,
    descripcion: ia.descripcion || reglas.descripcion
  };
}

/**
 * Registra una transacción desde un mensaje de texto
 */
async function registrarTransaccion(msg) {
  const chatId = msg.chat.id;
  const texto = msg.text;

  try {
    const cuentas = await listarCuentas();
    let datos = parsearMensaje(texto, { cuentas });

    // Respaldo: si las reglas no encontraron monto o categoría, consultar Gemini
    if (!datos.monto || !datos.categoriaDetectada) {
      const ia = await interpretarConGemini(texto, cuentas);
      if (ia) datos = combinarConGemini(datos, ia);
    }

    if (!datos.monto) {
      await enviar(chatId, '❌ No pude detectar un monto válido en el mensaje.\n\nEjemplo: "ayer pagué 12.500 en el super"');
      return;
    }

    if (cuentas.length === 0) {
      await enviar(chatId,
        '❌ No hay ninguna cuenta registrada, así que no puedo guardar el movimiento.\n\n' +
        'Crea al menos una cuenta en la aplicación web y vuelve a enviar el mensaje.'
      );
      return;
    }

    // Cuenta destino (pagos de tarjeta y transferencias propias) y cuenta origen
    const conDestino = requiereDestino(datos.tipoMovimiento);
    let cuentaDestino = conDestino ? elegirCuenta(cuentas, datos.cuentaDestino) : null;
    let cuenta;
    if (conDestino) {
      // El origen sale de lo mencionado, no del medio de pago (que en un pago de tarjeta es la tarjeta)
      cuenta = elegirCuenta(cuentas, datos.cuentaOrigen);
      if (!cuenta || (cuentaDestino && cuenta.id === cuentaDestino.id)) {
        cuenta = cuentaPorDefecto(cuentas, cuentaDestino?.id ?? null);
      }
      // Con una sola cuenta no hay otra para el origen: se usa esa y el destino queda por elegir
      if (!cuenta) cuenta = cuentaPorDefecto(cuentas);
      if (cuentaDestino && cuenta && cuentaDestino.id === cuenta.id) {
        cuentaDestino = null;
      }
    } else {
      // Cuenta según el medio de pago, o la cuenta por defecto
      cuenta = elegirCuenta(cuentas, datos.medioPago) || cuentaPorDefecto(cuentas);
    }

    // Buscar categoría por nombre detectado
    let categoriaId = null;
    let categoriaNombre = null;
    if (datos.categoriaDetectada) {
      const [categorias] = await query(
        'SELECT id, nombre FROM categorias WHERE LOWER(nombre) = ? LIMIT 1',
        [datos.categoriaDetectada.toLowerCase()]
      );
      if (categorias.length > 0) {
        categoriaId = categorias[0].id;
        categoriaNombre = categorias[0].nombre;
      }
    }

    // Crear ID temporal para la transacción pendiente
    const txId = `${chatId}_${Date.now()}`;
    const tx = {
      cuenta_id: cuenta.id,
      cuentaNombre: cuenta.nombre,
      cuenta_destino_id: cuentaDestino?.id ?? null,
      cuentaDestinoNombre: cuentaDestino?.nombre ?? null,
      fecha: datos.fecha,
      descripcion: datos.descripcion,
      monto: datos.monto,
      tipo: datos.tipo,
      tipo_movimiento: datos.tipoMovimiento,
      categoria_id: categoriaId,
      categoria: categoriaNombre,
      medioPago: datos.medioPago,
      aproximado: datos.aproximado,
      messageId: null
    };

    pendingTransactions.set(txId, tx);

    // Mostrar confirmación
    const enviado = await enviar(chatId, textoConfirmacion(tx), await armarTeclado(txId, tx));
    tx.messageId = enviado?.message_id ?? null;

    // Limpiar transacciones antiguas (más de 5 minutos)
    setTimeout(() => {
      pendingTransactions.delete(txId);
    }, 5 * 60 * 1000);

  } catch (error) {
    console.error('Error al registrar transacción:', error);
    await enviar(chatId, '❌ Error al procesar el mensaje.');
  }
}

/**
 * Guarda un movimiento en la base de datos
 */
async function guardarMovimiento(tx) {
  await query(
    `INSERT INTO movimientos (cuenta_id, cuenta_destino_id, fecha, descripcion, monto, tipo, tipo_movimiento, categoria_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    // categoria_id y cuenta_destino_id pueden ser null; undefined no es válido para el driver
    [
      tx.cuenta_id,
      tx.cuenta_destino_id ?? null,
      tx.fecha,
      tx.descripcion,
      tx.monto,
      tx.tipo,
      tx.tipo_movimiento ?? 'compra',
      tx.categoria_id ?? null
    ]
  );
}

/**
 * Maneja archivos enviados (cartolas)
 */
async function manejarArchivo(msg) {
  const chatId = msg.chat.id;
  const documento = msg.document;

  try {
    // Telegram puede omitir file_name; basename evita rutas dentro del nombre
    const nombreArchivo = path.basename(documento.file_name || `archivo_${Date.now()}`);
    const ext = path.extname(nombreArchivo).toLowerCase();
    const permitidos = ['.csv', '.xlsx', '.xls', '.pdf'];

    if (!permitidos.includes(ext)) {
      await enviar(chatId, '❌ Formato no compatible. Envía archivos CSV, Excel o PDF.');
      return;
    }

    await enviar(chatId, '⏳ Procesando archivo...');

    // Descargar archivo
    const fileLink = await bot.getFileLink(documento.file_id);
    const uploadsPath = process.env.CARTOLAS_PATH || path.join(__dirname, '../../uploads/cartolas');
    await fs.mkdir(uploadsPath, { recursive: true });

    const destino = path.join(uploadsPath, `telegram_${Date.now()}_${nombreArchivo}`);

    // Descargar usando fetch
    const response = await fetch(fileLink);
    const buffer = await response.arrayBuffer();
    await fs.writeFile(destino, Buffer.from(buffer));

    await enviar(chatId,
      '✅ Archivo recibido.\n\n' +
      '⚠️ Para importar la cartola, ve a la aplicación web y usa el importador de cartolas.\n\n' +
      `Archivo guardado: ${esc(nombreArchivo)}`
    );
  } catch (error) {
    // No imprimir el objeto completo: puede incluir la URL con el token
    logErrorTelegram('procesar archivo', error);
    await enviar(chatId, '❌ Error al procesar el archivo.');
  }
}

/**
 * Maneja fotos enviadas
 */
async function manejarFoto(msg) {
  const chatId = msg.chat.id;
  const foto = msg.photo[msg.photo.length - 1]; // La de mayor resolución

  await enviar(chatId, '⏳ Guardando foto...');

  try {
    const fileLink = await bot.getFileLink(foto.file_id);
    const uploadsPath = process.env.UPLOADS_PATH || path.join(__dirname, '../../uploads');
    await fs.mkdir(uploadsPath, { recursive: true });

    const destino = path.join(uploadsPath, `telegram_${Date.now()}.jpg`);

    const response = await fetch(fileLink);
    const buffer = await response.arrayBuffer();
    await fs.writeFile(destino, Buffer.from(buffer));

    await enviar(chatId, '✅ Foto guardada correctamente.');
  } catch (error) {
    // No imprimir el objeto completo: puede incluir la URL con el token
    logErrorTelegram('guardar foto', error);
    await enviar(chatId, '❌ Error al guardar la foto.');
  }
}

/**
 * Formatea un monto en formato chileno
 */
function formatearMonto(monto) {
  return new Intl.NumberFormat('es-CL').format(monto);
}

export { bot };
