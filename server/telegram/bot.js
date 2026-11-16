import TelegramBot from 'node-telegram-bot-api';
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
    await bot.sendMessage(chatId, `Tu chat ID es: \`${chatId}\`\n\nAgrega este ID a TELEGRAM_ALLOWED_CHAT_IDS en tu archivo .env`, {
      parse_mode: 'Markdown'
    });
  });
  
  // Comando /start
  bot.onText(/\/start/, async (msg) => {
    const chatId = msg.chat.id;
    
    if (!esChatAutorizado(chatId)) {
      await bot.sendMessage(chatId, '❌ No estás autorizado para usar este bot.\n\nUsa /miid para obtener tu chat ID y configúralo en el servidor.');
      return;
    }
    
    await bot.sendMessage(chatId, 
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
      await bot.sendMessage(chatId, '❌ No estás autorizado para usar este bot.');
      return;
    }
    
    await bot.sendMessage(chatId,
      '📋 *Comandos disponibles:*\n\n' +
      '*Registro de movimientos:*\n' +
      'Escribe en lenguaje natural, por ejemplo:\n' +
      '• "ayer pagué 12.500 en el super con débito"\n' +
      '• "gasté 5 lucas en uber con la CMR"\n' +
      '• "me pagaron 300.000 de sueldo"\n\n' +
      '*Consultas:*\n' +
      '/resumen - Resumen del mes actual\n' +
      '/ultimos - Últimos 10 movimientos\n' +
      '/borrar\\_ultimo - Eliminar el último movimiento (con confirmación)\n\n' +
      '*Importar cartolas:*\n' +
      'Envía un archivo CSV, Excel o PDF de tu cartola bancaria.\n\n' +
      '*Otros:*\n' +
      '/ayuda - Mostrar esta ayuda\n' +
      '/miid - Obtener tu chat ID',
      { parse_mode: 'Markdown' }
    );
  });
  
  // Comando /resumen
  bot.onText(/\/resumen/, async (msg) => {
    const chatId = msg.chat.id;
    
    if (!esChatAutorizado(chatId)) {
      await bot.sendMessage(chatId, '❌ No estás autorizado para usar este bot.');
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
      
      await bot.sendMessage(chatId,
        `📊 *Resumen de ${mesNombre} ${anio}*\n\n` +
        `💰 Ingresos: $${formatearMonto(totalIngresos)}\n` +
        `💸 Gastos: $${formatearMonto(totalGastos)}\n` +
        `━━━━━━━━━━━━━━\n` +
        `${saldo >= 0 ? '✅' : '❌'} Saldo: $${formatearMonto(saldo)}`,
        { parse_mode: 'Markdown' }
      );
    } catch (error) {
      console.error('Error al obtener resumen:', error);
      await bot.sendMessage(chatId, '❌ Error al obtener el resumen.');
    }
  });
  
  // Comando /ultimos
  bot.onText(/\/ultimos/, async (msg) => {
    const chatId = msg.chat.id;
    
    if (!esChatAutorizado(chatId)) {
      await bot.sendMessage(chatId, '❌ No estás autorizado para usar este bot.');
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
        await bot.sendMessage(chatId, 'No hay movimientos registrados.');
        return;
      }
      
      let mensaje = '📝 *Últimos 10 movimientos:*\n\n';
      
      movimientos.forEach((m, i) => {
        const icono = m.tipo === 'cargo' ? '💸' : '💰';
        const fecha = new Date(m.fecha).toLocaleDateString('es-CL');
        const categoria = m.categoria_nombre || 'Sin categoría';
        mensaje += `${i + 1}. ${icono} $${formatearMonto(m.monto)} - ${m.descripcion}\n`;
        mensaje += `   📅 ${fecha} • ${categoria}\n\n`;
      });
      
      await bot.sendMessage(chatId, mensaje, { parse_mode: 'Markdown' });
    } catch (error) {
      console.error('Error al obtener últimos movimientos:', error);
      await bot.sendMessage(chatId, '❌ Error al obtener los movimientos.');
    }
  });
  
  // Comando /borrar_ultimo
  bot.onText(/\/borrar_ultimo/, async (msg) => {
    const chatId = msg.chat.id;
    
    if (!esChatAutorizado(chatId)) {
      await bot.sendMessage(chatId, '❌ No estás autorizado para usar este bot.');
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
        await bot.sendMessage(chatId, 'No hay movimientos para borrar.');
        return;
      }
      
      const mov = movimientos[0];
      const fecha = new Date(mov.fecha).toLocaleDateString('es-CL');
      
      await bot.sendMessage(chatId,
        `¿Eliminar este movimiento?\n\n` +
        `${mov.tipo === 'cargo' ? '💸' : '💰'} $${formatearMonto(mov.monto)}\n` +
        `📝 ${mov.descripcion}\n` +
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
      await bot.sendMessage(chatId, '❌ Error al buscar el movimiento.');
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
        await bot.sendMessage(chatId, '❌ No estás autorizado para usar este bot. Usa /miid para obtener tu chat ID.');
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
  bot.on('callback_query', async (query) => {
    const chatId = query.message.chat.id;
    const data = query.data;
    
    if (!esChatAutorizado(chatId)) {
      await bot.answerCallbackQuery(query.id, { text: '❌ No autorizado' });
      return;
    }
    
    // Guardar transacción
    if (data.startsWith('save_')) {
      const txId = data.replace('save_', '');
      const tx = pendingTransactions.get(txId);
      
      if (!tx) {
        await bot.answerCallbackQuery(query.id, { text: '❌ Transacción expirada' });
        return;
      }
      
      try {
        await guardarMovimiento(tx);
        pendingTransactions.delete(txId);
        
        await bot.editMessageText(
          `✅ *Movimiento guardado*\n\n` +
          `${tx.tipo === 'cargo' ? '💸' : '💰'} $${formatearMonto(tx.monto)}\n` +
          `📝 ${tx.descripcion}\n` +
          `📅 ${new Date(tx.fecha).toLocaleDateString('es-CL')}\n` +
          `🏷 ${tx.categoria || 'Sin categoría'}`,
          {
            chat_id: chatId,
            message_id: query.message.message_id,
            parse_mode: 'Markdown'
          }
        );
        
        await bot.answerCallbackQuery(query.id, { text: '✅ Guardado' });
      } catch (error) {
        console.error('Error al guardar movimiento:', error);
        await bot.answerCallbackQuery(query.id, { text: '❌ Error al guardar' });
      }
    }
    
    // Cancelar transacción
    if (data.startsWith('cancel_')) {
      const txId = data.replace('cancel_', '');
      pendingTransactions.delete(txId);
      
      await bot.editMessageText(
        '❌ Cancelado',
        {
          chat_id: chatId,
          message_id: query.message.message_id
        }
      );
      
      await bot.answerCallbackQuery(query.id, { text: 'Cancelado' });
    }
    
    // Eliminar movimiento
    if (data.startsWith('delete_')) {
      const movId = data.replace('delete_', '');
      
      try {
        await query('DELETE FROM movimientos WHERE id = ?', [movId]);
        
        await bot.editMessageText(
          '✅ Movimiento eliminado',
          {
            chat_id: chatId,
            message_id: query.message.message_id
          }
        );
        
        await bot.answerCallbackQuery(query.id, { text: '✅ Eliminado' });
      } catch (error) {
        console.error('Error al eliminar movimiento:', error);
        await bot.answerCallbackQuery(query.id, { text: '❌ Error' });
      }
    }
    
    if (data === 'cancel_delete') {
      await bot.editMessageText(
        '❌ Cancelado',
        {
          chat_id: chatId,
          message_id: query.message.message_id
        }
      );
      await bot.answerCallbackQuery(query.id, { text: 'Cancelado' });
    }
    
    // Confirmar importación de cartola
    if (data.startsWith('import_')) {
      const fileId = data.replace('import_', '');
      // TODO: Implementar confirmación de importación
      await bot.answerCallbackQuery(query.id, { text: '⏳ Importando...' });
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
      await bot.sendMessage(chatId, '❌ No pude detectar un monto válido en el mensaje.\n\nEjemplo: "ayer pagué 12.500 en el super"');
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
    await bot.sendMessage(chatId,
      `*Confirmar movimiento:*\n\n` +
      `${datos.tipo === 'cargo' ? '💸 Gasto' : '💰 Ingreso'}: $${formatearMonto(datos.monto)}\n` +
      `📝 ${datos.descripcion}\n` +
      `📅 ${new Date(datos.fecha).toLocaleDateString('es-CL')}\n` +
      `${datos.medioPago ? `💳 ${datos.medioPago}\n` : ''}` +
      `${categoriaNombre ? `🏷 ${categoriaNombre}\n` : ''}`,
      {
        parse_mode: 'Markdown',
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
    await bot.sendMessage(chatId, '❌ Error al procesar el mensaje.');
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
  
  const ext = path.extname(documento.file_name).toLowerCase();
  const permitidos = ['.csv', '.xlsx', '.xls', '.pdf'];
  
  if (!permitidos.includes(ext)) {
    await bot.sendMessage(chatId, '❌ Formato no soportado. Envía archivos CSV, Excel o PDF.');
    return;
  }
  
  await bot.sendMessage(chatId, '⏳ Procesando archivo...');
  
  try {
    // Descargar archivo
    const fileLink = await bot.getFileLink(documento.file_id);
    const uploadsPath = process.env.CARTOLAS_PATH || path.join(__dirname, '../../uploads/cartolas');
    await fs.mkdir(uploadsPath, { recursive: true });
    
    const destino = path.join(uploadsPath, `telegram_${Date.now()}_${documento.file_name}`);
    
    // Descargar usando fetch
    const response = await fetch(fileLink);
    const buffer = await response.arrayBuffer();
    await fs.writeFile(destino, Buffer.from(buffer));
    
    await bot.sendMessage(chatId,
      '✅ Archivo recibido.\n\n' +
      '⚠️ Para importar la cartola, ve a la aplicación web y usa el importador de cartolas.\n\n' +
      `Archivo guardado: ${documento.file_name}`
    );
  } catch (error) {
    console.error('Error al procesar archivo:', error);
    await bot.sendMessage(chatId, '❌ Error al procesar el archivo.');
  }
}

/**
 * Maneja fotos enviadas
 */
async function manejarFoto(msg) {
  const chatId = msg.chat.id;
  const foto = msg.photo[msg.photo.length - 1]; // La de mayor resolución
  
  await bot.sendMessage(chatId, '⏳ Guardando foto...');
  
  try {
    const fileLink = await bot.getFileLink(foto.file_id);
    const uploadsPath = process.env.UPLOADS_PATH || path.join(__dirname, '../../uploads');
    await fs.mkdir(uploadsPath, { recursive: true });
    
    const destino = path.join(uploadsPath, `telegram_${Date.now()}.jpg`);
    
    const response = await fetch(fileLink);
    const buffer = await response.arrayBuffer();
    await fs.writeFile(destino, Buffer.from(buffer));
    
    await bot.sendMessage(chatId, '✅ Foto guardada correctamente.');
  } catch (error) {
    console.error('Error al guardar foto:', error);
    await bot.sendMessage(chatId, '❌ Error al guardar la foto.');
  }
}

/**
 * Formatea un monto en formato chileno
 */
function formatearMonto(monto) {
  return new Intl.NumberFormat('es-CL').format(monto);
}

export { bot };
