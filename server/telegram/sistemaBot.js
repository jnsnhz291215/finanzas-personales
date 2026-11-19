/**
 * Reiniciar y actualizar la app desde Telegram (/reboot y /update), pensado para el servidor,
 * donde PM2 (con autorestart) vuelve a levantar el proceso cuando termina.
 *
 *  - Solo chats de TELEGRAM_ALLOWED_CHAT_IDS, con confirmación por botones.
 *  - Solo con NODE_ENV=production: en desarrollo se bloquean para no matar `npm run dev`.
 *  - Los comandos del sistema se ejecutan con execFile (sin shell) y con timeout. Ningún
 *    argumento viene de texto del usuario: son valores fijos o hashes que devuelve git.
 *  - Antes de salir se escribe tmp/reinicio.json (en la raíz de storage) con el chat y el motivo;
 *    al arrancar, el bot avisa que volvió y borra ese archivo.
 *  - Los errores que se muestran en el chat se limpian: sin rutas del servidor, sin líneas que
 *    mencionen .env y sin credenciales en URLs.
 */

import path from 'path';
import fs from 'fs/promises';
import { execFile } from 'child_process';
import { fileURLToPath } from 'url';
import { carpetaTmp } from '../storage.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// server/telegram -> raíz del repositorio
const RAIZ_REPO = path.resolve(__dirname, '../..');

const ESPERA_MS = 5 * 60 * 1000;
const TIMEOUT_GIT_MS = 60 * 1000;
const TIMEOUT_NPM_MS = 5 * 60 * 1000;
// Tiempo para que el último mensaje salga antes de terminar el proceso (entre 1 y 2 segundos)
const RETRASO_SALIDA_MS = 1500;
const MAX_COMMITS = 10;
const ARCHIVOS_DE_DEPENDENCIAS = ['package.json', 'package-lock.json'];

/** Ejecuta un programa con argumentos fijos, sin shell, y devuelve { ok, salida, error } */
function ejecutar(programa, argumentos, { timeoutMs, cwd = RAIZ_REPO } = {}) {
  return new Promise((resolve) => {
    execFile(
      programa,
      argumentos,
      {
        cwd,
        timeout: timeoutMs,
        maxBuffer: 5 * 1024 * 1024,
        windowsHide: true,
        // git no debe quedarse esperando usuario o contraseña
        env: { ...process.env, GIT_TERMINAL_PROMPT: '0' }
      },
      (error, stdout, stderr) => {
        if (error) {
          resolve({
            ok: false,
            salida: String(stdout ?? ''),
            error: String(stderr || stdout || error.message || ''),
            timeout: Boolean(error.killed)
          });
        } else {
          resolve({ ok: true, salida: String(stdout ?? ''), error: '' });
        }
      }
    );
  });
}

/**
 * Últimas líneas de una salida de error, aptas para mostrar en el chat: sin rutas del
 * servidor, sin líneas que mencionen .env y sin credenciales en URLs.
 */
export function limpiarSalida(texto, maxLineas = 6) {
  const casa = process.env.HOME ? new RegExp(process.env.HOME.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g') : null;
  const lineas = String(texto ?? '')
    .split('\n')
    .map(l => l.replace(/\s+$/, ''))
    .filter(l => l.trim() && !/\.env\b/i.test(l))
    .map(l => {
      let limpia = l
        .replace(/(https?:\/\/)[^\s/@]+@/gi, '$1')
        .split(RAIZ_REPO).join('<repo>');
      if (casa) limpia = limpia.replace(casa, '~');
      return limpia.slice(0, 200);
    });
  return lineas.slice(-maxLineas).join('\n');
}

const esHashGit = (texto) => /^[0-9a-f]{40}$/.test(texto);

/** Archivo que se escribe justo antes de salir y se lee al arrancar */
function archivoReinicio() {
  return path.join(carpetaTmp(), 'reinicio.json');
}

export function crearSistema(ctx) {
  const { bot, enviar, editar, responderCallback, esc, esChatAutorizado } = ctx;

  // Confirmaciones pendientes: clave -> { accion }
  const pendientes = new Map();
  let enProceso = false;

  const esProduccion = () => process.env.NODE_ENV === 'production';

  async function hashActual(corto = false) {
    const r = await ejecutar('git', ['rev-parse', ...(corto ? ['--short'] : []), 'HEAD'], { timeoutMs: 10000 });
    return r.ok ? r.salida.trim() : null;
  }

  /**
   * Deja el aviso para el próximo arranque y termina el proceso (PM2 lo vuelve a levantar).
   * `mensajeId` es el mensaje de confirmación, que pasa a decir "Reiniciando...".
   */
  async function reiniciar(chatId, mensajeId, motivo) {
    await editar('Reiniciando...', { chat_id: chatId, message_id: mensajeId });
    try {
      await fs.mkdir(carpetaTmp(), { recursive: true });
      await fs.writeFile(archivoReinicio(), JSON.stringify({ chatId, motivo, en: new Date().toISOString() }));
    } catch (error) {
      console.error(`[sistema] no se pudo escribir el aviso de reinicio: error_code=${error.code ?? 'desconocido'}`);
    }
    // Margen para que el mensaje alcance a salir
    setTimeout(() => process.exit(0), RETRASO_SALIDA_MS);
  }

  /**
   * Al arrancar: si hay un reinicio pendiente de avisar, manda "Listo, volví a estar en línea"
   * con el hash actual y borra el archivo. Nunca lanza.
   */
  async function notificarReinicioPendiente() {
    let datos;
    try {
      datos = JSON.parse(await fs.readFile(archivoReinicio(), 'utf8'));
    } catch {
      return; // no hay aviso pendiente (o no se pudo leer)
    }

    try {
      await fs.unlink(archivoReinicio());
    } catch {
      // si no se pudo borrar, igual se avisa una vez; el próximo arranque lo intentará de nuevo
    }

    try {
      const chatId = Number(datos?.chatId);
      if (!Number.isInteger(chatId) || !esChatAutorizado(chatId)) return;

      const hash = await hashActual(true);
      await enviar(chatId, `Listo, volví a estar en línea.${hash ? `\nVersión: ${esc(hash)}` : ''}`);
    } catch {
      // el aviso es opcional
    }
  }

  // -------------------------------------------------------------------------
  // /update
  // -------------------------------------------------------------------------

  /**
   * Ejecuta la actualización paso a paso. Cualquier fallo avisa y no reinicia.
   * Devuelve true solo si todo salió bien y hay que reiniciar.
   */
  async function actualizar(chatId) {
    const anterior = await hashActual();
    if (!anterior || !esHashGit(anterior)) {
      await enviar(chatId, 'No pude leer la versión actual del repositorio, así que no actualicé ni reinicié.');
      return false;
    }

    // a. git pull --ff-only
    const pull = await ejecutar('git', ['pull', '--ff-only'], { timeoutMs: TIMEOUT_GIT_MS });
    if (!pull.ok) {
      const detalle = pull.timeout ? 'Se agotó el tiempo de espera.' : limpiarSalida(pull.error);
      await enviar(chatId,
        `No pude actualizar (git pull falló). No reinicié.${detalle ? `\n\n<pre>${esc(detalle)}</pre>` : ''}`
      );
      return false;
    }

    // c. ¿hubo cambios?
    const nuevo = await hashActual();
    if (!nuevo || !esHashGit(nuevo)) {
      await enviar(chatId, 'Actualicé, pero no pude leer la versión nueva. No reinicié.');
      return false;
    }
    if (nuevo === anterior) {
      await enviar(chatId, 'Ya estaba al día. No reinicié.');
      return false;
    }

    // d. dependencias, solo si cambió package.json o package-lock.json
    const diff = await ejecutar('git', ['diff', '--name-only', anterior, nuevo], { timeoutMs: 15000 });
    const cambiados = diff.ok ? diff.salida.split('\n').map(l => l.trim()) : [];
    if (cambiados.some(archivo => ARCHIVOS_DE_DEPENDENCIAS.includes(archivo))) {
      await enviar(chatId, 'Cambiaron las dependencias: ejecutando npm ci...');
      const npm = await ejecutar('npm', ['ci', '--omit=dev'], { timeoutMs: TIMEOUT_NPM_MS });
      if (!npm.ok) {
        const detalle = npm.timeout ? 'Se agotó el tiempo de espera.' : limpiarSalida(npm.error);
        await enviar(chatId,
          'El código se actualizó, pero npm ci falló, así que no reinicié.' +
          `${detalle ? `\n\n<pre>${esc(detalle)}</pre>` : ''}`
        );
        return false;
      }
    }

    // e. resumen de lo nuevo
    const log = await ejecutar('git', ['log', '--oneline', '-n', String(MAX_COMMITS), `${anterior}..${nuevo}`], { timeoutMs: 15000 });
    const titulos = log.ok ? log.salida.split('\n').filter(Boolean) : [];
    await enviar(chatId,
      '<b>Actualización lista</b>\n\n' +
      `Antes: ${esc(anterior.slice(0, 7))}\nAhora: ${esc(nuevo.slice(0, 7))}` +
      (titulos.length > 0 ? `\n\n<b>Cambios:</b>\n${titulos.map(t => esc(t)).join('\n')}` : '')
    );
    return true;
  }

  // -------------------------------------------------------------------------
  // Comandos y botones
  // -------------------------------------------------------------------------

  async function pedirConfirmacion(chatId, accion) {
    if (!esProduccion()) {
      await enviar(chatId, 'El reinicio solo funciona en el servidor (NODE_ENV=production). Aquí está bloqueado para no cerrar el modo desarrollo.');
      return;
    }

    const key = `${chatId}_${Date.now()}`;
    pendientes.set(key, { accion });
    setTimeout(() => pendientes.delete(key), ESPERA_MS);

    const texto = accion === 'reboot'
      ? '¿Reiniciar la app? Estará unos segundos sin responder.'
      : '¿Actualizar la app? Hago git pull, instalo dependencias si cambiaron y reinicio solo si todo sale bien.';
    await enviar(chatId, texto, {
      reply_markup: {
        inline_keyboard: [[
          { text: accion === 'reboot' ? 'Reiniciar' : 'Actualizar', callback_data: `sys${accion === 'reboot' ? 'r' : 'u'}_${key}` },
          { text: 'Cancelar', callback_data: `sysx_${key}` }
        ]]
      }
    });
  }

  /** Botones de este módulo. Devuelve true si el callback era suyo. */
  async function manejarCallback(cb, chatId, data) {
    const m = data.match(/^sys([rux])_(.+)$/);
    if (!m) return false;
    const messageId = cb.message.message_id;
    const pendiente = pendientes.get(m[2]);

    if (m[1] === 'x') {
      pendientes.delete(m[2]);
      await editar('Cancelado', { chat_id: chatId, message_id: messageId });
      await responderCallback(cb.id, { text: 'Cancelado' });
      return true;
    }

    // Se vuelve a comprobar aquí: la confirmación pudo pedirse antes de un cambio de entorno
    if (!esProduccion() || !pendiente || pendiente.accion !== (m[1] === 'r' ? 'reboot' : 'update')) {
      await responderCallback(cb.id, { text: pendiente ? 'No disponible aquí' : 'Solicitud expirada' });
      return true;
    }
    pendientes.delete(m[2]);

    if (enProceso) {
      await responderCallback(cb.id, { text: 'Ya hay una operación en curso' });
      return true;
    }
    enProceso = true;

    try {
      await responderCallback(cb.id, {});
      if (pendiente.accion === 'reboot') {
        await reiniciar(chatId, messageId, 'reboot');
        return true; // el proceso termina en un momento; enProceso no se libera a propósito
      }

      await editar('Actualizando...', { chat_id: chatId, message_id: messageId });
      if (await actualizar(chatId)) {
        await reiniciar(chatId, messageId, 'update');
        return true;
      }
      await editar('Actualización terminada sin reiniciar.', { chat_id: chatId, message_id: messageId });
    } catch (error) {
      console.error(`[sistema] error inesperado: ${error.code ?? error.name}`);
      await enviar(chatId, 'Ocurrió un error inesperado. No reinicié.');
    }
    enProceso = false;
    return true;
  }

  function configurarComandos() {
    const comando = (regex, accion) => {
      bot.onText(regex, async (msg) => {
        const chatId = msg.chat.id;
        if (!esChatAutorizado(chatId)) {
          await enviar(chatId, 'No estás autorizado para usar este bot.');
          return;
        }
        await pedirConfirmacion(chatId, accion);
      });
    };
    comando(/^\/reboot(?:@\w+)?\s*$/i, 'reboot');
    comando(/^\/update(?:@\w+)?\s*$/i, 'update');
  }

  return { configurarComandos, manejarCallback, notificarReinicioPendiente };
}
