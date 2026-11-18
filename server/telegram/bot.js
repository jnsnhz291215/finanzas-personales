import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const TelegramBot = require('node-telegram-bot-api');

import { query } from '../db.js';
import { parsearMensaje } from './parser.js';
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
      const hoy = new Date();
      const mes = hoy.getMonth() + 1;
      const anio = hoy.getFullYear();

      const [movimientos] = await query(
        `SELECT tipo, SUM(monto) as total
         FROM movimientos
         WHERE MONTH(fecha) = ? AND YEAR(fecha) = ?
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
        const fecha = new Date(m.fecha).toLocaleDateString('es-CL');
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
      const fecha = new Date(mov.fecha).toLocaleDateString('es-CL');

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

      try {
        await guardarMovimiento(tx);
        pendingTransactions.delete(txId);

        await editar(
          `✅ <b>Movimiento guardado</b>\n\n` +
          `${tx.tipo === 'cargo' ? '💸' : '💰'} $${formatearMonto(tx.monto)}\n` +
          `📝 ${esc(tx.descripcion)}\n` +
          `📅 ${new Date(tx.fecha).toLocaleDateString('es-CL')}\n` +
          `🏷 ${esc(tx.categoria || 'Sin categoría')}`,
          {
            chat_id: chatId,
            message_id: cb.message.message_id
          }
        );

        await responderCallback(cb.id, { text: '✅ Guardado' });
      } catch (error) {
        console.error('Error al guardar movimiento:', error);
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

    // Confirmar importación de cartola
    if (data.startsWith('import_')) {
      const fileId = data.replace('import_', '');
      // TODO: Implementar confirmación de importación
      await responderCallback(cb.id, { text: '⏳ Importando...' });
    }
  });
}

/**
 * Registra una transacción desde un mensaje de texto
 */
async function registrarTransaccion(msg) {
  const chatId = msg.chat.id;
  const texto = msg.text;

  try {
    const datos = parsearMensaje(texto);

    if (!datos.monto) {
      await enviar(chatId, '❌ No pude detectar un monto válido en el mensaje.\n\nEjemplo: "ayer pagué 12.500 en el super"');
      return;
    }

    // Buscar cuenta por medio de pago
    let cuentaId = null;
    if (datos.medioPago) {
      const [cuentas] = await query(
        'SELECT id FROM cuentas WHERE LOWER(nombre) LIKE ? OR LOWER(tipo) LIKE ? LIMIT 1',
        [`%${datos.medioPago.toLowerCase()}%`, `%${datos.medioPago.toLowerCase()}%`]
      );
      if (cuentas.length > 0) {
        cuentaId = cuentas[0].id;
      }
    }

    // Si no se encontró cuenta, usar la primera disponible
    if (!cuentaId) {
      const [cuentas] = await query('SELECT id FROM cuentas ORDER BY creado_en ASC LIMIT 1');
      if (cuentas.length > 0) {
        cuentaId = cuentas[0].id;
      }
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
      cuenta_id: cuentaId,
      fecha: datos.fecha,
      descripcion: datos.descripcion,
      monto: datos.monto,
      tipo: datos.tipo,
      categoria_id: categoriaId,
      categoria: categoriaNombre
    };

    pendingTransactions.set(txId, tx);

    // Mostrar confirmación
    await enviar(chatId,
      `<b>Confirmar movimiento:</b>\n\n` +
      `${datos.tipo === 'cargo' ? '💸 Gasto' : '💰 Ingreso'}: $${formatearMonto(datos.monto)}\n` +
      `📝 ${esc(datos.descripcion)}\n` +
      `📅 ${new Date(datos.fecha).toLocaleDateString('es-CL')}\n` +
      `${datos.medioPago ? `💳 ${esc(datos.medioPago)}\n` : ''}` +
      `${categoriaNombre ? `🏷 ${esc(categoriaNombre)}\n` : ''}`,
      {
        reply_markup: {
          inline_keyboard: [[
            { text: '✅ Guardar', callback_data: `save_${txId}` },
            { text: '❌ Cancelar', callback_data: `cancel_${txId}` }
          ]]
        }
      }
    );

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
    `INSERT INTO movimientos (cuenta_id, fecha, descripcion, monto, tipo, categoria_id)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [tx.cuenta_id, tx.fecha, tx.descripcion, tx.monto, tx.tipo, tx.categoria_id]
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
