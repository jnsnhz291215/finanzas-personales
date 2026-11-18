import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const TelegramBot = require('node-telegram-bot-api');

import { query } from '../db.js';
import { parsearMensaje, parsearMontoExacto, MEDIOS_PAGO_NOMBRES } from './parser.js';
import { interpretarMovimiento, interpretarCuenta, geminiDisponible } from './gemini.js';
import {
  parsearDatos,
  camposFaltantes,
  detectarConsultaDatos,
  terminoDesdeTexto,
  buscarRegistros,
  textoPlanoDatos,
  formatearRut,
  normalizarRut,
  TIPOS_CUENTA_TRANSFERENCIA,
  ETIQUETAS_TIPO_TRANSFERENCIA
} from './datosTransferencia.js';
import {
  parsearCuenta,
  nombrePorDefecto,
  enmascararDigitos,
  buscarBanco,
  normalizar,
  capitalizarNombre,
  TIPOS_CUENTA,
  TIPO_DB,
  ETIQUETAS_TIPO_CUENTA,
  ETIQUETAS_TIPO_DB
} from './cuentas.js';
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
    configurarComandosCuentas();
    configurarComandosDatos();
    configurarManejadores();

    // Menú "/" de Telegram; no bloquea el arranque y no lanza
    registrarComandosMenu();

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
 * Texto de ayuda (HTML), compartido por /start, /ayuda y /help.
 * Los comandos listados son los que existen en este archivo.
 */
function textoAyuda() {
  return (
    '📋 <b>Comandos disponibles:</b>\n\n' +
    '<b>Registrar movimientos:</b>\n' +
    'Escribe en lenguaje natural, por ejemplo:\n' +
    '• Gasto: "ayer pagué 12.500 en el super con débito"\n' +
    '• Pago de tarjeta: "pagué la tarjeta de crédito 50 mil"\n' +
    'También puedes enviar un archivo de cartola (CSV, Excel o PDF) para guardarlo.\n\n' +
    '<b>Cuentas:</b>\n' +
    '/savecard - Crear una cuenta (también /nuevacuenta)\n' +
    '/cuentas - Ver tus cuentas activas\n' +
    '/borrarcuenta - Desactivar una cuenta\n' +
    'Ejemplo: /savecard tarjeta debito FAN banco de chile terminada en 1234 a nombre mio (juan sanhueza)\n' +
    'Nunca envíes el número completo: solo los últimos 4 dígitos.\n\n' +
    '<b>Mis datos de transferencia:</b>\n' +
    '/savetrans - Guardar mis datos para que me depositen\n' +
    '/misdatos - Ver los alias guardados\n' +
    '/datos - Pedir los datos de un alias o banco\n' +
    '/borrardatos - Eliminar un registro\n' +
    'Ejemplo: /savetrans mercado pago cuenta vista 1234567890 juan sanhueza rut 12.345.678-5 correo juan@mail.com\n' +
    'Para pedirlos escribe: pásame los datos de transferencia de la mercado pago\n\n' +
    '<b>Consultas:</b>\n' +
    '/resumen - Resumen del mes actual\n' +
    '/ultimos - Últimos 10 movimientos\n' +
    '/borrar_ultimo - Eliminar el último movimiento (con confirmación)\n\n' +
    '<b>Otros:</b>\n' +
    '/help - Mostrar esta ayuda (también /ayuda)\n' +
    '/miid - Obtener tu chat ID\n\n' +
    'Para empezar, crea una cuenta con /savecard (por ejemplo: /savecard efectivo).'
  );
}

// Lista del menú "/" de Telegram (setMyCommands): nombre en minúsculas y descripción corta
const COMANDOS_MENU = [
  { command: 'start', description: 'Comenzar y ver la ayuda' },
  { command: 'help', description: 'Ver todos los comandos' },
  { command: 'ayuda', description: 'Ver todos los comandos (igual que /help)' },
  { command: 'savecard', description: 'Crear una cuenta o tarjeta' },
  { command: 'cuentas', description: 'Ver mis cuentas activas' },
  { command: 'borrarcuenta', description: 'Desactivar una cuenta' },
  { command: 'savetrans', description: 'Guardar mis datos de transferencia' },
  { command: 'misdatos', description: 'Ver mis alias de transferencia' },
  { command: 'datos', description: 'Pedir mis datos de transferencia' },
  { command: 'borrardatos', description: 'Eliminar datos de transferencia' },
  { command: 'resumen', description: 'Resumen del mes actual' },
  { command: 'ultimos', description: 'Ver los últimos 10 movimientos' },
  { command: 'borrar_ultimo', description: 'Eliminar el último movimiento' },
  { command: 'miid', description: 'Obtener mi chat ID' }
];

/** Publica la lista de comandos en el menú de Telegram; nunca lanza (si falla, solo el código) */
async function registrarComandosMenu() {
  try {
    await bot.setMyCommands(COMANDOS_MENU);
  } catch (err) {
    const codigo = err?.response?.body?.error_code ?? err?.code ?? 'desconocido';
    console.error(`[telegram] setMyCommands: error_code=${codigo}`);
  }
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
      '¡Hola! 👋 Soy tu asistente de finanzas personales.\n\n' + textoAyuda()
    );
  });

  // Comandos /ayuda y /help: misma respuesta
  bot.onText(/^\/(?:ayuda|help)(?:@\w+)?\s*$/i, async (msg) => {
    const chatId = msg.chat.id;

    if (!esChatAutorizado(chatId)) {
      await enviar(chatId, '❌ No estás autorizado para usar este bot.');
      return;
    }

    await enviar(chatId, textoAyuda());
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

    // Nombre nuevo para una cuenta pendiente (botón "Editar nombre")
    if (msg.text && await manejarNombreCuentaPendiente(msg)) {
      return;
    }

    // Respuesta a una pregunta de /savetrans (RUT, número, titular...)
    if (msg.text && await manejarRespuestaDato(msg)) {
      return;
    }

    // Pedido de mis datos de transferencia ("pásame los datos de la mercado pago");
    // nunca se trata como gasto
    if (msg.text && await manejarConsultaDatos(msg)) {
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

    // Botones de cuentas (/savecard, /borrarcuenta)
    if (await manejarCallbackCuentas(cb, chatId, data)) {
      return;
    }

    // Botones de datos de transferencia (/savetrans, /borrardatos, consultas)
    if (await manejarCallbackDatos(cb, chatId, data)) {
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
  const [cuentas] = await query('SELECT id, nombre, tipo, activa FROM cuentas WHERE activa = 1 ORDER BY creado_en ASC, id ASC');
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

// ---------------------------------------------------------------------------
// Cuentas: /savecard (alias /nuevacuenta), /cuentas y /borrarcuenta
// ---------------------------------------------------------------------------

// Cuentas pendientes de confirmar: clave -> { datos }
const pendingCuentas = new Map();
// Chat que está escribiendo un nombre nuevo para su cuenta pendiente: chatId -> clave
const esperandoNombreCuenta = new Map();

// Códigos cortos de tipo de cuenta para callback_data
const CODIGOS_TIPO_CUENTA = {
  debito: 'db',
  credito: 'cr',
  efectivo: 'ef',
  cuenta_corriente: 'cc',
  cuenta_vista: 'cv',
  ahorro: 'ah'
};
const TIPO_CUENTA_POR_CODIGO = Object.fromEntries(Object.entries(CODIGOS_TIPO_CUENTA).map(([tipo, codigo]) => [codigo, tipo]));

/**
 * Borra un mensaje del usuario (por ejemplo si trae un número de tarjeta o mis datos de
 * transferencia). Nunca lanza: si falla (p. ej. pasaron más de 48 horas) sigue sin error
 * visible y registra solo el código.
 */
async function borrarMensaje(chatId, messageId) {
  try {
    await bot.deleteMessage(chatId, messageId);
  } catch (err) {
    const codigo = err?.response?.body?.error_code ?? err?.code ?? 'desconocido';
    console.error(`[telegram] deleteMessage: error_code=${codigo}`);
  }
}

function textoConfirmacionCuenta(datos) {
  const lineas = [
    '<b>Confirmar cuenta:</b>',
    '',
    `Tipo: ${esc(ETIQUETAS_TIPO_CUENTA[datos.tipo])}`,
    `Banco: ${datos.banco ? esc(datos.banco) : 'sin indicar'}`,
    `Nombre: ${esc(datos.nombre)}`,
    `Terminada en: ${datos.ultimos4 ? esc(datos.ultimos4) : 'sin indicar'}`,
    `Titular: ${datos.titular ? esc(datos.titular) : 'sin indicar'}`
  ];
  if (datos.tipo === 'credito' && datos.cupo) lineas.push(`Cupo: $${formatearMonto(datos.cupo)}`);
  if (datos.tipo === 'credito' && datos.diaPago) lineas.push(`Día de pago: ${datos.diaPago}`);
  if (datos.numeroCompletoRechazado) {
    lineas.push(
      '',
      'Se ignoró un número largo del mensaje. Por seguridad solo se aceptan los últimos 4 dígitos ' +
      '(por ejemplo: terminada en 1234).'
    );
  }
  return lineas.join('\n');
}

function tecladoConfirmacionCuenta(key) {
  return {
    reply_markup: {
      inline_keyboard: [[
        { text: 'Guardar', callback_data: `ncs_${key}` },
        { text: 'Editar nombre', callback_data: `nce_${key}` },
        { text: 'Cancelar', callback_data: `ncx_${key}` }
      ]]
    }
  };
}

function tecladoTiposCuenta(key) {
  const filas = [];
  for (let i = 0; i < TIPOS_CUENTA.length; i += 2) {
    filas.push(
      TIPOS_CUENTA.slice(i, i + 2).map(t => ({
        text: ETIQUETAS_TIPO_CUENTA[t],
        callback_data: `nct_${key}_${CODIGOS_TIPO_CUENTA[t]}`
      }))
    );
  }
  filas.push([{ text: 'Cancelar', callback_data: `ncx_${key}` }]);
  return { reply_markup: { inline_keyboard: filas } };
}

/** Envía (o edita, si se da messageId) la confirmación de la cuenta pendiente */
async function mostrarConfirmacionCuenta(chatId, key, messageId = null) {
  const pendiente = pendingCuentas.get(key);
  if (!pendiente) return;

  const texto = textoConfirmacionCuenta(pendiente.datos);
  const teclado = tecladoConfirmacionCuenta(key);
  const editado = messageId
    ? await editar(texto, { chat_id: chatId, message_id: messageId, ...teclado })
    : null;
  if (!editado) await enviar(chatId, texto, teclado);
}

/** Completa el resultado de las reglas con el de Gemini (solo lo que las reglas no tenían) */
function combinarCuenta(reglas, ia) {
  const tipo = ia.tipo;
  const banco = reglas.banco || ia.banco;
  return {
    ...reglas,
    tipo,
    banco,
    nombre: reglas.nombre || ia.nombre || nombrePorDefecto(tipo, banco),
    ultimos4: reglas.ultimos4 || ia.ultimos4,
    titular: reglas.titular || ia.titular,
    cupo: tipo === 'credito' ? (reglas.cupo ?? ia.cupo) : null,
    diaPago: tipo === 'credito' ? (reglas.diaPago ?? ia.diaPago) : null
  };
}

/** Cuenta activa con el mismo banco, tipo y últimos 4 (sin últimos 4: mismo nombre) */
async function buscarCuentaDuplicada(datos) {
  const tipoDb = TIPO_DB[datos.tipo];
  const banco = (datos.banco || '').toLowerCase();
  const [filas] = datos.ultimos4
    ? await query(
        `SELECT id, nombre FROM cuentas
         WHERE activa = 1 AND tipo = ? AND COALESCE(LOWER(banco), '') = ? AND ultimos4 = ?
         LIMIT 1`,
        [tipoDb, banco, datos.ultimos4]
      )
    : await query(
        `SELECT id, nombre FROM cuentas
         WHERE activa = 1 AND tipo = ? AND COALESCE(LOWER(banco), '') = ? AND LOWER(nombre) = ?
         LIMIT 1`,
        [tipoDb, banco, String(datos.nombre).toLowerCase()]
      );
  return filas[0] ?? null;
}

async function guardarCuenta(datos) {
  // Nunca se guarda el número completo: solo ultimos4
  await query(
    `INSERT INTO cuentas (nombre, tipo, banco, ultimos4, titular, cupo_total, dia_vencimiento)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [
      datos.nombre,
      TIPO_DB[datos.tipo],
      datos.banco ?? null,
      datos.ultimos4 ?? null,
      datos.titular ?? null,
      datos.tipo === 'credito' ? (datos.cupo ?? null) : null,
      datos.tipo === 'credito' ? (datos.diaPago ?? null) : null
    ]
  );
}

async function listarCuentasActivas() {
  const [filas] = await query(
    'SELECT id, nombre, tipo, banco, ultimos4 FROM cuentas WHERE activa = 1 ORDER BY creado_en ASC, id ASC'
  );
  return filas;
}

function lineaCuenta(cuenta, prefijo = '') {
  return (
    `${prefijo}<b>${esc(cuenta.nombre)}</b> - ${esc(ETIQUETAS_TIPO_DB[cuenta.tipo] ?? cuenta.tipo)}` +
    `${cuenta.banco ? ' - ' + esc(cuenta.banco) : ''}` +
    `${cuenta.ultimos4 ? ' - terminada en ' + esc(cuenta.ultimos4) : ''}`
  );
}

function pedirConfirmacionBorrarCuenta(chatId, cuenta) {
  return enviar(chatId,
    `¿Desactivar esta cuenta?\n\n${lineaCuenta(cuenta)}\n\n` +
    'Los movimientos ya registrados se conservan.',
    {
      reply_markup: {
        inline_keyboard: [[
          { text: 'Sí, desactivar', callback_data: `bcy_${cuenta.id}` },
          { text: 'Cancelar', callback_data: 'bcn_x' }
        ]]
      }
    }
  );
}

function configurarComandosCuentas() {
  // /savecard o /nuevacuenta <texto libre>
  bot.onText(/^\/(?:savecard|nuevacuenta)(?:@\w+)?(?:\s+([\s\S]+))?$/i, async (msg, match) => {
    const chatId = msg.chat.id;

    if (!esChatAutorizado(chatId)) {
      await enviar(chatId, 'No estás autorizado para usar este bot.');
      return;
    }

    const texto = (match[1] || '').trim();
    if (!texto) {
      await enviar(chatId,
        '<b>Crear una cuenta</b>\n\n' +
        'Escribe los datos en texto libre, por ejemplo:\n' +
        '/savecard tarjeta debito FAN banco de chile terminada en 1234 a nombre mio (juan sanhueza)\n\n' +
        'Para crédito puedes agregar el cupo y el día de pago: cupo 110 mil, paga el 24.\n' +
        'Nunca envíes el número completo: solo los últimos 4 dígitos.'
      );
      return;
    }

    try {
      let datos = parsearCuenta(texto);

      // Si el mensaje traía un número de tarjeta completo, se borra del chat
      if (datos.numeroCompletoRechazado) {
        await borrarMensaje(chatId, msg.message_id);
      }

      // Respaldo: Gemini si las reglas no identifican el tipo
      if (!datos.tipo) {
        const ia = await interpretarCuenta(texto);
        if (ia) datos = combinarCuenta(datos, ia);
      }

      const key = `${chatId}_${Date.now()}`;
      pendingCuentas.set(key, { datos });
      setTimeout(() => pendingCuentas.delete(key), 5 * 60 * 1000);

      if (!datos.tipo) {
        await enviar(chatId, 'No pude identificar el tipo de cuenta. Elige uno:', tecladoTiposCuenta(key));
        return;
      }

      await mostrarConfirmacionCuenta(chatId, key);
    } catch (error) {
      // Sin el texto del mensaje: puede contener datos de la tarjeta
      console.error('Error al interpretar la cuenta:', error.code ?? '', error.message);
      await enviar(chatId, '❌ Error al procesar la cuenta.');
    }
  });

  // /cuentas: cuentas activas numeradas
  bot.onText(/^\/cuentas(?:@\w+)?\s*$/i, async (msg) => {
    const chatId = msg.chat.id;

    if (!esChatAutorizado(chatId)) {
      await enviar(chatId, 'No estás autorizado para usar este bot.');
      return;
    }

    try {
      const cuentas = await listarCuentasActivas();
      if (cuentas.length === 0) {
        await enviar(chatId, 'No tienes cuentas activas. Crea una con /savecard.');
        return;
      }
      await enviar(chatId, '<b>Tus cuentas:</b>\n\n' + cuentas.map((c, i) => lineaCuenta(c, `${i + 1}. `)).join('\n'));
    } catch (error) {
      console.error('Error al listar cuentas:', error.code ?? '', error.message);
      await enviar(chatId, '❌ Error al obtener las cuentas.');
    }
  });

  // /borrarcuenta [número]: desactiva (no borra) una cuenta, con confirmación
  bot.onText(/^\/borrarcuenta(?:@\w+)?(?:\s+(\d+))?\s*$/i, async (msg, match) => {
    const chatId = msg.chat.id;

    if (!esChatAutorizado(chatId)) {
      await enviar(chatId, 'No estás autorizado para usar este bot.');
      return;
    }

    try {
      const cuentas = await listarCuentasActivas();
      if (cuentas.length === 0) {
        await enviar(chatId, 'No tienes cuentas activas.');
        return;
      }

      if (match[1]) {
        const cuenta = cuentas[parseInt(match[1], 10) - 1];
        if (!cuenta) {
          await enviar(chatId, 'No existe una cuenta con ese número. Usa /cuentas para ver la lista.');
          return;
        }
        await pedirConfirmacionBorrarCuenta(chatId, cuenta);
        return;
      }

      // Sin número: elegir con botones
      await enviar(chatId, 'Elige la cuenta que quieres desactivar:', {
        reply_markup: {
          inline_keyboard: [
            ...cuentas.map((c, i) => [{ text: `${i + 1}. ${String(c.nombre).slice(0, 40)}`, callback_data: `bcs_${c.id}` }]),
            [{ text: 'Cancelar', callback_data: 'bcn_x' }]
          ]
        }
      });
    } catch (error) {
      console.error('Error en /borrarcuenta:', error.code ?? '', error.message);
      await enviar(chatId, '❌ Error al obtener las cuentas.');
    }
  });
}

/**
 * Si hay una cuenta pendiente esperando un nombre nuevo, usa este mensaje como nombre.
 * Devuelve true si lo consumió.
 */
async function manejarNombreCuentaPendiente(msg) {
  const chatId = msg.chat.id;
  const key = esperandoNombreCuenta.get(chatId);
  if (!key) return false;

  const pendiente = pendingCuentas.get(key);
  if (!pendiente) {
    esperandoNombreCuenta.delete(chatId);
    return false;
  }

  const nombre = msg.text.trim().slice(0, 100);
  if (!nombre) return true;

  // El nombre no puede ser un número de tarjeta
  if (enmascararDigitos(nombre) !== nombre) {
    await borrarMensaje(chatId, msg.message_id);
    await enviar(chatId, 'El nombre no puede incluir números largos. Escribe otro nombre.');
    return true;
  }

  esperandoNombreCuenta.delete(chatId);
  pendiente.datos.nombre = nombre;
  await mostrarConfirmacionCuenta(chatId, key);
  return true;
}

/**
 * Botones de cuentas. Devuelve true si el callback era de este módulo.
 */
async function manejarCallbackCuentas(cb, chatId, data) {
  const messageId = cb.message.message_id;

  // Guardar la cuenta
  if (data.startsWith('ncs_')) {
    const key = data.replace('ncs_', '');
    const pendiente = pendingCuentas.get(key);
    if (!pendiente) {
      await responderCallback(cb.id, { text: 'Solicitud expirada' });
      return true;
    }

    try {
      const duplicada = await buscarCuentaDuplicada(pendiente.datos);
      if (duplicada) {
        pendingCuentas.delete(key);
        await editar(
          `Ya existe una cuenta activa con el mismo banco, tipo y últimos 4: <b>${esc(duplicada.nombre)}</b>. No se creó otra.`,
          { chat_id: chatId, message_id: messageId }
        );
        await responderCallback(cb.id, { text: 'Cuenta duplicada' });
        return true;
      }

      await guardarCuenta(pendiente.datos);
      pendingCuentas.delete(key);
      esperandoNombreCuenta.delete(chatId);

      await editar(
        `Cuenta guardada: <b>${esc(pendiente.datos.nombre)}</b> (${esc(ETIQUETAS_TIPO_CUENTA[pendiente.datos.tipo])}).`,
        { chat_id: chatId, message_id: messageId }
      );
      await responderCallback(cb.id, { text: 'Guardada' });
    } catch (error) {
      console.error('Error al guardar cuenta:', error.code ?? '', error.message);
      await responderCallback(cb.id, { text: 'Error al guardar' });
    }
    return true;
  }

  // Editar el nombre
  if (data.startsWith('nce_')) {
    const key = data.replace('nce_', '');
    if (!pendingCuentas.has(key)) {
      await responderCallback(cb.id, { text: 'Solicitud expirada' });
      return true;
    }
    esperandoNombreCuenta.set(chatId, key);
    await enviar(chatId, 'Escribe el nuevo nombre para la cuenta.');
    await responderCallback(cb.id, {});
    return true;
  }

  // Cancelar
  if (data.startsWith('ncx_')) {
    const key = data.replace('ncx_', '');
    pendingCuentas.delete(key);
    esperandoNombreCuenta.delete(chatId);
    await editar('Cancelado', { chat_id: chatId, message_id: messageId });
    await responderCallback(cb.id, { text: 'Cancelado' });
    return true;
  }

  // Elegir el tipo cuando no se pudo identificar
  if (data.startsWith('nct_')) {
    const partes = data.match(/^nct_(.+)_([a-z]{2})$/);
    const pendiente = partes && pendingCuentas.get(partes[1]);
    const tipo = partes && TIPO_CUENTA_POR_CODIGO[partes[2]];
    if (!pendiente || !tipo) {
      await responderCallback(cb.id, { text: 'Solicitud expirada' });
      return true;
    }

    const datos = pendiente.datos;
    datos.tipo = tipo;
    if (tipo !== 'credito') {
      datos.cupo = null;
      datos.diaPago = null;
    }
    if (!datos.nombre) datos.nombre = nombrePorDefecto(tipo, datos.banco);

    await mostrarConfirmacionCuenta(chatId, partes[1], messageId);
    await responderCallback(cb.id, {});
    return true;
  }

  // /borrarcuenta: elegir una cuenta de la lista
  if (data.startsWith('bcs_')) {
    try {
      const [filas] = await query(
        'SELECT id, nombre, tipo, banco, ultimos4 FROM cuentas WHERE id = ? AND activa = 1',
        [data.replace('bcs_', '')]
      );
      if (filas.length === 0) {
        await responderCallback(cb.id, { text: 'La cuenta ya no está activa' });
        return true;
      }
      await pedirConfirmacionBorrarCuenta(chatId, filas[0]);
      await responderCallback(cb.id, {});
    } catch (error) {
      console.error('Error al elegir cuenta:', error.code ?? '', error.message);
      await responderCallback(cb.id, { text: 'Error' });
    }
    return true;
  }

  // /borrarcuenta: confirmar (soft delete: activa = 0, no se borra la fila)
  if (data.startsWith('bcy_')) {
    try {
      await query('UPDATE cuentas SET activa = 0 WHERE id = ?', [data.replace('bcy_', '')]);
      await editar('Cuenta desactivada. Sus movimientos se conservan.', { chat_id: chatId, message_id: messageId });
      await responderCallback(cb.id, { text: 'Desactivada' });
    } catch (error) {
      console.error('Error al desactivar cuenta:', error.code ?? '', error.message);
      await responderCallback(cb.id, { text: 'Error' });
    }
    return true;
  }

  if (data === 'bcn_x') {
    await editar('Cancelado', { chat_id: chatId, message_id: messageId });
    await responderCallback(cb.id, { text: 'Cancelado' });
    return true;
  }

  return false;
}

// ---------------------------------------------------------------------------
// Mis datos de transferencia: /savetrans, /misdatos, /borrardatos, /datos y la consulta
// en lenguaje natural. Son datos sensibles: solo se responden al chat autorizado y no se
// escriben en consola (los errores de BD se registran solo con su código).
// ---------------------------------------------------------------------------

// Registros pendientes de confirmar: clave -> { datos, reusoOfrecido, refId }
const pendingDatos = new Map();
// Dato que se está esperando de un chat: chatId -> { key, campo }
const esperandoDato = new Map();

const CODIGOS_TIPO_TRANSFER = { corriente: 'co', vista: 'vi', rut: 'ru', ahorro: 'ah' };
const TIPO_TRANSFER_POR_CODIGO = Object.fromEntries(
  Object.entries(CODIGOS_TIPO_TRANSFER).map(([tipo, codigo]) => [codigo, tipo])
);

const ETIQUETAS_CAMPO_DATOS = {
  banco: 'el banco o institución',
  numeroCuenta: 'el número de cuenta',
  titular: 'el nombre del titular',
  rut: 'el RUT',
  email: 'el correo'
};

/** sendMessage en texto plano (sin parse_mode), para respuestas que se copian tal cual; nunca lanza */
async function enviarPlano(chatId, texto, opts = {}) {
  try {
    return await bot.sendMessage(chatId, texto, opts);
  } catch (err) {
    logErrorTelegram('sendMessage', err);
    return null;
  }
}

async function listarDatosTransferencia() {
  const [filas] = await query(
    `SELECT id, cuenta_id, alias, nombre_titular, rut, banco, tipo_cuenta, numero_cuenta, email
     FROM datos_transferencia WHERE activo = 1 ORDER BY creado_en DESC, id DESC`
  );
  return filas;
}

function lineaDatos(registro, prefijo = '') {
  return (
    `${prefijo}<b>${esc(registro.alias)}</b> - ${esc(registro.banco)}` +
    ` - ${esc(ETIQUETAS_TIPO_TRANSFERENCIA[registro.tipo_cuenta] ?? registro.tipo_cuenta)}`
  );
}

function textoConfirmacionDatos(d) {
  return [
    '<b>Confirmar datos de transferencia:</b>',
    '',
    `Alias: ${esc(d.alias ?? d.banco)}`,
    `Titular: ${esc(d.titular)}`,
    `RUT: ${esc(formatearRut(d.rut))}`,
    `Banco: ${esc(d.banco)}`,
    `Tipo de cuenta: ${esc(ETIQUETAS_TIPO_TRANSFERENCIA[d.tipoCuenta])}`,
    `Número: ${esc(d.numeroCuenta)}`,
    `Correo: ${d.email ? esc(d.email) : 'sin indicar'}`
  ].join('\n');
}

function tecladoConfirmacionDatos(key) {
  return {
    reply_markup: {
      inline_keyboard: [[
        { text: 'Guardar', callback_data: `dts_${key}` },
        { text: 'Editar alias', callback_data: `dte_${key}` },
        { text: 'Cancelar', callback_data: `dtx_${key}` }
      ]]
    }
  };
}

function tecladoTiposTransferencia(key) {
  return {
    reply_markup: {
      inline_keyboard: [
        TIPOS_CUENTA_TRANSFERENCIA.slice(0, 2).map(t => ({
          text: ETIQUETAS_TIPO_TRANSFERENCIA[t],
          callback_data: `dtt_${key}_${CODIGOS_TIPO_TRANSFER[t]}`
        })),
        TIPOS_CUENTA_TRANSFERENCIA.slice(2).map(t => ({
          text: ETIQUETAS_TIPO_TRANSFERENCIA[t],
          callback_data: `dtt_${key}_${CODIGOS_TIPO_TRANSFER[t]}`
        })),
        [{ text: 'Cancelar', callback_data: `dtx_${key}` }]
      ]
    }
  };
}

function botonCancelarDatos(key) {
  return { reply_markup: { inline_keyboard: [[{ text: 'Cancelar', callback_data: `dtx_${key}` }]] } };
}

/** Pide al usuario el siguiente dato obligatorio que falta */
async function pedirCampoDatos(chatId, key, campo) {
  const pendiente = pendingDatos.get(key);
  if (campo === 'tipoCuenta') {
    await enviar(chatId, 'Falta el tipo de cuenta. Elige uno:', tecladoTiposTransferencia(key));
    return;
  }

  if (campo === 'rut' && pendiente?.datos.rutInvalido) {
    const pregunta = await enviar(chatId, 'El RUT no es válido (revisa el dígito verificador). Envíalo de nuevo, por ejemplo 12.345.678-5.', botonCancelarDatos(key));
    esperandoDato.set(chatId, { key, campo, messageId: pregunta?.message_id ?? null });
    return;
  }
  const ejemplos = {
    banco: 'Escríbelo, por ejemplo: Mercado Pago.',
    numeroCuenta: 'Escríbelo solo con dígitos.',
    titular: 'Escríbelo, por ejemplo: Juan Sanhueza.',
    rut: 'Escríbelo, por ejemplo: 12.345.678-5.'
  };
  const pregunta = await enviar(chatId, `Falta ${ETIQUETAS_CAMPO_DATOS[campo]}. ${ejemplos[campo]}`, botonCancelarDatos(key));
  esperandoDato.set(chatId, { key, campo, messageId: pregunta?.message_id ?? null });
}

// Respuestas con datos personales: se borran del chat apenas se reciben
const CAMPOS_SENSIBLES_DATOS = ['numeroCuenta', 'titular', 'rut'];

const ETIQUETAS_RECIBIDO_DATOS = {
  alias: 'Alias',
  banco: 'Banco',
  numeroCuenta: 'Número de cuenta',
  titular: 'Titular',
  rut: 'RUT'
};

/** Edita la pregunta del bot (si se puede) o, si no, envía un mensaje nuevo */
async function editarPregunta(chatId, espera, texto, opts = {}) {
  if (espera.messageId) {
    const editado = await editar(texto, { chat_id: chatId, message_id: espera.messageId, ...opts });
    if (editado) return;
  }
  await enviar(chatId, texto, opts);
}

/**
 * Avanza el alta: ofrece reutilizar titular, RUT y correo de otro registro (una vez), pide lo
 * obligatorio que falta y, cuando está completo, muestra la confirmación.
 */
async function avanzarDatos(chatId, key) {
  const pendiente = pendingDatos.get(key);
  if (!pendiente) return;
  const d = pendiente.datos;

  if (!pendiente.reusoOfrecido) {
    pendiente.reusoOfrecido = true;
    const reutilizables = ['titular', 'rut', 'email'].filter(c => !d[c]);
    if (reutilizables.length > 0) {
      const referencia = (await listarDatosTransferencia())[0];
      if (referencia) {
        pendiente.refId = referencia.id;
        await enviar(chatId,
          `Faltan ${reutilizables.map(c => ETIQUETAS_CAMPO_DATOS[c]).join(', ')} en este registro. ` +
          `¿Usar los de <b>${esc(referencia.alias)}</b>?`,
          {
            reply_markup: {
              inline_keyboard: [[
                { text: 'Usar esos datos', callback_data: `dtu_${key}` },
                { text: 'No, los escribo', callback_data: `dtn_${key}` }
              ]]
            }
          }
        );
        return;
      }
    }
  }

  const faltan = camposFaltantes(d);
  if (faltan.length > 0) {
    await pedirCampoDatos(chatId, key, faltan[0]);
    return;
  }

  esperandoDato.delete(chatId);
  if (!d.alias) d.alias = d.banco;
  await enviar(chatId, textoConfirmacionDatos(d), tecladoConfirmacionDatos(key));
}

/** Si el chat está respondiendo a una pregunta de /savetrans, usa este mensaje como respuesta */
async function manejarRespuestaDato(msg) {
  const chatId = msg.chat.id;
  const espera = esperandoDato.get(chatId);
  if (!espera) return false;

  const pendiente = pendingDatos.get(espera.key);
  if (!pendiente) {
    esperandoDato.delete(chatId);
    return false;
  }

  const d = pendiente.datos;
  const texto = msg.text.trim();

  // La respuesta trae un dato personal: se borra del chat aunque sea inválida
  if (CAMPOS_SENSIBLES_DATOS.includes(espera.campo)) {
    await borrarMensaje(chatId, msg.message_id);
  }

  switch (espera.campo) {
    case 'alias':
      d.alias = texto.slice(0, 60);
      break;
    case 'banco': {
      const banco = buscarBanco(normalizar(texto));
      d.banco = banco ? banco.nombre : capitalizarNombre(texto.slice(0, 60));
      break;
    }
    case 'numeroCuenta': {
      const numero = texto.replace(/[\s.-]/g, '');
      if (!/^\d{6,20}$/.test(numero)) {
        await editarPregunta(chatId, espera, 'El número de cuenta debe tener entre 6 y 20 dígitos. Envíalo de nuevo.', botonCancelarDatos(espera.key));
        return true;
      }
      d.numeroCuenta = numero;
      break;
    }
    case 'titular':
      if (texto.length < 3 || /\d/.test(texto)) {
        await editarPregunta(chatId, espera, 'Escribe el nombre completo del titular, sin números.', botonCancelarDatos(espera.key));
        return true;
      }
      d.titular = capitalizarNombre(texto.slice(0, 100));
      break;
    case 'rut': {
      const rut = normalizarRut(texto);
      if (!rut) {
        d.rutInvalido = true;
        await editarPregunta(chatId, espera, 'El RUT no es válido (revisa el dígito verificador). Envíalo de nuevo, por ejemplo 12.345.678-5.', botonCancelarDatos(espera.key));
        return true;
      }
      d.rut = rut;
      d.rutInvalido = false;
      break;
    }
    default:
      esperandoDato.delete(chatId);
      return false;
  }

  esperandoDato.delete(chatId);
  // La pregunta queda sin botones y sin rastro del dato
  await editarPregunta(chatId, espera, `${ETIQUETAS_RECIBIDO_DATOS[espera.campo]} recibido.`);
  await avanzarDatos(chatId, espera.key);
  return true;
}

async function buscarDatosDuplicados(d) {
  const [filas] = await query(
    'SELECT id, alias FROM datos_transferencia WHERE activo = 1 AND LOWER(banco) = ? AND numero_cuenta = ? LIMIT 1',
    [String(d.banco).toLowerCase(), d.numeroCuenta]
  );
  return filas[0] ?? null;
}

async function guardarDatos(d) {
  // Si el alias o el banco coincide con exactamente una cuenta activa, se liga a ella
  const [cuentas] = await query('SELECT id, nombre FROM cuentas WHERE activa = 1');
  const claves = [normalizar(d.alias), normalizar(d.banco)];
  const coincidencias = cuentas.filter(c => claves.includes(normalizar(c.nombre)));
  const cuentaId = coincidencias.length === 1 ? coincidencias[0].id : null;

  await query(
    `INSERT INTO datos_transferencia (cuenta_id, alias, nombre_titular, rut, banco, tipo_cuenta, numero_cuenta, email)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [cuentaId, d.alias, d.titular, d.rut, d.banco, d.tipoCuenta, d.numeroCuenta, d.email ?? null]
  );
}

/**
 * Responde una consulta de datos propios. Una coincidencia: texto plano, un campo por línea,
 * listo para copiar. Varias: botones. Ninguna: lista lo disponible.
 */
async function responderConsultaDatos(chatId, termino) {
  try {
    const registros = await listarDatosTransferencia();
    if (registros.length === 0) {
      await enviarPlano(chatId, 'No tienes datos de transferencia guardados. Usa /savetrans para agregarlos.');
      return;
    }

    const disponibles = registros.map(r => `- ${r.alias}`).join('\n');
    if (!termino) {
      await enviarPlano(chatId, `Datos disponibles:\n${disponibles}\n\nPide por ejemplo: datos de ${registros[0].alias}`);
      return;
    }

    const hallados = buscarRegistros(registros, termino);
    if (hallados.length === 0) {
      await enviarPlano(chatId, `No encontré datos para "${termino}". Disponibles:\n${disponibles}`);
      return;
    }

    if (hallados.length === 1) {
      await enviarPlano(chatId, textoPlanoDatos(hallados[0]));
      return;
    }

    await enviar(chatId, 'Encontré varias coincidencias. Elige una:', {
      reply_markup: {
        inline_keyboard: hallados.map(r => [{
          text: `${r.alias} - ${r.banco}`.slice(0, 60),
          callback_data: `dtq_${r.id}`
        }])
      }
    });
  } catch (error) {
    console.error('Error al consultar datos de transferencia:', error.code ?? error.name);
    await enviar(chatId, 'Error al consultar los datos.');
  }
}

/** Detecta un pedido de datos en un mensaje libre. Devuelve true si lo atendió. */
async function manejarConsultaDatos(msg) {
  const consulta = detectarConsultaDatos(msg.text);
  if (!consulta) return false;
  await responderConsultaDatos(msg.chat.id, consulta.termino);
  return true;
}

function pedirConfirmacionBorrarDatos(chatId, registro) {
  return enviar(chatId,
    `¿Eliminar estos datos de transferencia?\n\n${lineaDatos(registro)}`,
    {
      reply_markup: {
        inline_keyboard: [[
          { text: 'Sí, eliminar', callback_data: `bdy_${registro.id}` },
          { text: 'Cancelar', callback_data: 'bdn_x' }
        ]]
      }
    }
  );
}

function configurarComandosDatos() {
  const rechazarNoAutorizado = (chatId) => enviar(chatId, 'No estás autorizado para usar este bot.');

  // /savetrans <texto libre>
  bot.onText(/^\/savetrans(?:@\w+)?(?:\s+([\s\S]+))?$/i, async (msg, match) => {
    const chatId = msg.chat.id;
    if (!esChatAutorizado(chatId)) {
      await rechazarNoAutorizado(chatId);
      return;
    }

    const texto = (match[1] || '').trim();
    if (!texto) {
      await enviar(chatId,
        '<b>Guardar mis datos de transferencia</b>\n\n' +
        'Escríbelos en texto libre, por ejemplo:\n' +
        '/savetrans mercado pago cuenta vista 1234567890 juan sanhueza rut 12.345.678-5 correo juan@mail.com\n\n' +
        'Después puedes pedirlos con: pásame los datos de transferencia de la mercado pago'
      );
      return;
    }

    try {
      // Sin Gemini: lo que las reglas no encuentran se pregunta después
      const datos = parsearDatos(texto);
      if (!datos.alias && datos.banco) datos.alias = datos.banco;

      // El mensaje trae RUT, número de cuenta y correo: ya está interpretado, se borra del chat
      await borrarMensaje(chatId, msg.message_id);

      // Un RUT con dígito verificador inválido nunca se guarda
      if (datos.rutInvalido) {
        await enviar(chatId, 'El RUT no es válido (revisa el dígito verificador); no se guardará así.');
      }

      const key = `${chatId}_${Date.now()}`;
      pendingDatos.set(key, { datos, reusoOfrecido: false, refId: null });
      setTimeout(() => pendingDatos.delete(key), 5 * 60 * 1000);

      await avanzarDatos(chatId, key);
    } catch (error) {
      console.error('Error al interpretar datos de transferencia:', error.code ?? error.name);
      await enviar(chatId, 'Error al procesar los datos.');
    }
  });

  // /misdatos: alias guardados
  bot.onText(/^\/misdatos(?:@\w+)?\s*$/i, async (msg) => {
    const chatId = msg.chat.id;
    if (!esChatAutorizado(chatId)) {
      await rechazarNoAutorizado(chatId);
      return;
    }

    try {
      const registros = await listarDatosTransferencia();
      if (registros.length === 0) {
        await enviar(chatId, 'No tienes datos de transferencia guardados. Usa /savetrans para agregarlos.');
        return;
      }
      await enviar(chatId,
        '<b>Tus datos de transferencia:</b>\n\n' +
        registros.map((r, i) => lineaDatos(r, `${i + 1}. `)).join('\n') +
        `\n\nPídelos con: pásame los datos de transferencia de ${esc(registros[0].alias)}`
      );
    } catch (error) {
      console.error('Error al listar datos de transferencia:', error.code ?? error.name);
      await enviar(chatId, 'Error al obtener los datos.');
    }
  });

  // /datos <alias o banco>
  bot.onText(/^\/datos(?:@\w+)?(?:\s+([\s\S]+))?$/i, async (msg, match) => {
    const chatId = msg.chat.id;
    if (!esChatAutorizado(chatId)) {
      await rechazarNoAutorizado(chatId);
      return;
    }
    await responderConsultaDatos(chatId, match[1] ? terminoDesdeTexto(match[1]) : null);
  });

  // /borrardatos [número]: desactiva (no borra) un registro, con confirmación
  bot.onText(/^\/borrardatos(?:@\w+)?(?:\s+(\d+))?\s*$/i, async (msg, match) => {
    const chatId = msg.chat.id;
    if (!esChatAutorizado(chatId)) {
      await rechazarNoAutorizado(chatId);
      return;
    }

    try {
      const registros = await listarDatosTransferencia();
      if (registros.length === 0) {
        await enviar(chatId, 'No tienes datos de transferencia guardados.');
        return;
      }

      if (match[1]) {
        const registro = registros[parseInt(match[1], 10) - 1];
        if (!registro) {
          await enviar(chatId, 'No existe un registro con ese número. Usa /misdatos para ver la lista.');
          return;
        }
        await pedirConfirmacionBorrarDatos(chatId, registro);
        return;
      }

      await enviar(chatId, 'Elige los datos que quieres eliminar:', {
        reply_markup: {
          inline_keyboard: [
            ...registros.map((r, i) => [{ text: `${i + 1}. ${String(r.alias).slice(0, 40)}`, callback_data: `bds_${r.id}` }]),
            [{ text: 'Cancelar', callback_data: 'bdn_x' }]
          ]
        }
      });
    } catch (error) {
      console.error('Error en /borrardatos:', error.code ?? error.name);
      await enviar(chatId, 'Error al obtener los datos.');
    }
  });
}

/** Botones de datos de transferencia. Devuelve true si el callback era de este módulo. */
async function manejarCallbackDatos(cb, chatId, data) {
  const messageId = cb.message.message_id;

  // Guardar
  if (data.startsWith('dts_')) {
    const key = data.replace('dts_', '');
    const pendiente = pendingDatos.get(key);
    if (!pendiente) {
      await responderCallback(cb.id, { text: 'Solicitud expirada' });
      return true;
    }

    try {
      if (camposFaltantes(pendiente.datos).length > 0) {
        await responderCallback(cb.id, { text: 'Faltan datos obligatorios' });
        return true;
      }

      const duplicado = await buscarDatosDuplicados(pendiente.datos);
      if (duplicado) {
        pendingDatos.delete(key);
        await editar(
          `Ya tienes guardado ese banco y número de cuenta: <b>${esc(duplicado.alias)}</b>. No se creó otro registro.`,
          { chat_id: chatId, message_id: messageId }
        );
        await responderCallback(cb.id, { text: 'Registro duplicado' });
        return true;
      }

      await guardarDatos(pendiente.datos);
      pendingDatos.delete(key);
      esperandoDato.delete(chatId);

      // Se edita el mensaje para no dejar los datos completos en la conversación
      await editar(
        `Datos guardados: <b>${esc(pendiente.datos.alias)}</b>. Pídelos con: datos de ${esc(pendiente.datos.alias)}`,
        { chat_id: chatId, message_id: messageId }
      );
      await responderCallback(cb.id, { text: 'Guardados' });
    } catch (error) {
      console.error('Error al guardar datos de transferencia:', error.code ?? error.name);
      await responderCallback(cb.id, { text: 'Error al guardar' });
    }
    return true;
  }

  // Editar alias
  if (data.startsWith('dte_')) {
    const key = data.replace('dte_', '');
    if (!pendingDatos.has(key)) {
      await responderCallback(cb.id, { text: 'Solicitud expirada' });
      return true;
    }
    const pregunta = await enviar(chatId, 'Escribe el alias nuevo.', botonCancelarDatos(key));
    esperandoDato.set(chatId, { key, campo: 'alias', messageId: pregunta?.message_id ?? null });
    await responderCallback(cb.id, {});
    return true;
  }

  // Cancelar
  if (data.startsWith('dtx_')) {
    const key = data.replace('dtx_', '');
    pendingDatos.delete(key);
    esperandoDato.delete(chatId);
    await editar('Cancelado', { chat_id: chatId, message_id: messageId });
    await responderCallback(cb.id, { text: 'Cancelado' });
    return true;
  }

  // Reutilizar titular, RUT y correo de otro registro
  if (data.startsWith('dtu_') || data.startsWith('dtn_')) {
    const usar = data.startsWith('dtu_');
    const key = data.slice(4);
    const pendiente = pendingDatos.get(key);
    if (!pendiente) {
      await responderCallback(cb.id, { text: 'Solicitud expirada' });
      return true;
    }

    try {
      if (usar) {
        const referencia = (await listarDatosTransferencia()).find(r => r.id === pendiente.refId);
        if (referencia) {
          const d = pendiente.datos;
          if (!d.titular) d.titular = referencia.nombre_titular;
          if (!d.rut) {
            d.rut = referencia.rut;
            d.rutInvalido = false;
          }
          if (!d.email) d.email = referencia.email;
        }
      }
      await editar(usar ? 'Usando los datos del registro guardado.' : 'Entendido.', { chat_id: chatId, message_id: messageId });
      await responderCallback(cb.id, {});
      await avanzarDatos(chatId, key);
    } catch (error) {
      console.error('Error al reutilizar datos de transferencia:', error.code ?? error.name);
      await responderCallback(cb.id, { text: 'Error' });
    }
    return true;
  }

  // Tipo de cuenta elegido con botones
  if (data.startsWith('dtt_')) {
    const partes = data.match(/^dtt_(.+)_([a-z]{2})$/);
    const pendiente = partes && pendingDatos.get(partes[1]);
    const tipo = partes && TIPO_TRANSFER_POR_CODIGO[partes[2]];
    if (!pendiente || !tipo) {
      await responderCallback(cb.id, { text: 'Solicitud expirada' });
      return true;
    }

    const d = pendiente.datos;
    d.tipoCuenta = tipo;
    // En una cuenta RUT sin número se usa el RUT sin dígito verificador
    if (tipo === 'rut' && !d.numeroCuenta && d.rut) d.numeroCuenta = d.rut.split('-')[0];

    await editar(`Tipo de cuenta: ${esc(ETIQUETAS_TIPO_TRANSFERENCIA[tipo])}`, { chat_id: chatId, message_id: messageId });
    await responderCallback(cb.id, {});
    await avanzarDatos(chatId, partes[1]);
    return true;
  }

  // Elegir entre varias coincidencias de una consulta
  if (data.startsWith('dtq_')) {
    try {
      const registros = await listarDatosTransferencia();
      const registro = registros.find(r => String(r.id) === data.replace('dtq_', ''));
      if (!registro) {
        await responderCallback(cb.id, { text: 'Ya no está disponible' });
        return true;
      }
      await responderCallback(cb.id, {});
      await enviarPlano(chatId, textoPlanoDatos(registro));
    } catch (error) {
      console.error('Error al consultar datos de transferencia:', error.code ?? error.name);
      await responderCallback(cb.id, { text: 'Error' });
    }
    return true;
  }

  // /borrardatos: elegir de la lista
  if (data.startsWith('bds_')) {
    try {
      const registros = await listarDatosTransferencia();
      const registro = registros.find(r => String(r.id) === data.replace('bds_', ''));
      if (!registro) {
        await responderCallback(cb.id, { text: 'Ya no está disponible' });
        return true;
      }
      await pedirConfirmacionBorrarDatos(chatId, registro);
      await responderCallback(cb.id, {});
    } catch (error) {
      console.error('Error en /borrardatos:', error.code ?? error.name);
      await responderCallback(cb.id, { text: 'Error' });
    }
    return true;
  }

  // /borrardatos: confirmar (soft delete: activo = 0)
  if (data.startsWith('bdy_')) {
    try {
      await query(
        'UPDATE datos_transferencia SET activo = 0, actualizado_en = CURRENT_TIMESTAMP WHERE id = ?',
        [data.replace('bdy_', '')]
      );
      await editar('Datos eliminados.', { chat_id: chatId, message_id: messageId });
      await responderCallback(cb.id, { text: 'Eliminados' });
    } catch (error) {
      console.error('Error al eliminar datos de transferencia:', error.code ?? error.name);
      await responderCallback(cb.id, { text: 'Error' });
    }
    return true;
  }

  if (data === 'bdn_x') {
    await editar('Cancelado', { chat_id: chatId, message_id: messageId });
    await responderCallback(cb.id, { text: 'Cancelado' });
    return true;
  }

  return false;
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
