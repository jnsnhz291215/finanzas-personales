import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const TelegramBot = require('node-telegram-bot-api');

import { query } from '../db.js';
import { parsearMensaje, parsearMontoExacto, MEDIOS_PAGO_NOMBRES } from './parser.js';
import { interpretarMovimiento, interpretarCuenta, geminiDisponible } from './gemini.js';
import {
  parsearDatos,
  camposFaltantes,
  terminoDesdeTexto,
  buscarRegistros,
  textoPlanoDatos,
  formatearRut,
  normalizarRut,
  TIPOS_CUENTA_TRANSFERENCIA,
  ETIQUETAS_TIPO_TRANSFERENCIA
} from './datosTransferencia.js';
import {
  obtenerPlan,
  listarGastosFijos,
  crearGastoFijo,
  actualizarGastoFijo,
  validarGastoFijo,
  parsearFijo,
  TIPOS_GASTO_LIBRE
} from '../planAhorro.js';
import { crearAdmin } from './admin.js';
import { crearCuotas } from './cuotasBot.js';
import { crearCartolas } from './cartolasBot.js';
import { crearRegistros } from './registrosBot.js';
import { crearReset } from './resetBot.js';
import { crearStatus } from './statusBot.js';
import { crearVistaCuentas } from './vistaCuentasBot.js';
import { crearEditarCuenta } from './editarCuentaBot.js';
import { mensajesAyuda, COMANDOS_CONOCIDOS, COMANDOS_MENU } from './comandos.js';
import { crearLoteTerceros } from './loteTerceros.js';
import { crearTransferencias } from './transferenciasBot.js';
import { esTitularPropio } from './terceros.js';
import { fijarTitular } from '../resumenDatos.js';
import { clavePorNombre } from '../transferencias.js';
import { crearSistema } from './sistemaBot.js';
import { crearIntenciones, clasificarPorReglas } from './intenciones.js';
import { limitadorGemini } from './limiteGemini.js';
import { guardarBuffer, borrarArchivo } from '../storage.js';
import { categoriaPorReglas } from '../gestion.js';
import { canonizarPersona } from '../deudas.js';
import { detectarPrestamo } from './prestamo.js';
import { vincularMensajes } from '../registros.js';
import {
  parsearCuenta,
  nombrePorDefecto,
  enmascararDigitos,
  buscarBanco,
  normalizar,
  capitalizarNombre,
  valorTitular,
  nombreAutomatico,
  esNombreSoloDigitos,
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
// Administración desde el bot (movimientos, categorías, deudas, plan); se crea al iniciar el bot
let admin = null;
// Compras en cuotas (cuotasBot.js); se crea al iniciar el bot
let cuotas = null;
// Importación de cartolas desde el bot (cartolasBot.js); se crea al iniciar el bot
let cartolas = null;
// Reinicio y actualización desde el bot (sistemaBot.js); se crea al iniciar el bot
let sistema = null;
// Eliminar/corregir/deshacer respondiendo a un mensaje (registrosBot.js); se crea al iniciar el bot
let registros = null;
// Reinicio total de los datos y restauración de respaldos (resetBot.js); se crea al iniciar el bot
let reset = null;
// Chequeo de estado de la app, /status (statusBot.js); se crea al iniciar el bot
let status = null;
// Vista de cuentas con vínculos, /cuentas (vistaCuentasBot.js); se crea al iniciar el bot
let vistaCuentas = null;
// Editar una cuenta o tarjeta, /editarcuenta (editarCuentaBot.js); se crea al iniciar el bot
let editarCuenta = null;
// Cartola de una tarjeta ajena + comprobante de la transferencia (loteTerceros.js); se crea al iniciar el bot
let terceros = null;
// Clasificación de transferencias salientes (transferenciasBot.js); se crea al iniciar el bot
let transferencias = null;
// Enrutador de intenciones para mensajes libres (intenciones.js); se crea al iniciar el bot
let intenciones = null;
// Foto que espera el texto de un gasto para quedar como su respaldo: chatId -> { fileId, nombre, hasta }
const esperandoComprobante = new Map();

// Estado temporal para confirmaciones
const pendingTransactions = new Map();

// Chat que está escribiendo la persona de un préstamo: chatId -> txId
const esperandoPersona = new Map();

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

// ---------------------------------------------------------------------------
// Preguntas con un solo botón "Cancelar"
//
// Cuando el bot hace una pregunta que se responde escribiendo (el monto, un nombre, el valor de un campo...) deja un botón
// Cancelar. Al recibir la respuesta, o al tocar un botón de ese mismo flujo, a la pregunta se le quitan los botones y se deja
// escrito lo respondido, para que no quede un Cancelar viejo dando vueltas.
// ---------------------------------------------------------------------------

// chatId -> Map(messageId -> { texto, flujo, seq })
const preguntasAbiertas = new Map();
let secuenciaPreguntas = 0;

/** callback_data del botón Cancelar si el teclado es solo ese botón; si no, null */
function cancelarSolitario(opts) {
  const filas = opts?.reply_markup?.inline_keyboard;
  if (!Array.isArray(filas) || filas.length !== 1 || filas[0].length !== 1) return null;
  const boton = filas[0][0];
  return /^cancelar$/i.test(boton.text) ? String(boton.callback_data ?? '') : null;
}

/** El flujo de un botón: las dos primeras letras de su callback_data (ec, fj, cq, in, nc...) */
const flujoDe = (callbackData) => String(callbackData ?? '').slice(0, 2);

function recordarPregunta(chatId, messageId, texto, callbackData) {
  if (!messageId) return;
  if (!preguntasAbiertas.has(chatId)) preguntasAbiertas.set(chatId, new Map());
  preguntasAbiertas.get(chatId).set(messageId, { texto, flujo: flujoDe(callbackData), seq: ++secuenciaPreguntas });
}

function olvidarPregunta(chatId, messageId) {
  preguntasAbiertas.get(chatId)?.delete(messageId);
}

/**
 * Quita los botones a las preguntas abiertas de un chat que se hicieron antes de la secuencia `hasta` (lo que se preguntó mientras se
 * procesaba el mensaje actual sigue abierto). `flujo` limita a un flujo; `excepto` salta un mensaje; con `respuesta`, la deja escrita
 * en la pregunta (salvo que traiga un número largo). Nunca lanza.
 */
async function limpiarPreguntas(chatId, { hasta, flujo = null, excepto = null, respuesta = null } = {}) {
  const abiertas = preguntasAbiertas.get(chatId);
  if (!abiertas || abiertas.size === 0) return;

  const respuestaSegura = respuesta && respuesta.length <= 120 && !/\d{5,}/.test(String(respuesta).replace(/(?<=\d)[\s.-](?=\d)/g, ''))
    ? respuesta.trim()
    : null;

  for (const [messageId, p] of [...abiertas]) {
    if (p.seq > hasta || (flujo && p.flujo !== flujo) || messageId === excepto) continue;
    abiertas.delete(messageId);
    try {
      if (respuestaSegura) {
        await bot.editMessageText(`${p.texto}\n\n<b>Respuesta:</b> ${esc(respuestaSegura)}`, { chat_id: chatId, message_id: messageId, parse_mode: 'HTML' });
      } else {
        await bot.editMessageReplyMarkup({ inline_keyboard: [] }, { chat_id: chatId, message_id: messageId });
      }
    } catch (err) {
      logErrorTelegram('quitar botones', err);
    }
  }
}

/** sendMessage con HTML por defecto; nunca lanza */
async function enviar(chatId, texto, opts = {}) {
  try {
    const enviado = await bot.sendMessage(chatId, texto, { parse_mode: 'HTML', ...opts });
    const cancelar = cancelarSolitario(opts);
    if (cancelar) recordarPregunta(chatId, enviado?.message_id, texto, cancelar);
    return enviado;
  } catch (err) {
    logErrorTelegram('sendMessage', err);
    return null;
  }
}

/** editMessageText con HTML por defecto; nunca lanza */
async function editar(texto, opts = {}) {
  try {
    const editado = await bot.editMessageText(texto, { parse_mode: 'HTML', ...opts });
    // Un mensaje editado con otro teclado (o sin botones) ya no es una pregunta abierta; si quedó con solo Cancelar, sí
    if (opts.chat_id && opts.message_id) {
      const cancelar = cancelarSolitario(opts);
      if (cancelar) recordarPregunta(opts.chat_id, opts.message_id, texto, cancelar);
      else olvidarPregunta(opts.chat_id, opts.message_id);
    }
    return editado;
  } catch (err) {
    logErrorTelegram('editMessageText', err);
    return null;
  }
}

// Callbacks ya respondidos (para saber si un botón quedó sin respuesta); se limpian solos
const callbacksRespondidos = new Set();

/** answerCallbackQuery; nunca lanza */
async function responderCallback(callbackId, opts = {}) {
  callbacksRespondidos.add(callbackId);
  setTimeout(() => callbacksRespondidos.delete(callbackId), 2 * 60 * 1000).unref?.();
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
    configurarComandosPlan();

    admin = crearAdmin({ bot, enviar, editar, responderCallback, esc, esChatAutorizado, formatearMonto });
    admin.configurarComandos();

    cuotas = crearCuotas({
      bot,
      enviar,
      editar,
      responderCallback,
      esc,
      esChatAutorizado,
      formatearMonto,
      resolverCuentaPago,
      guardarRespaldo: guardarRespaldoCuota,
      eliminarRespaldo: eliminarRespaldoCuota,
      manejarFoto,
      iniciarComprobanteGasto,
      vincularRegistro: vincularMensajes
    });
    cuotas.configurarComandos();

    transferencias = crearTransferencias({ bot, enviar, editar, responderCallback, esc, formatearMonto });

    terceros = crearLoteTerceros({
      bot,
      transferencias,
      enviar,
      editar,
      responderCallback,
      esc,
      formatearMonto,
      guardarRespaldo: guardarRespaldoCuota,
      eliminarRespaldo: eliminarRespaldoCuota,
      descargarBuffer,
      resolverCuentaPago,
      vincularRegistro: vincularMensajes
    });

    cartolas = crearCartolas({
      terceros,
      transferencias,
      enviar,
      editar,
      responderCallback,
      esc,
      formatearMonto,
      vincularRegistro: vincularMensajes,
      ofrecerPagoPorCartola: (chatId, movimiento) => cuotas.ofrecerPagoPorCartola(chatId, movimiento),
      crearCuenta: guardarCuenta,
      guardarNoLeido: (nombre, buffer) =>
        guardarBuffer('cartolas', nombre, buffer, { prefijo: `telegram_${Date.now()}_` })
    });

    registros = crearRegistros({ enviar, editar, responderCallback, esc });

    reset = crearReset({ bot, enviar, editar, responderCallback, esc, esChatAutorizado });
    reset.configurarComandos();

    // Cuenta por defecto al registrar un gasto: la última usada o, si no hay, la primera que no es crédito
    vistaCuentas = crearVistaCuentas({
      proponerCambioCuenta: (chatId, id, campo, valor) => editarCuenta.proponerCambio(chatId, id, campo, valor),
      enviar,
      editar,
      responderCallback,
      esc,
      cuentaPorDefecto: async (cuentas) => (await ultimaCuentaUsada(cuentas)) || cuentaPorDefecto(cuentas)
    });

    editarCuenta = crearEditarCuenta({ bot, enviar, editar, responderCallback, esc, esChatAutorizado, borrarMensaje });
    editarCuenta.configurarComandos();

    status = crearStatus({ bot, enviar, editar, esc, esChatAutorizado, chatIds: () => allowedChatIds });
    status.configurarComandos();

    intenciones = crearIntenciones({
      enviar,
      editar,
      responderCallback,
      esc,
      registrar: (msg, opciones) => registrarTransaccion(msg, opciones),
      cuotasMensaje: (msg) => cuotas.intentarMensaje(msg),
      cuotasLista: (chatId) => cuotas.enviarLista(chatId),
      consultarGastos: (chatId, texto) => admin.consultarGastos(chatId, texto),
      plan: (chatId) => responderPlan(chatId),
      datos: (chatId, termino) => responderConsultaDatos(chatId, termino),
      cuentas: (chatId) => enviarCuentas(chatId),
      buscar: (chatId, texto) => admin.buscar(chatId, texto),
      ayuda: (chatId) => enviarAyuda(chatId),
      eliminarUltimo: (chatId) => registros.eliminarUltimo(chatId),
      gastoFijo: (msg, datos) => procesarGastoFijo(msg.chat.id, datos),
      editarCuenta: (msg, datos) => (datos.accion === 'abrir'
        ? editarCuenta.abrirPorDigitos(msg.chat.id, datos.digitos)
        : editarCuenta.cambiarCampoPorDigitos(msg.chat.id, datos.digitos, datos.campo, datos.valor)),
      guardarCuenta: (msg, datos) => procesarCuentaDesdeTexto(msg, datos.textoCuenta, { natural: true, numeroLargo: datos.numeroLargo }),
      ayudaGuardarCuenta: (chatId) => enviarAyudaGuardarCuenta(chatId),
      asignarDigitos: (chatId, datos) => cartolas.proponerDigitos(chatId, datos),
      estado: (chatId) => status.responder(chatId),
      reset: (chatId) => reset.pedirReset(chatId),
      restaurarRespaldo: (chatId) => reset.pedirRestaurar(chatId)
    });

    sistema = crearSistema({ bot, enviar, editar, responderCallback, esc, esChatAutorizado });
    sistema.configurarComandos();
    configurarManejadores();

    // Menú "/" de Telegram; no bloquea el arranque y no lanza
    registrarComandosMenu();

    // Si el servidor se reinició con /reboot o /update, avisa que ya volvió
    sistema.notificarReinicioPendiente();

    // En producción, un rato después de arrancar revisa todo y avisa solo si algo no funciona
    setTimeout(() => status.revisarAlArrancar(), 15000).unref();

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
 * Manda la ayuda (/start, /ayuda y /help): la lista de TODOS los comandos por sección y unos ejemplos de frases. Sale de
 * comandos.js, la única fuente de los comandos; si no cabe en un mensaje de Telegram, se manda en varios.
 */
async function enviarAyuda(chatId, saludo = null) {
  for (const mensaje of mensajesAyuda(esc, { saludo })) {
    await enviar(chatId, mensaje);
  }
}

/**
 * ¿Algún manejador de comandos (bot.onText) acepta este texto? Un comando conocido con argumentos que su patrón no admite
 * (por ejemplo "/status algo") no lo atiende nadie y se avisa. Usa la lista de patrones de la librería; si no está disponible
 * no se puede saber y no se responde de más.
 */
function algunComandoLoAtiende(texto) {
  const patrones = bot?._textRegexpCallbacks;
  if (!Array.isArray(patrones)) return true;
  return patrones.some(({ regexp }) => {
    regexp.lastIndex = 0;
    return regexp.test(texto);
  });
}

// Los comandos que existen (COMANDOS_CONOCIDOS) y el menú "/" de Telegram (COMANDOS_MENU: los marcados con `menu`) vienen
// de comandos.js, la misma lista de la que sale /help

// Menú para quien no está autorizado: solo /miid (para obtener su chat ID)
const COMANDOS_PUBLICOS = [{ command: 'miid', description: 'Obtener mi chat ID' }];

function codigoErrorTelegram(err) {
  return err?.response?.body?.error_code ?? err?.code ?? 'desconocido';
}

/**
 * Publica el menú "/" de Telegram. El alcance por defecto solo tiene /miid; el menú
 * completo se publica con scope "chat" para cada ID de TELEGRAM_ALLOWED_CHAT_IDS.
 * Nunca lanza: ante un error registra solo el código (sin IDs) y sigue.
 */
async function registrarComandosMenu() {
  try {
    await bot.setMyCommands(COMANDOS_PUBLICOS, { scope: { type: 'default' } });
  } catch (err) {
    console.error(`[telegram] setMyCommands (por defecto): error_code=${codigoErrorTelegram(err)}`);
  }

  const ids = allowedChatIds.filter(id => Number.isInteger(id));
  if (ids.length === 0) {
    console.warn('[telegram] TELEGRAM_ALLOWED_CHAT_IDS está vacía: el menú solo incluye /miid');
    return;
  }

  for (const chatId of ids) {
    try {
      await bot.setMyCommands(COMANDOS_MENU, { scope: { type: 'chat', chat_id: chatId } });
    } catch (err) {
      console.error(`[telegram] setMyCommands (chat autorizado): error_code=${codigoErrorTelegram(err)}`);
    }
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

    await enviarAyuda(chatId, '¡Hola! 👋 Soy tu asistente de finanzas personales.');
  });

  // Comandos /ayuda y /help: misma respuesta
  bot.onText(/^\/(?:ayuda|help)(?:@\w+)?\s*$/i, async (msg) => {
    const chatId = msg.chat.id;

    if (!esChatAutorizado(chatId)) {
      await enviar(chatId, '❌ No estás autorizado para usar este bot.');
      return;
    }

    await enviarAyuda(chatId);
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

    // Lista con botones por movimiento para editar o borrar (admin.js)
    await admin.mostrarUltimos(chatId);
  });

}

/**
 * Configura los manejadores de mensajes y callbacks
 */
function configurarManejadores() {
  // Álbumes de fotos que se están juntando: "chatId_grupo" -> { mensajes, timer }
  const albumesEnCurso = new Map();
  const ESPERA_ALBUM_MS = 3000;

  /**
   * Junta las fotos de un álbum (llegan como mensajes sueltos y el caption solo viene en una). Pasados unos segundos desde
   * la última, si algún caption habla de cartolas el caption vale para todas, también para las que llegaron antes; si no,
   * cada foto sigue su camino de siempre. Devuelve true si tomó el mensaje.
   */
  function juntarAlbum(msg) {
    const clave = `${msg.chat.id}_${msg.media_group_id}`;
    let album = albumesEnCurso.get(clave);
    if (!album) {
      album = { mensajes: [], timer: null };
      albumesEnCurso.set(clave, album);
    }
    album.mensajes.push(msg);
    clearTimeout(album.timer);
    album.timer = setTimeout(async () => {
      albumesEnCurso.delete(clave);
      const mensajes = album.mensajes.sort((a, b) => a.message_id - b.message_id);
      const caption = mensajes.find(m => m.caption)?.caption ?? null;
      const esCartola = cartolas?.esFotoDeCartola(msg.chat.id, { caption, mediaGroupId: msg.media_group_id });
      for (const m of mensajes) {
        try {
          await procesarMensaje(esCartola ? { ...m, caption } : m);
        } catch (error) {
          console.error('Error en el manejador de mensajes:', error.code ?? error.name);
          try {
            await enviar(m.chat.id, 'Ocurrió un error al procesar ese mensaje. Inténtalo de nuevo.');
          } catch {
            // si ni el aviso sale, no hay más que hacer
          }
        }
      }
    }, ESPERA_ALBUM_MS);
    return true;
  }

  // Manejador de mensajes de texto (registro de transacciones)
  bot.on('message', async (msg) => {
    // Fotos de un álbum: se junta el álbum completo antes de decidir si son cartolas o comprobantes
    if (msg.photo && msg.media_group_id && esChatAutorizado(msg.chat.id) && juntarAlbum(msg)) return;

    const hasta = secuenciaPreguntas;
    try {
      await procesarMensaje(msg);
      // Lo escrito responde a las preguntas que habían quedado abiertas: se les quitan los botones y se deja la respuesta
      if (msg.text && !msg.text.startsWith('/') && esChatAutorizado(msg.chat.id)) {
        await limpiarPreguntas(msg.chat.id, { hasta, respuesta: msg.text });
      }
    } catch (error) {
      // Nunca en silencio: se registra (sin el texto, que puede traer datos personales) y se avisa
      console.error('Error en el manejador de mensajes:', error.code ?? error.name);
      try {
        await enviar(msg.chat.id, 'Ocurrió un error al procesar ese mensaje. Inténtalo de nuevo.');
      } catch {
        // si ni el aviso sale, no hay más que hacer
      }
    }
  });

  async function procesarMensaje(msg) {
    const chatId = msg.chat.id;

    // Los comandos los atienden sus propios manejadores; uno que no existe se avisa en vez de quedarse en silencio
    if (msg.text && msg.text.startsWith('/')) {
      const nombre = /^\/([a-z0-9_]+)/i.exec(msg.text)?.[1]?.toLowerCase();
      if (nombre && esChatAutorizado(chatId)) {
        if (!COMANDOS_CONOCIDOS.has(nombre)) {
          await enviar(chatId, 'No conozco ese comando. Escribe /help para ver lo que puedo hacer, o cuéntame lo que necesitas con tus palabras.');
        } else if (!algunComandoLoAtiende(msg.text)) {
          // El comando existe pero lo que le pusieron detrás no lo entiende ninguno de sus manejadores
          await enviar(chatId, `No entendí lo que escribiste después de /${nombre}. Prueba /${nombre} solo, o escribe /help para ver cómo se usa.`);
        }
      }
      return;
    }

    if (!esChatAutorizado(chatId)) {
      if (msg.text && !msg.text.startsWith('/miid')) {
        await enviar(chatId, '❌ No estás autorizado para usar este bot. Usa /miid para obtener tu chat ID.');
      }
      return;
    }

    // Foto de una cartola (caption "cartola de la 8263", álbum o texto justo antes): se lee con OCR como una cartola más
    if (msg.photo && cartolas?.esFotoDeCartola(chatId, { caption: msg.caption, mediaGroupId: msg.media_group_id }) && await manejarFotoCartola(msg)) {
      return;
    }

    // Foto o documento con un pago de cuota (caption) o foto sin caption con compras en cuotas
    // Captura del comprobante de una transferencia a quien le pagas una compra en cuotas (OCR local)
    if (msg.photo && terceros && await terceros.manejarFoto(msg)) {
      return;
    }

    if ((msg.document || msg.photo) && cuotas && await cuotas.manejarEnvio(msg)) {
      return;
    }

    // Manejar archivos (cartolas)
    if (msg.document) {
      await manejarArchivo(msg);
      return;
    }

    if (msg.photo) {
      // Foto con caption que es un gasto ("almuerzo 5500"): se registra y la foto queda de respaldo
      if (await manejarFotoConGasto(msg)) return;
      await manejarFoto(msg);
      return;
    }

    // "son de la tarjeta 8263", "cartola de la 8263": texto sobre las cartolas que mandé o voy a mandar
    if (msg.text && !msg.reply_to_message && cartolas && await cartolas.manejarTexto(chatId, msg.text)) {
      return;
    }

    // Frase de confirmación de /reset o de la restauración de un respaldo
    if (msg.text && reset && await reset.manejarTexto(msg)) {
      return;
    }

    // Respuesta a la lista de cargos de la cartola de una tarjeta ajena: "el 2 y el 5 son míos"
    if (msg.text && msg.reply_to_message && terceros && await terceros.manejarReply(msg)) {
      return;
    }

    // Respuesta (reply) al mensaje de /cuentas: corregir un titular o el vínculo tarjeta-cuenta
    if (msg.text && msg.reply_to_message && vistaCuentas && await vistaCuentas.manejarReply(msg)) {
      return;
    }

    // Respuesta (reply) a un mensaje que creó un registro: eliminar, corregir o deshacer
    if (msg.text && msg.reply_to_message && registros && await registros.manejarReply(msg)) {
      return;
    }

    // Nombre nuevo para una cuenta pendiente (botón "Editar nombre")
    if (msg.text && await manejarNombreCuentaPendiente(msg)) {
      return;
    }

    // Nombre de la persona de un préstamo pendiente de confirmar
    if (msg.text && await manejarPersonaPrestamo(msg)) {
      return;
    }

    // Respuesta a una pregunta del alta de una compra en cuotas
    if (msg.text && cuotas && await cuotas.manejarTexto(msg)) {
      return;
    }

    // Respuesta pendiente de administración (monto de un movimiento, plan, gastos fijos)
    if (msg.text && admin && await admin.manejarTexto(msg)) {
      return;
    }

    // Valor nuevo de un campo de /editarcuenta (nombre, banco, titular, dígitos)
    if (msg.text && editarCuenta && await editarCuenta.manejarTexto(msg)) {
      return;
    }

    // Respuesta a "¿De cuánto es?" o "¿Cómo se llama?" de un gasto fijo incompleto
    if (msg.text && await manejarRespuestaFijo(msg)) {
      return;
    }

    // Respuesta a una pregunta de /savetrans (RUT, número, titular...)
    if (msg.text && await manejarRespuestaDato(msg)) {
      return;
    }

    // Un número solo corrige el monto del movimiento pendiente
    if (msg.text && await actualizarMontoPendiente(msg)) {
      return;
    }

    // Mensaje libre sin comando: el enrutador de intenciones lo entiende (reglas y, si no alcanzan,
    // Gemini) y lo manda a la función que corresponde, o pregunta con botones
    if (msg.text) {
      try {
        await intenciones.manejarTexto(msg);
      } catch (error) {
        console.error('Error al interpretar el mensaje:', error.code ?? error.name);
        await enviar(chatId, 'No pude procesar ese mensaje. Inténtalo de nuevo.');
      }
      return;
    }

    // Stickers, notas de voz, videos, ubicaciones...: no se entienden, pero se responde
    if (msg.sticker || msg.voice || msg.audio || msg.video || msg.video_note || msg.animation || msg.location || msg.contact || msg.poll) {
      await enviar(chatId, 'Solo entiendo texto, fotos y archivos (cartolas en PDF, CSV o Excel). Cuéntame con palabras lo que necesitas o escribe /help.');
    }
  }

  // Manejador de callbacks (botones inline)
  bot.on('callback_query', async (cb) => {
    const hasta = secuenciaPreguntas;
    try {
      await procesarCallback(cb);
      // Al tocar un botón, las preguntas abiertas de ese mismo flujo pierden su Cancelar
      if (cb.message && esChatAutorizado(cb.message.chat.id)) {
        await limpiarPreguntas(cb.message.chat.id, { hasta, flujo: flujoDe(cb.data), excepto: cb.message.message_id });
      }
    } catch (error) {
      console.error('Error en el manejador de botones:', error.code ?? error.name);
    }
    // Un botón que ningún módulo respondió (venció, o ya no tiene estado) nunca queda girando: se avisa
    if (!callbacksRespondidos.has(cb.id)) {
      await responderCallback(cb.id, { text: 'Este botón ya expiró, vuelve a intentarlo' });
      // Un botón muerto no se queda en el mensaje
      if (cb.message) {
        olvidarPregunta(cb.message.chat.id, cb.message.message_id);
        try {
          await bot.editMessageReplyMarkup({ inline_keyboard: [] }, { chat_id: cb.message.chat.id, message_id: cb.message.message_id });
        } catch (err) {
          logErrorTelegram('quitar botones', err);
        }
      }
    }
  });

  async function procesarCallback(cb) {
    const chatId = cb.message.chat.id;
    const data = cb.data;

    if (!esChatAutorizado(chatId)) {
      await responderCallback(cb.id, { text: '❌ No autorizado' });
      return;
    }

    // Botones de compras en cuotas
    if (cuotas && await cuotas.manejarCallback(cb, chatId, data)) {
      return;
    }

    // Botones del enrutador de intenciones (qué quisiste decir, monto faltante)
    if (intenciones && await intenciones.manejarCallback(cb, chatId, data)) {
      return;
    }

    // Botones de /reboot y /update
    if (sistema && await sistema.manejarCallback(cb, chatId, data)) {
      return;
    }

    // Botones de la clasificación de transferencias (gasto, préstamo, pago, cuotas)
    if (transferencias && await transferencias.manejarCallback(cb, chatId, data)) {
      return;
    }

    // Botones del lote de una tarjeta ajena (cartola y comprobante)
    if (terceros && await terceros.manejarCallback(cb, chatId, data)) {
      return;
    }

    // Botones de /editarcuenta (y el botón Editar de /cuentas)
    if (editarCuenta && await editarCuenta.manejarCallback(cb, chatId, data)) {
      return;
    }

    // Botones de las correcciones de /cuentas
    if (vistaCuentas && await vistaCuentas.manejarCallback(cb, chatId, data)) {
      return;
    }

    // Botones de /reset y de restaurar un respaldo
    if (reset && await reset.manejarCallback(cb, chatId, data)) {
      return;
    }

    // Botones de eliminar / corregir / deshacer registros
    if (registros && await registros.manejarCallback(cb, chatId, data)) {
      return;
    }

    // Botones de importación de cartolas
    if (cartolas && await cartolas.manejarCallback(cb, chatId, data)) {
      return;
    }

    // Botones de administración (movimientos, reglas, pagos, plan)
    if (admin && await admin.manejarCallback(cb, chatId, data)) {
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

    // Botones de gastos fijos (/fijo)
    if (await manejarCallbackFijos(cb, chatId, data)) {
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
      if (tx.es_prestamo && !tx.persona) {
        await responderCallback(cb.id, { text: 'Falta indicar la persona del préstamo' });
        return;
      }

      try {
        const movimientoId = await guardarMovimiento(tx);
        pendingTransactions.delete(txId);
        await vincularMensajes(chatId, [tx.mensajeUsuarioId, cb.message.message_id], 'movimiento', movimientoId);
        const lineaPlan = await lineaDisponiblePlan(tx);

        await editar(
          `✅ <b>Movimiento guardado</b>\n\n` +
          `${tx.tipo === 'cargo' ? '💸' : '💰'} $${formatearMonto(tx.monto)}\n` +
          `📝 ${esc(tx.descripcion)}\n` +
          `Tipo: ${esc(ETIQUETAS_TIPO[tx.tipo_movimiento] ?? tx.tipo_movimiento)}\n` +
          `📅 ${formatearFechaCL(tx.fecha)}\n` +
          (tx.cuentaDestinoNombre ? `Cuenta destino: ${esc(tx.cuentaDestinoNombre)}\n` : '') +
          (tx.es_prestamo && tx.persona ? `Préstamo a: ${esc(tx.persona)}\n` : '') +
          `🏷 ${esc(tx.categoria || 'Sin categoría')}` + lineaPlan,
          {
            chat_id: chatId,
            message_id: cb.message.message_id
          }
        );

        await responderCallback(cb.id, { text: '✅ Guardado' });

        // Transferencia a un tercero: ¿pago de cuotas, gasto, préstamo o pago? (se recuerda por destinatario)
        let sinTratar = true;
        if (tx.tipo_movimiento === 'transferencia_terceros' && transferencias) {
          const restantes = await transferencias.procesarMovimientos(
            chatId,
            [{ id: movimientoId, fecha: tx.fecha, descripcion: tx.descripcion, monto: tx.monto, tipo: tx.tipo }],
            { cuentaId: tx.cuenta_id }
          );
          sinTratar = restantes.length > 0;
        }
        // Si parece el pago de una cuota (alias de la cartola), se pregunta; nunca se asigna sola
        if (sinTratar && tx.tipo_movimiento === 'transferencia_terceros' && cuotas) {
          await cuotas.ofrecerPagoPorCartola(chatId, { id: movimientoId, descripcion: tx.descripcion });
        }
      } catch (error) {
        // Mensaje de la BD para diagnosticar (p. ej. "NOT NULL constraint failed: movimientos.cuenta_id")
        console.error('Error al guardar movimiento:', error.code ?? '', error.message);
        await responderCallback(cb.id, { text: '❌ Error al guardar' });
      }
    }

    // Cancelar transacción
    if (data.startsWith('cancel_')) {
      const txId = data.replace('cancel_', '');
      const cancelada = pendingTransactions.get(txId);
      pendingTransactions.delete(txId);
      if (cancelada?.archivo_respaldo) await eliminarRespaldoCuota(cancelada.archivo_respaldo);

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

    // Préstamo en la confirmación: marcar, quitar o indicar la persona
    if (data.startsWith('prm_') || data.startsWith('prq_') || data.startsWith('prp_')) {
      const accion = data.slice(0, 3);
      const txId = data.slice(4);
      const tx = pendingTransactions.get(txId);
      if (!tx) {
        await responderCallback(cb.id, { text: '❌ Transacción expirada' });
        return;
      }

      if (accion === 'prq') {
        tx.es_prestamo = false;
        tx.persona = null;
        await refrescarConfirmacion(chatId, cb.message.message_id, txId, tx);
        await responderCallback(cb.id, { text: 'Ya no es préstamo' });
        return;
      }

      if (accion === 'prm') {
        tx.es_prestamo = true;
        await refrescarConfirmacion(chatId, cb.message.message_id, txId, tx);
      }
      if (!tx.persona) {
        esperandoPersona.set(chatId, txId);
        await enviar(chatId, 'Escribe el nombre de la persona a quien le prestaste.');
      }
      await responderCallback(cb.id, {});
      return;
    }

    // Cambiar la cuenta del movimiento pendiente: lista de cuentas activas
    if (data.startsWith('tcm_')) {
      const txId = data.replace('tcm_', '');
      const tx = pendingTransactions.get(txId);
      if (!tx) {
        await responderCallback(cb.id, { text: '❌ Transacción expirada' });
        return;
      }
      const cuentasActivas = await listarCuentas();
      const filas = [];
      for (let i = 0; i < cuentasActivas.length; i += 2) {
        filas.push(cuentasActivas.slice(i, i + 2).map(c => ({
          text: String(c.nombre).slice(0, 30),
          callback_data: `tcs_${txId}_${c.id}`
        })));
      }
      filas.push([{ text: 'Volver', callback_data: `tback_${txId}` }]);
      await editar(textoConfirmacion(tx), {
        chat_id: chatId,
        message_id: cb.message.message_id,
        reply_markup: { inline_keyboard: filas }
      });
      await responderCallback(cb.id, { text: 'Elige la cuenta' });
      return;
    }

    if (data.startsWith('tcs_')) {
      const partes = data.match(/^tcs_(.+)_(\d+)$/);
      const tx = partes && pendingTransactions.get(partes[1]);
      if (!tx) {
        await responderCallback(cb.id, { text: '❌ Transacción expirada' });
        return;
      }
      const cuenta = (await listarCuentas()).find(c => String(c.id) === partes[2]);
      if (cuenta && cuenta.id !== tx.cuenta_destino_id) {
        tx.cuenta_id = cuenta.id;
        tx.cuentaNombre = cuenta.nombre;
      }
      await refrescarConfirmacion(chatId, cb.message.message_id, partes[1], tx);
      await responderCallback(cb.id, { text: cuenta ? 'Cuenta cambiada' : 'Cuenta no válida' });
      return;
    }

    // Corregir: se descarta este borrador y se espera el movimiento escrito de nuevo
    if (data.startsWith('tco_')) {
      const txId = data.replace('tco_', '');
      const tx = pendingTransactions.get(txId);
      pendingTransactions.delete(txId);
      if (tx?.archivo_respaldo) {
        // La foto sigue esperando el texto corregido
        await eliminarRespaldoCuota(tx.archivo_respaldo);
        if (tx.comprobanteInfo) {
          esperandoComprobante.set(chatId, { ...tx.comprobanteInfo, hasta: Date.now() + 10 * 60 * 1000 });
        }
      }
      await editar('Escribe de nuevo el movimiento, por ejemplo: almuerzo 5500 débito.', {
        chat_id: chatId,
        message_id: cb.message.message_id
      });
      await responderCallback(cb.id, {});
      return;
    }

    // Cancelar la espera de un comprobante de gasto
    if (data === 'trc_x') {
      esperandoComprobante.delete(chatId);
      await editar('Cancelado', { chat_id: chatId, message_id: cb.message.message_id });
      await responderCallback(cb.id, { text: 'Cancelado' });
      return;
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
        } else {
          // Pagos de tarjeta y transferencias propias no son préstamos
          tx.es_prestamo = false;
          tx.persona = null;
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
  }
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
    (tx.es_prestamo ? `Préstamo: ${tx.persona ? `a ${esc(tx.persona)}` : 'falta indicar la persona'}\n` : '') +
    `📝 ${esc(tx.descripcion)}\n` +
    `📅 ${formatearFechaCL(tx.fecha)}\n` +
    (conDestino
      ? `Cuenta origen: ${esc(tx.cuentaNombre ?? 'sin indicar')}\n` +
        `Cuenta destino: ${tx.cuentaDestinoNombre ? esc(tx.cuentaDestinoNombre) : 'sin indicar'}\n`
      : `Cuenta: ${esc(tx.cuentaNombre ?? 'sin indicar')}\n`) +
    `💳 Medio de pago: ${tx.medioPago ? esc(tx.medioPago) : 'sin indicar'}\n` +
    `🏷 Categoría: ${tx.categoria ? esc(tx.categoria) : 'sin categoría'}\n` +
    (tx.archivo_respaldo ? 'Respaldo adjunto\n' : '') +
    `${tx.confianzaBaja ? '\nNo estoy del todo seguro de haberte entendido: revisa los datos o toca Corregir.' : ''}` +
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
    const faltaPersona = tx.es_prestamo && !tx.persona;
    filas.push(
      faltaPersona
        ? [
            { text: 'Indicar persona', callback_data: `prp_${txId}` },
            { text: '❌ Cancelar', callback_data: `cancel_${txId}` }
          ]
        : [
            { text: '✅ Guardar', callback_data: `save_${txId}` },
            { text: '❌ Cancelar', callback_data: `cancel_${txId}` }
          ]
    );
    filas.push([
      { text: 'Cambiar tipo', callback_data: `tmenu_${txId}` },
      tx.es_prestamo
        ? { text: 'Quitar préstamo', callback_data: `prq_${txId}` }
        : { text: 'Marcar como préstamo', callback_data: `prm_${txId}` }
    ]);
    filas.push([
      { text: 'Cambiar cuenta', callback_data: `tcm_${txId}` },
      ...(tx.confianzaBaja ? [{ text: 'Corregir', callback_data: `tco_${txId}` }] : [])
    ]);
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

/** Si se esperaba la persona de un préstamo, usa este mensaje como nombre. true si lo consumió. */
async function manejarPersonaPrestamo(msg) {
  const chatId = msg.chat.id;
  const txId = esperandoPersona.get(chatId);
  if (!txId) return false;

  const tx = pendingTransactions.get(txId);
  if (!tx) {
    esperandoPersona.delete(chatId);
    return false;
  }

  esperandoPersona.delete(chatId);
  tx.es_prestamo = true;
  tx.persona = await canonizarPersona(msg.text.trim().slice(0, 100));
  if (!tx.descripcion || /^Préstamo a /.test(tx.descripcion)) tx.descripcion = `Préstamo a ${tx.persona}`;

  const editado = tx.messageId ? await refrescarConfirmacion(chatId, tx.messageId, txId, tx) : null;
  if (!editado) {
    const enviado = await enviar(chatId, textoConfirmacion(tx), await armarTeclado(txId, tx));
    tx.messageId = enviado?.message_id ?? tx.messageId;
  }
  return true;
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
  const [cuentas] = await query('SELECT id, nombre, tipo, activa, predeterminada FROM cuentas WHERE activa = 1 ORDER BY creado_en ASC, id ASC');
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
async function interpretarConGemini(texto, cuentas, chatId) {
  if (!geminiDisponible()) return null;
  // Máximo 30 llamadas por hora por chat; al pasarlo se sigue solo con las reglas
  if (!limitadorGemini.consumir(chatId)) return null;

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
async function registrarTransaccion(msg, { confianzaBaja = false } = {}) {
  const chatId = msg.chat.id;
  const texto = msg.text;

  try {
    const cuentas = await listarCuentas();
    let datos = parsearMensaje(texto, { cuentas });

    // Respaldo: si las reglas no encontraron monto o categoría, consultar Gemini
    if (!datos.monto || !datos.categoriaDetectada) {
      const ia = await interpretarConGemini(texto, cuentas, chatId);
      if (ia) datos = combinarConGemini(datos, ia);
    }

    if (!datos.monto) {
      await enviar(chatId, '❌ No pude detectar un monto válido en el mensaje.\n\nEjemplo: "ayer pagué 12.500 en el super"');
      return;
    }

    if (cuentas.length === 0) {
      await enviar(chatId,
        '❌ No hay ninguna cuenta registrada, así que no puedo guardar el movimiento.\n\n' +
        'Crea una con /savecard (por ejemplo: /savecard efectivo) y vuelve a enviar el mensaje.'
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
      // Cuenta según el medio de pago, la última cuenta usada o la cuenta por defecto (sin preguntar;
      // el botón "Cambiar cuenta" permite corregirla)
      cuenta = elegirCuenta(cuentas, datos.medioPago) || await ultimaCuentaUsada(cuentas) || cuentaPorDefecto(cuentas);
    }

    // Buscar categoría por nombre detectado
    let categoriaId = null;
    let categoriaNombre = null;
    // Primero las reglas de autocategorización (las de la web y las de /regla)
    const porRegla = await categoriaPorReglas(texto);
    if (porRegla) {
      categoriaId = porRegla.id;
      categoriaNombre = porRegla.nombre;
    } else if (datos.categoriaDetectada) {
      const [categorias] = await query(
        'SELECT id, nombre FROM categorias WHERE LOWER(nombre) = ? LIMIT 1',
        [datos.categoriaDetectada.toLowerCase()]
      );
      if (categorias.length > 0) {
        categoriaId = categorias[0].id;
        categoriaNombre = categorias[0].nombre;
      }
    }

    // Préstamo: "le pagué 15 mil a Christian con la CMR, me lo devuelve"
    let esPrestamo = false;
    let persona = null;
    let descripcion = datos.descripcion;
    if (datos.tipo === 'cargo' && !requiereDestino(datos.tipoMovimiento)) {
      const prestamo = detectarPrestamo(texto);
      if (prestamo.esPrestamo) {
        esPrestamo = true;
        persona = prestamo.persona ? await canonizarPersona(prestamo.persona) : null;
        if (persona) descripcion = `Préstamo a ${persona}`;
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
      descripcion,
      monto: datos.monto,
      tipo: datos.tipo,
      tipo_movimiento: datos.tipoMovimiento,
      es_prestamo: esPrestamo,
      persona,
      categoria_id: categoriaId,
      categoria: categoriaNombre,
      medioPago: datos.medioPago,
      aproximado: datos.aproximado,
      confianzaBaja,
      archivo_respaldo: null,
      messageId: null,
      // Mensaje de Juan que originó el gasto (para poder eliminarlo o corregirlo respondiéndole)
      mensajeUsuarioId: msg.message_id ?? null
    };

    // Foto sin texto que esperaba este gasto: queda como su respaldo (se borra si se cancela)
    const comprobante = esperandoComprobante.get(chatId);
    if (comprobante && Date.now() <= comprobante.hasta) {
      try {
        tx.archivo_respaldo = await guardarRespaldoCuota(comprobante.fileId, comprobante.nombre, 'respaldo_');
        tx.comprobanteInfo = { fileId: comprobante.fileId, nombre: comprobante.nombre };
        esperandoComprobante.delete(chatId);
      } catch (error) {
        logErrorTelegram('guardar comprobante', error);
        await enviar(chatId, 'No pude guardar la foto, así que sigo sin respaldo.');
      }
    }

    pendingTransactions.set(txId, tx);

    // Mostrar confirmación
    const enviado = await enviar(chatId, textoConfirmacion(tx), await armarTeclado(txId, tx));
    tx.messageId = enviado?.message_id ?? null;

    // Limpiar transacciones antiguas (más de 5 minutos) y su respaldo si nunca se guardó
    setTimeout(async () => {
      const pendiente = pendingTransactions.get(txId);
      pendingTransactions.delete(txId);
      if (pendiente?.archivo_respaldo) await eliminarRespaldoCuota(pendiente.archivo_respaldo);
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
  const [resultado] = await query(
    `INSERT INTO movimientos (cuenta_id, cuenta_destino_id, fecha, descripcion, monto, tipo, tipo_movimiento, categoria_id,
                              es_prestamo, persona_prestamo, archivo_respaldo)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    // categoria_id y cuenta_destino_id pueden ser null; undefined no es válido para el driver
    [
      tx.cuenta_id,
      tx.cuenta_destino_id ?? null,
      tx.fecha,
      tx.descripcion,
      tx.monto,
      tx.tipo,
      tx.tipo_movimiento ?? 'compra',
      tx.categoria_id ?? null,
      tx.es_prestamo && tx.persona ? 1 : 0,
      tx.es_prestamo && tx.persona ? tx.persona : null,
      tx.archivo_respaldo ?? null
    ]
  );
  return resultado.insertId;
}

/** Cuenta desde la que se paga una cuota: la del medio de pago mencionado o la por defecto */
async function resolverCuentaPago(medioPago) {
  const cuentas = await listarCuentas();
  if (cuentas.length === 0) return null;
  return elegirCuenta(cuentas, medioPago) || await ultimaCuentaUsada(cuentas) || cuentaPorDefecto(cuentas);
}

/**
 * Cuenta del último movimiento que registraste a mano (sin contar importaciones de cartolas ni pagos
 * de cuotas), si sigue activa. null si no hay ninguno.
 */
async function ultimaCuentaUsada(cuentas) {
  // La cuenta que Juan marcó como predeterminada (/editarcuenta) manda sobre la última usada
  const fija = cuentas.find(c => Number(c.predeterminada) === 1);
  if (fija) return fija;
  try {
    const [filas] = await query(
      `SELECT cuenta_id FROM movimientos
       WHERE importado_de IS NULL AND compra_cuota_id IS NULL
       ORDER BY creado_en DESC, id DESC
       LIMIT 20`
    );
    for (const fila of filas) {
      const cuenta = cuentas.find(c => Number(c.id) === Number(fila.cuenta_id));
      if (cuenta) return cuenta;
    }
  } catch (error) {
    console.error('Error al buscar la última cuenta usada:', error.code ?? error.name);
  }
  return null;
}

/**
 * Guarda el comprobante de un pago de cuota en <FINANZAS_STORAGE>/comprobantes/{YYYY-MM}/
 * (ver storage.js). No se lee el contenido ni se envía a ningún servicio. Devuelve la ruta
 * relativa a la raíz, que es lo que se guarda en archivo_respaldo.
 */
async function guardarRespaldoCuota(fileId, nombreSugerido, prefijo = 'respaldo_cuota_') {
  const fileLink = await bot.getFileLink(fileId);
  const respuesta = await fetch(fileLink);
  if (!respuesta.ok) throw new Error('la descarga del archivo falló');

  const guardado = await guardarBuffer('comprobantes', nombreSugerido, Buffer.from(await respuesta.arrayBuffer()), {
    prefijo: `${prefijo}${Date.now()}_`
  });
  return guardado.ruta;
}

/** Descarga un archivo de Telegram a memoria (para leer una captura con OCR local) */
async function descargarBuffer(fileId) {
  const fileLink = await bot.getFileLink(fileId);
  const respuesta = await fetch(fileLink);
  if (!respuesta.ok) throw new Error('la descarga del archivo falló');
  return Buffer.from(await respuesta.arrayBuffer());
}

/**
 * Una foto sin texto que es el comprobante de un gasto: espera el texto del gasto (por ejemplo
 * "almuerzo 5500 débito") y entonces queda como su respaldo.
 */
async function iniciarComprobanteGasto(chatId, info) {
  esperandoComprobante.set(chatId, { ...info, hasta: Date.now() + 10 * 60 * 1000 });
  await enviar(chatId,
    'Escribe el gasto de ese comprobante, por ejemplo: almuerzo 5500 débito. Guardo la foto como respaldo.',
    { reply_markup: { inline_keyboard: [[{ text: 'Cancelar', callback_data: 'trc_x' }]] } }
  );
}

/** Borra un respaldo guardado (si el pago se cancela); nunca lanza */
async function eliminarRespaldoCuota(ruta) {
  await borrarArchivo(ruta);
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
    `Cuenta terminada en: ${datos.ultimos4Cuenta ? esc(datos.ultimos4Cuenta) : 'sin indicar'}`,
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
    ultimos4Cuenta: reglas.ultimos4Cuenta ?? null,
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
    : datos.ultimos4Cuenta
    ? await query(
        `SELECT id, nombre FROM cuentas
         WHERE activa = 1 AND tipo = ? AND COALESCE(LOWER(banco), '') = ? AND ultimos4_cuenta = ?
         LIMIT 1`,
        [tipoDb, banco, datos.ultimos4Cuenta]
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
  // Red de seguridad: un nombre que es solo dígitos nunca llega a la tabla
  if (esNombreSoloDigitos(datos.nombre)) {
    datos.nombre = nombreAutomatico({ tipo: datos.tipo, titular: datos.titular, ultimos4: datos.ultimos4, ultimos4Cuenta: datos.ultimos4Cuenta });
  }
  // Nunca se guarda el número completo: solo los últimos 4 (ultimos4 de la tarjeta, ultimos4_cuenta de la cuenta)
  const [insercion] = await query(
    `INSERT INTO cuentas (nombre, tipo, banco, ultimos4, ultimos4_cuenta, titular, cupo_total, dia_vencimiento)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      datos.nombre,
      TIPO_DB[datos.tipo],
      datos.banco ?? null,
      datos.ultimos4 ?? null,
      datos.ultimos4Cuenta ?? null,
      datos.titular ?? null,
      datos.tipo === 'credito' ? (datos.cupo ?? null) : null,
      datos.tipo === 'credito' ? (datos.diaPago ?? null) : null
    ]
  );
  return insercion.insertId;
}

async function listarCuentasActivas() {
  const [filas] = await query(
    'SELECT id, nombre, tipo, banco, ultimos4, ultimos4_cuenta FROM cuentas WHERE activa = 1 ORDER BY creado_en ASC, id ASC'
  );
  return filas;
}

function lineaCuenta(cuenta, prefijo = '') {
  return (
    `${prefijo}<b>${esc(cuenta.nombre)}</b> - ${esc(ETIQUETAS_TIPO_DB[cuenta.tipo] ?? cuenta.tipo)}` +
    `${cuenta.banco ? ' - ' + esc(cuenta.banco) : ''}` +
    `${cuenta.ultimos4 ? ' - terminada en ' + esc(cuenta.ultimos4) : ''}` +
    `${cuenta.ultimos4_cuenta ? ' - cuenta terminada en ' + esc(cuenta.ultimos4_cuenta) : ''}`
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

/** Lista de cuentas activas numeradas (/cuentas y "qué cuentas tengo") */
async function enviarCuentas(chatId) {
  // Vista completa: cuentas con vínculos, cuotas, categorías y totales (vistaCuentasBot.js)
  await vistaCuentas.responder(chatId);
}

// Cuentas ya existentes a las que se les ofrece cambiar el titular: clave -> { cuentaId, nombre, titular }
const pendingActualizacionTitular = new Map();

/** Cuenta activa que ya tiene esos 4 dígitos (de la tarjeta o del número de cuenta, según lo que se guarda) */
async function buscarCuentaPorDigitos(datos) {
  const digitos = datos.ultimos4 ?? datos.ultimos4Cuenta;
  if (!digitos) return null;
  const columna = datos.ultimos4 ? 'ultimos4' : 'ultimos4_cuenta';
  const [filas] = await query(`SELECT id, nombre, titular FROM cuentas WHERE activa = 1 AND ${columna} = ? LIMIT 1`, [digitos]);
  return filas[0] ?? null;
}

/**
 * Guarda una cuenta o tarjeta a partir de un texto: lo que sigue a /savecard o una frase natural ("guarda la tarjeta
 * crédito 8263 es de Valeska"). Es el mismo flujo en los dos casos: se interpreta con parsearCuenta, se muestra un
 * resumen con Guardar y Cancelar y se pregunta lo que falte (por ejemplo el tipo). En la frase natural no se usa
 * Gemini, el titular sin decir es TITULAR_POR_DEFECTO y, si ya hay una cuenta con esos 4 dígitos, se ofrece
 * actualizar su titular en vez de duplicarla.
 */
async function procesarCuentaDesdeTexto(msg, texto, { natural = false, numeroLargo = false } = {}) {
  const chatId = msg.chat.id;
  try {
    let datos = parsearCuenta(texto);

    // Si el mensaje traía un número de tarjeta completo, se borra del chat (solo se guardan los últimos 4)
    if (datos.numeroCompletoRechazado || numeroLargo) {
      await borrarMensaje(chatId, msg.message_id);
    }

    if (natural) {
      // Sin titular dicho: el titular por defecto; una tarjeta ajena se nombra por su dueña ("Tarjeta de Valeska")
      if (!datos.titular) datos.titular = valorTitular('yo');
      // Sin un nombre dado: uno automático con el tipo, el titular y los 4 dígitos ("Crédito Valeska ****8263")
      if (datos.tipo && (!datos.nombre || datos.nombre === nombrePorDefecto(datos.tipo, datos.banco))) {
        datos.nombre = nombreAutomatico({ tipo: datos.tipo, titular: datos.titular, ultimos4: datos.ultimos4, ultimos4Cuenta: datos.ultimos4Cuenta });
      }

      const existente = await buscarCuentaPorDigitos(datos);
      if (existente) {
        await ofrecerActualizarTitular(chatId, existente, datos);
        return;
      }
    } else if (!datos.tipo) {
      // Respaldo: Gemini si las reglas no identifican el tipo
      const ia = await interpretarCuenta(texto);
      if (ia) datos = combinarCuenta(datos, ia);
    }

    // El nombre nunca es solo dígitos (eso es el número de la tarjeta): si no se dio uno, se arma uno automático
    if (datos.tipo && esNombreSoloDigitos(datos.nombre)) {
      datos.nombre = nombreAutomatico({ tipo: datos.tipo, titular: datos.titular, ultimos4: datos.ultimos4, ultimos4Cuenta: datos.ultimos4Cuenta });
    }

    const key = `${chatId}_${Date.now()}`;
    pendingCuentas.set(key, { datos, natural, mensajeUsuarioId: msg.message_id ?? null });
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
}

/** Ya existe una cuenta con esos 4 dígitos: se ofrece cambiarle el titular en lugar de crear otra */
async function ofrecerActualizarTitular(chatId, existente, datos) {
  const mismo = normalizar(existente.titular ?? '').trim() === normalizar(datos.titular ?? '').trim();
  if (mismo) {
    await enviar(chatId,
      `Ya tienes <b>${esc(existente.nombre)}</b> terminada en ${esc(datos.ultimos4 ?? datos.ultimos4Cuenta)} con titular ${esc(existente.titular)}. No cambié nada.`
    );
    return;
  }
  const key = `${chatId}_${Date.now()}`;
  pendingActualizacionTitular.set(key, { cuentaId: existente.id, nombre: existente.nombre, titular: datos.titular });
  setTimeout(() => pendingActualizacionTitular.delete(key), 5 * 60 * 1000);
  await enviar(chatId,
    `Ya tienes <b>${esc(existente.nombre)}</b> terminada en ${esc(datos.ultimos4 ?? datos.ultimos4Cuenta)}` +
    `${existente.titular ? ` (titular: ${esc(existente.titular)})` : ' (sin titular)'}. ` +
    `¿Le cambio el titular a <b>${esc(datos.titular)}</b> en vez de crear otra cuenta?`,
    {
      reply_markup: {
        inline_keyboard: [[
          { text: 'Sí, actualizar titular', callback_data: `ncu_${key}` },
          { text: 'No', callback_data: `ncv_${key}` }
        ]]
      }
    }
  );
}

/** Cómo guardar una cuenta con una frase (cuando el mensaje habla de una cuenta pero no se entendió) */
async function enviarAyudaGuardarCuenta(chatId) {
  await enviar(chatId,
    '<b>Guardar una cuenta o tarjeta</b>\n\n' +
    'Escríbelo como hablas, con los últimos 4 dígitos:\n' +
    '• guarda la tarjeta crédito 8263 es de Valeska Sanhueza\n' +
    '• agrega mi cuenta rut 1234 del banco estado\n' +
    '• nueva tarjeta débito 5555 de Juan\n' +
    '• la tarjeta 8263 es de Valeska\n\n' +
    'Si no dices el titular, uso el tuyo. Nunca mandes el número completo: solo guardo los últimos 4.'
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

    await procesarCuentaDesdeTexto(msg, texto);
  });

  // /cuentas: cuentas activas numeradas
  bot.onText(/^\/(?:cuentas|datosguardados)(?:@\w+)?\s*$/i, async (msg) => {
    const chatId = msg.chat.id;

    if (!esChatAutorizado(chatId)) {
      await enviar(chatId, 'No estás autorizado para usar este bot.');
      return;
    }

    await enviarCuentas(chatId);
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
  if (esNombreSoloDigitos(nombre)) {
    await enviar(chatId, 'El nombre no puede ser solo números. Escribe otro (por ejemplo: Crédito Valeska).');
    return true;
  }
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

  // Actualizar el titular de una cuenta que ya existe
  if (data.startsWith('ncu_') || data.startsWith('ncv_')) {
    const key = data.slice(4);
    const pendiente = pendingActualizacionTitular.get(key);
    pendingActualizacionTitular.delete(key);
    if (data.startsWith('ncv_')) {
      await editar('Entendido, no cambié nada.', { chat_id: chatId, message_id: messageId });
      await responderCallback(cb.id, { text: 'Cancelado' });
      return true;
    }
    if (!pendiente) {
      await responderCallback(cb.id, { text: 'Solicitud expirada' });
      return true;
    }
    try {
      const listo = await fijarTitular(pendiente.cuentaId, pendiente.titular);
      await editar(
        listo ? `Listo: el titular de <b>${esc(pendiente.nombre)}</b> ahora es <b>${esc(pendiente.titular)}</b>.` : 'No pude actualizarla: la cuenta ya no está activa.',
        { chat_id: chatId, message_id: messageId }
      );
      await responderCallback(cb.id, { text: listo ? 'Actualizado' : 'Sin cambios' });
    } catch (error) {
      console.error('Error al actualizar el titular:', error.code ?? '', error.message);
      await responderCallback(cb.id, { text: 'Error al guardar' });
    }
    return true;
  }

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

      const cuentaId = await guardarCuenta(pendiente.datos);
      pendingCuentas.delete(key);
      await vincularMensajes(chatId, [pendiente.mensajeUsuarioId, messageId], 'cuenta', cuentaId);
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
    // Sin nombre (o con uno que es solo dígitos): en una frase, el automático ("Crédito Valeska ****8263"); con /savecard, el de siempre
    if (!datos.nombre || esNombreSoloDigitos(datos.nombre)) {
      datos.nombre = pendiente.natural
        ? nombreAutomatico({ tipo, titular: datos.titular, ultimos4: datos.ultimos4, ultimos4Cuenta: datos.ultimos4Cuenta })
        : nombrePorDefecto(tipo, datos.banco);
    }

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

// ---------------------------------------------------------------------------
// Plan de ahorro: /plan, /fijo, /fijos y consultas sin comando
// ---------------------------------------------------------------------------

// Gastos fijos pendientes de confirmar: clave -> { datos }
const pendingFijos = new Map();

/** Monto en pesos con signo: -$12.345 */
function montoPlan(n) {
  return `${n < 0 ? '-' : ''}$${formatearMonto(Math.abs(n))}`;
}

function textoResumenPlan(r) {
  const mesNombre = new Date(r.mes.anio, r.mes.mes - 1).toLocaleString('es-CL', { month: 'long' });
  const lineas = [
    `<b>Plan de ahorro de ${esc(mesNombre)} ${r.mes.anio}</b>`,
    '',
    `Ingreso del mes: ${montoPlan(r.ingreso)} (${r.ingresoOrigen === 'base' ? 'base' : 'real'})`,
    `Meta de ahorro (${r.porcentajes.ahorro}%): ${montoPlan(r.metaAhorro)}`,
    `Gastos fijos: ${montoPlan(r.fijos.real)} (presupuesto ${r.porcentajes.fijos}%: ${montoPlan(r.fijos.presupuesto)})`,
    `Presupuesto libre: ${montoPlan(r.libre.presupuesto)}`,
    `Gastado libre: ${montoPlan(r.libre.gastado)} (${r.libre.porcentajeUsado}%)`,
    `Disponible para gastar: ${montoPlan(r.disponible)}`,
    `Disponible por día: ${montoPlan(r.disponiblePorDia)} (quedan ${r.mes.diasRestantes} días)`
  ];
  if (r.alertas.length > 0) {
    lineas.push('', '<b>Alertas:</b>', ...r.alertas.map(a => `- ${esc(a.mensaje)}`));
  }
  return lineas.join('\n');
}

async function responderPlan(chatId) {
  try {
    const { resumen } = await obtenerPlan();
    await enviar(chatId, textoResumenPlan(resumen));
  } catch (error) {
    console.error('Error al calcular el plan de ahorro:', error.code ?? error.name);
    await enviar(chatId, 'Error al calcular el plan de ahorro.');
  }
}

/**
 * Línea corta con lo que queda del mes, para agregar después de guardar un gasto.
 * Vacía si no aplica (no es un gasto libre) o si el plan no tiene ingresos; nunca lanza.
 */
async function lineaDisponiblePlan(tx) {
  try {
    if (tx.tipo !== 'cargo' || !TIPOS_GASTO_LIBRE.includes(tx.tipo_movimiento)) return '';
    const { resumen } = await obtenerPlan();
    if (resumen.ingreso <= 0) return '';
    return `\nDisponible este mes: ${montoPlan(resumen.disponible)}` +
      (resumen.disponible > 0 ? ` (${montoPlan(resumen.disponiblePorDia)} por día)` : '');
  } catch {
    return '';
  }
}

function textoConfirmacionFijo(datos) {
  return (
    '<b>Confirmar gasto fijo:</b>\n\n' +
    `Nombre: ${esc(datos.nombre)}\n` +
    `Monto: $${formatearMonto(datos.monto)}\n` +
    `Día de pago: ${datos.diaPago ?? 'sin indicar'}` +
    (datos.destinatario ? `\nSe le paga a: ${esc(datos.destinatario)}` : '') +
    (datos.palabrasClave ? `\nPalabras clave: ${esc(datos.palabrasClave)}` : '')
  );
}

// Gasto fijo al que le falta el monto o la descripción: chatId -> { datos, hasta }
const esperandoFijo = new Map();

/** Id del destinatario en destinatarios_transferencia si ya existe uno con ese nombre (enlace opcional) */
async function buscarDestinatarioId(nombre) {
  const clave = clavePorNombre(nombre);
  if (!clave) return null;
  const [filas] = await query('SELECT id FROM destinatarios_transferencia WHERE clave = ?', [clave]);
  return filas[0] ? Number(filas[0].id) : null;
}

/**
 * Lo que sigue a /fijo y a una frase como "gasto fijo: 24 mil en telefonía, lo pago a Vivian": si falta el monto o la
 * descripción lo pregunta; si ya existe un gasto fijo con esa descripción ofrece actualizar su monto en vez de duplicarlo;
 * si no, muestra el resumen con Guardar y Cancelar. `datos`: { nombre, monto, diaPago, destinatario, palabrasClave }.
 */
async function procesarGastoFijo(chatId, datos) {
  try {
    const falta = !datos.monto ? 'monto' : !datos.nombre ? 'nombre' : null;
    if (falta) {
      esperandoFijo.set(chatId, { datos, hasta: Date.now() + 5 * 60 * 1000 });
      await enviar(chatId,
        falta === 'monto'
          ? `¿De cuánto es el gasto fijo${datos.nombre ? ` <b>${esc(datos.nombre)}</b>` : ''}? Escribe el monto (por ejemplo 24 mil o 15.990).`
          : `¿Cómo se llama el gasto fijo de $${formatearMonto(datos.monto)}? Por ejemplo: telefonía, arriendo o netflix.`,
        { reply_markup: { inline_keyboard: [[{ text: 'Cancelar', callback_data: 'fjc_x' }]] } }
      );
      return;
    }
    esperandoFijo.delete(chatId);

    const existentes = await listarGastosFijos();
    const repetido = existentes.find(f => normalizar(f.nombre) === normalizar(datos.nombre));
    const key = `${chatId}_${Date.now()}`;
    pendingFijos.set(key, { datos, actualizarId: repetido?.id ?? null, existente: repetido ?? null });
    setTimeout(() => pendingFijos.delete(key), 5 * 60 * 1000);

    if (repetido) {
      const mismoMonto = Number(repetido.monto) === Number(datos.monto);
      await enviar(chatId,
        `Ya existe un gasto fijo llamado <b>${esc(repetido.nombre)}</b> ($${formatearMonto(repetido.monto)}). ` +
        (mismoMonto
          ? '¿Actualizo sus otros datos (día o a quién se le paga)?'
          : `¿Actualizo el monto a <b>$${formatearMonto(datos.monto)}</b> en vez de crear otro?`),
        {
          reply_markup: {
            inline_keyboard: [[
              { text: 'Sí, actualizar', callback_data: `fju_${key}` },
              { text: 'No', callback_data: `fjx_${key}` }
            ]]
          }
        }
      );
      return;
    }

    await enviar(chatId, textoConfirmacionFijo(datos), {
      reply_markup: {
        inline_keyboard: [[
          { text: 'Guardar', callback_data: `fjs_${key}` },
          { text: 'Cancelar', callback_data: `fjx_${key}` }
        ]]
      }
    });
  } catch (error) {
    console.error('Error al preparar el gasto fijo:', error.code ?? error.name);
    await enviar(chatId, 'Error al procesar el gasto fijo.');
  }
}

/** Respuesta a "¿De cuánto es?" o "¿Cómo se llama?" de un gasto fijo incompleto. true si consumió el mensaje. */
async function manejarRespuestaFijo(msg) {
  const chatId = msg.chat.id;
  const espera = esperandoFijo.get(chatId);
  if (!espera) return false;
  if (Date.now() > espera.hasta) {
    esperandoFijo.delete(chatId);
    return false;
  }

  const datos = { ...espera.datos };
  const texto = msg.text.trim();
  if (!datos.monto) {
    const monto = parsearMontoExacto(texto);
    if (!monto) {
      await enviar(chatId, 'No entendí el monto. Escríbelo así: 24 mil, 15.990 o 24k.',
        { reply_markup: { inline_keyboard: [[{ text: 'Cancelar', callback_data: 'fjc_x' }]] } });
      return true;
    }
    datos.monto = monto;
  } else if (!datos.nombre) {
    const nombre = texto.replace(/[,;:¿?¡!]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 100);
    if (!nombre) return true;
    datos.nombre = nombre[0].toUpperCase() + nombre.slice(1);
  }
  await procesarGastoFijo(chatId, datos);
  return true;
}

function configurarComandosPlan() {
  const rechazar = (chatId) => enviar(chatId, 'No estás autorizado para usar este bot.');

  // /plan (resumen), /plan config, /plan ingreso <monto>, /plan 50 30 20
  bot.onText(/^\/plan(?:@\w+)?(?:\s+([\s\S]+))?$/i, async (msg, match) => {
    const chatId = msg.chat.id;
    if (!esChatAutorizado(chatId)) {
      await rechazar(chatId);
      return;
    }
    if (match[1]) {
      await admin.planConArgumentos(chatId, match[1]);
      return;
    }
    await responderPlan(chatId);
  });

  // /fijo arriendo 350 mil el 5
  bot.onText(/^\/fijo(?:@\w+)?(?:\s+([\s\S]+))?$/i, async (msg, match) => {
    const chatId = msg.chat.id;
    if (!esChatAutorizado(chatId)) {
      await rechazar(chatId);
      return;
    }

    const parsed = parsearFijo(match[1] || '');
    if (!parsed.nombre && !parsed.monto) {
      await enviar(chatId,
        '<b>Agregar un gasto fijo</b>\n\n' +
        'Escribe el nombre, el monto y, si quieres, el día de pago:\n' +
        '/fijo arriendo 350 mil el 5\n' +
        '/fijo internet 25.990 el 10\n' +
        '/fijo celular 20 mil el 10 palabras movistar, entel\n\n' +
        'También puedes escribirlo como hablas: «gasto fijo: 24 mil en telefonía, lo pago a Vivian».'
      );
      return;
    }

    await procesarGastoFijo(chatId, parsed);
  });
}

/** Botones de /fijo. Devuelve true si el callback era de este módulo. */
async function manejarCallbackFijos(cb, chatId, data) {
  const messageId = cb.message.message_id;

  if (data.startsWith('fjs_')) {
    const key = data.replace('fjs_', '');
    const pendiente = pendingFijos.get(key);
    if (!pendiente) {
      await responderCallback(cb.id, { text: 'Solicitud expirada' });
      return true;
    }

    try {
      const validado = validarGastoFijo({
        nombre: pendiente.datos.nombre,
        monto: pendiente.datos.monto,
        dia_pago: pendiente.datos.diaPago,
        palabras_clave: pendiente.datos.palabrasClave,
        destinatario: pendiente.datos.destinatario ?? null,
        destinatario_id: pendiente.datos.destinatario ? await buscarDestinatarioId(pendiente.datos.destinatario) : null
      });
      if (!validado.ok) {
        await responderCallback(cb.id, { text: validado.error });
        return true;
      }

      await crearGastoFijo(validado.valores);
      pendingFijos.delete(key);
      await editar(
        `Gasto fijo guardado: <b>${esc(validado.valores.nombre)}</b> ($${formatearMonto(validado.valores.monto)}).`,
        { chat_id: chatId, message_id: messageId }
      );
      await responderCallback(cb.id, { text: 'Guardado' });
    } catch (error) {
      console.error('Error al guardar gasto fijo:', error.code ?? error.name);
      await responderCallback(cb.id, { text: 'Error al guardar' });
    }
    return true;
  }

  // Actualizar el gasto fijo que ya existe con esa descripción (monto, día y a quién se le paga)
  if (data.startsWith('fju_')) {
    const key = data.replace('fju_', '');
    const pendiente = pendingFijos.get(key);
    if (!pendiente?.existente) {
      await responderCallback(cb.id, { text: 'Solicitud expirada' });
      return true;
    }
    try {
      const f = pendiente.existente;
      const d = pendiente.datos;
      const validado = validarGastoFijo({
        nombre: f.nombre,
        monto: d.monto,
        dia_pago: d.diaPago ?? f.dia_pago,
        categoria_id: f.categoria_id,
        cuenta_id: f.cuenta_id,
        palabras_clave: f.palabras_clave,
        ...(d.destinatario
          ? { destinatario: d.destinatario, destinatario_id: await buscarDestinatarioId(d.destinatario) }
          : {})
      });
      if (!validado.ok) {
        await responderCallback(cb.id, { text: validado.error });
        return true;
      }
      await actualizarGastoFijo(f.id, validado.valores, true);
      pendingFijos.delete(key);
      await editar(
        `Listo: actualicé <b>${esc(f.nombre)}</b> a $${formatearMonto(validado.valores.monto)}` +
        `${d.diaPago ? ` (día ${d.diaPago})` : ''}${d.destinatario ? `, se le paga a ${esc(d.destinatario)}` : ''}.`,
        { chat_id: chatId, message_id: messageId }
      );
      await responderCallback(cb.id, { text: 'Actualizado' });
    } catch (error) {
      console.error('Error al actualizar gasto fijo:', error.code ?? error.name);
      await responderCallback(cb.id, { text: 'Error al guardar' });
    }
    return true;
  }

  if (data === 'fjc_x') {
    esperandoFijo.delete(chatId);
    await editar('Cancelado', { chat_id: chatId, message_id: messageId });
    await responderCallback(cb.id, { text: 'Cancelado' });
    return true;
  }

  if (data.startsWith('fjx_')) {
    pendingFijos.delete(data.replace('fjx_', ''));
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

    const fileLink = await bot.getFileLink(documento.file_id);
    const response = await fetch(fileLink);
    if (!response.ok) throw new Error('la descarga del archivo falló');
    const buffer = Buffer.from(await response.arrayBuffer());

    // CSV, Excel y PDF se agrupan en una cola por chat (álbum o archivos seguidos), se analizan y se
    // importan desde aquí. Los archivos esperan en tmp/ y pasan a cartolas/{YYYY-MM}/ al confirmar
    // (ver cartolasBot.js)
    await cartolas.recibirArchivo(chatId, {
      nombre: nombreArchivo, buffer, ext, mediaGroupId: msg.media_group_id ?? null, mensajeId: msg.message_id, caption: msg.caption ?? null
    });
  } catch (error) {
    // No imprimir el objeto completo: puede incluir la URL con el token
    logErrorTelegram('procesar archivo', error);
    await enviar(chatId, '❌ Error al procesar el archivo.');
  }
}

/** Foto de una cartola: se descarga y entra a la cola de cartolas (OCR local). Devuelve true si la tomó. */
async function manejarFotoCartola(msg) {
  const chatId = msg.chat.id;
  try {
    const foto = msg.photo[msg.photo.length - 1];
    const buffer = await descargarBuffer(foto.file_id);
    await cartolas.recibirFoto(chatId, { buffer, mediaGroupId: msg.media_group_id ?? null, mensajeId: msg.message_id, caption: msg.caption ?? null });
  } catch (error) {
    logErrorTelegram('procesar foto de cartola', error);
    await enviar(chatId, '❌ Error al procesar la foto de la cartola.');
  }
  return true;
}

/**
 * Foto con un caption que es un gasto o ingreso ("almuerzo 5500 débito"): se procesa como un gasto
 * normal y la foto queda como respaldo de ese movimiento (se guarda al armar el borrador y se
 * borra si se cancela). Devuelve false si el caption no es un gasto: la foto sigue su flujo.
 */
async function manejarFotoConGasto(msg) {
  const caption = (msg.caption || '').trim();
  if (!caption || !intenciones) return false;
  if (clasificarPorReglas(caption)?.intencion !== 'registrar') return false;

  const chatId = msg.chat.id;
  const foto = msg.photo[msg.photo.length - 1];
  esperandoComprobante.set(chatId, { fileId: foto.file_id, nombre: 'foto.jpg', hasta: Date.now() + 60 * 1000 });
  try {
    await intenciones.manejarTexto({ ...msg, text: caption });
  } finally {
    // Si el borrador no llegó a armarse, la foto no queda esperando un gasto ajeno
    esperandoComprobante.delete(chatId);
  }
  return true;
}

/**
 * Maneja fotos enviadas
 */
async function manejarFoto(msg) {
  const chatId = msg.chat.id;
  const foto = msg.photo[msg.photo.length - 1]; // La de mayor resolución

  await enviar(chatId, '⏳ Guardando foto...');

  try {
    // Otros archivos que se mandan al bot: <FINANZAS_STORAGE>/archivos/{YYYY-MM}/
    const fileLink = await bot.getFileLink(foto.file_id);
    const response = await fetch(fileLink);
    if (!response.ok) throw new Error('la descarga del archivo falló');
    await guardarBuffer('archivos', `telegram_${Date.now()}.jpg`, Buffer.from(await response.arrayBuffer()));

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
