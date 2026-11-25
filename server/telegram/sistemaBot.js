/**
 * Reiniciar y actualizar la app desde Telegram (/reboot y /update), pensado para el servidor,
 * donde PM2 (con autorestart) vuelve a levantar el proceso cuando termina.
 *
 *  - Solo chats de TELEGRAM_ALLOWED_CHAT_IDS, con confirmación por botones.
 *  - Solo con NODE_ENV=production: en desarrollo se bloquean para no matar `npm run dev`.
 *  - Los comandos del sistema se ejecutan con execFile (sin shell) y con timeout. Ningún
 *    argumento viene de texto del usuario: son valores fijos o hashes que devuelve git.
 *  - /update verifica primero el entorno (git, node, npm, remoto y rama), edita un solo mensaje con
 *    el avance, muestra la prueba del cambio (hash anterior y nuevo, último commit, archivos) y un
 *    resumen con Gemini hecho solo con títulos de commits y nombres de archivos (esa llamada no
 *    cuenta para el límite por hora). Si existe update.sh en la raíz del repositorio, lo usa en lugar
 *    de hacer pull e instalar por su cuenta: `--sin-reinicio` antes de la prueba y `--solo-reiniciar`
 *    (pm2 reload y pm2 save) al final.
 *  - Antes de salir se escribe tmp/reinicio.json (en la raíz de storage) con el chat, el motivo y el
 *    hash esperado; al arrancar, el bot avisa que volvió, compara el hash y borra ese archivo.
 *  - Los errores que se muestran en el chat se limpian: sin rutas del servidor, sin líneas que
 *    mencionen .env y sin credenciales en URLs.
 */

import path from 'path';
import fs from 'fs/promises';
import { execFile } from 'child_process';
import { fileURLToPath } from 'url';
import { carpetaTmp } from '../storage.js';
import { resumirCambios, geminiDisponible } from './gemini.js';
import { puedeEnviarseAGemini } from './intenciones.js';
import { elegirMotor } from '../motorDB.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// server/telegram -> raíz del repositorio
const RAIZ_REPO = path.resolve(__dirname, '../..');

const ESPERA_MS = 5 * 60 * 1000;
const TIMEOUT_GIT_MS = 60 * 1000;
const TIMEOUT_NPM_MS = 5 * 60 * 1000;
// Tiempo para que el último mensaje salga antes de terminar el proceso (entre 1 y 2 segundos)
const RETRASO_SALIDA_MS = 1500;
const TIMEOUT_REMOTO_MS = 20 * 1000;
const TIMEOUT_SCRIPT_MS = 10 * 60 * 1000;
const MAX_TITULOS = 30;
const MAX_ARCHIVOS_IA = 100;
const NOMBRE_SCRIPT = 'update.sh';
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
            timeout: Boolean(error.killed),
            // El programa no está en el PATH del proceso
            faltante: error.code === 'ENOENT'
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

// ---------------------------------------------------------------------------
// Funciones puras (se prueban sin git ni Telegram)
// ---------------------------------------------------------------------------

/** Explica en lenguaje simple por qué falló `git ls-remote` */
export function explicarFalloRemoto({ error = '', timeout = false } = {}) {
  if (timeout) return 'El repositorio no respondió a tiempo: revisa la conexión a internet del servidor.';
  const t = String(error).toLowerCase();
  if (/could not resolve host|network is unreachable|connection (?:timed out|refused|reset)|no route to host/.test(t)) {
    return 'No hay conexión con el repositorio: revisa internet y DNS en el servidor.';
  }
  if (/permission denied|publickey|authentication failed|could not read from remote|access denied|repository not found|\b40[134]\b|host key verification failed/.test(t)) {
    return 'No hay acceso al repositorio: falta la deploy key o no tiene permiso de lectura.';
  }
  return 'No pude consultar el repositorio remoto.';
}

/** Qué decir cuando un programa no se puede ejecutar */
export function explicarProgramaFaltante(programa) {
  if (programa === 'npm') return 'PM2 no encuentra npm: revisa el PATH o nvm.';
  if (programa === 'node') return 'PM2 no encuentra node: revisa el PATH o nvm.';
  if (programa === 'git') return 'El proceso no encuentra git: instálalo o agrégalo al PATH.';
  return `El proceso no encuentra ${programa}.`;
}

/** Cantidad de archivos de la última línea de `git diff --stat` ("12 files changed, 80 insertions...") */
export function contarArchivosDelStat(stat) {
  const lineas = String(stat ?? '').split('\n').map(l => l.trim()).filter(Boolean);
  const resumen = lineas[lineas.length - 1] ?? '';
  const m = /(\d+)\s+files?\s+changed/.exec(resumen);
  return m ? Number(m[1]) : 0;
}

/** Fecha y hora en Chile (DD-MM-YYYY HH:MM) a partir de una fecha ISO; el texto original si no es válida */
export function fechaHoraChile(iso) {
  const fecha = new Date(iso);
  if (Number.isNaN(fecha.getTime())) return String(iso ?? '');
  const partes = Object.fromEntries(
    new Intl.DateTimeFormat('en-CA', {
      timeZone: 'America/Santiago',
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', hourCycle: 'h23'
    }).formatToParts(fecha).map(p => [p.type, p.value])
  );
  return `${partes.day}-${partes.month}-${partes.year} ${partes.hour}:${partes.minute}`;
}

/**
 * Texto del mensaje único de avance: encabezado, lo verificado, los pasos (los terminados con
 * "listo", el actual con "...") y, al final, el estado final si ya terminó.
 */
export function textoProgreso({ titulo = 'Actualizando', entorno = [], pasos = [], final = null }, esc = (t) => t) {
  const partes = [`<b>${esc(titulo)}</b>`];
  if (entorno.length > 0) partes.push(entorno.map(l => esc(l)).join('\n'));
  if (pasos.length > 0) {
    partes.push(pasos.map(p => (p.fallo ? `${esc(p.nombre)}: falló` : p.listo ? `${esc(p.nombre)}: listo` : `${esc(p.nombre)}...`)).join('\n'));
  }
  if (final) partes.push(esc(final));
  return partes.join('\n\n');
}

/** Títulos que se pueden mandar a Gemini: sin datos sensibles y como máximo MAX_TITULOS */
export function titulosParaIA(titulos) {
  return titulos.filter(t => puedeEnviarseAGemini(t)).slice(0, MAX_TITULOS);
}

/** Mensaje de "volví" según el hash esperado guardado antes de reiniciar */
export function textoVuelta({ hashActual, hashEsperado, motivo }, esc = (t) => t) {
  const corto = hashActual ? hashActual.slice(0, 7) : null;
  let texto = `Listo, volví a estar en línea.${corto ? `\nVersión: ${esc(corto)}` : ''}`;
  if (motivo === 'update' && hashEsperado) {
    if (hashActual && hashActual === hashEsperado) {
      texto += '\nActualización confirmada: la versión es la esperada.';
    } else {
      texto += `\nAlgo no calzó: esperaba la versión ${esc(hashEsperado.slice(0, 7))}` +
        `${corto ? ` y estoy en ${esc(corto)}` : ' y no pude leer la actual'}. Revisa el servidor.`;
    }
  }
  return texto;
}

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
   * Mensaje único de avance: se edita en cada paso en vez de mandar uno nuevo.
   * `titulo` abre el mensaje; entorno son las líneas de lo verificado.
   */
  function crearProgreso(chatId, mensajeId, titulo) {
    const estado = { titulo, entorno: [], pasos: [], final: null };
    const pintar = () => editar(textoProgreso(estado, esc), { chat_id: chatId, message_id: mensajeId });
    const cerrarActual = (fallo = false) => {
      const actual = estado.pasos[estado.pasos.length - 1];
      if (!actual) return;
      if (fallo) actual.fallo = true;
      else actual.listo = true;
    };
    return {
      async paso(nombre) {
        cerrarActual();
        estado.pasos.push({ nombre, listo: false });
        await pintar();
      },
      async entorno(lineas) {
        estado.entorno = lineas;
        await pintar();
      },
      async terminar(final, fallo = false) {
        cerrarActual(fallo);
        estado.final = final;
        await pintar();
      }
    };
  }

  /**
   * Deja el aviso para el próximo arranque (con el hash esperado si es una actualización) y termina
   * el proceso (PM2 lo vuelve a levantar). `progreso` es el mensaje de avance; sin él, el mensaje de
   * confirmación pasa a decir "Reiniciando...".
   */
  async function reiniciar(chatId, mensajeId, motivo, { esperado = null, anterior = null, progreso = null, conScript = false } = {}) {
    if (progreso) await progreso.paso('Reiniciando');
    else await editar('Reiniciando...', { chat_id: chatId, message_id: mensajeId });
    try {
      await fs.mkdir(carpetaTmp(), { recursive: true });
      await fs.writeFile(
        archivoReinicio(),
        JSON.stringify({ chatId, motivo, esperado, anterior, en: new Date().toISOString() })
      );
    } catch (error) {
      console.error(`[sistema] no se pudo escribir el aviso de reinicio: error_code=${error.code ?? 'desconocido'}`);
    }
    // Con update.sh, el script recarga PM2 (reload y save); si falla o el proceso sigue vivo, se sale
    // igual y PM2 (autorestart) lo levanta
    if (conScript) {
      await new Promise(resolve => setTimeout(resolve, RETRASO_SALIDA_MS));
      const r = await ejecutar('bash', [NOMBRE_SCRIPT, '--solo-reiniciar'], { timeoutMs: TIMEOUT_GIT_MS });
      if (!r.ok) await enviar(chatId, `No pude recargar PM2 con ${NOMBRE_SCRIPT}; reinicio el proceso directamente.`);
      setTimeout(() => process.exit(0), RETRASO_SALIDA_MS * 2);
      return;
    }
    // Margen para que el mensaje alcance a salir
    setTimeout(() => process.exit(0), RETRASO_SALIDA_MS);
  }

  /**
   * Al arrancar: si hay un reinicio pendiente de avisar, manda "Listo, volví a estar en línea" con
   * el hash actual; si fue una actualización, lo compara con el esperado ("Actualización
   * confirmada" o "Algo no calzó"). Borra el archivo. Nunca lanza.
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

      const actual = await hashActual();
      const esperado = esHashGit(String(datos?.esperado ?? '')) ? datos.esperado : null;
      await enviar(chatId, textoVuelta({
        hashActual: actual && esHashGit(actual) ? actual : null,
        hashEsperado: esperado,
        motivo: datos?.motivo
      }, esc));
    } catch {
      // el aviso es opcional
    }
  }

  // -------------------------------------------------------------------------
  // /update
  // -------------------------------------------------------------------------

  /**
   * Revisa que git, node y npm estén en el PATH del proceso, que el remoto responda y en qué rama
   * está el repositorio. Devuelve { ok, lineas, problemas, rama }: `lineas` es lo verificado (para
   * mostrar) y `problemas` explica en lenguaje simple lo que falta.
   */
  async function verificarEntorno() {
    const lineas = [];
    const problemas = [];
    let rama = null;

    const version = async (programa, etiqueta = programa) => {
      const r = await ejecutar(programa, ['--version'], { timeoutMs: 10000 });
      if (r.ok) {
        lineas.push(`${etiqueta}: ${r.salida.trim().split('\n')[0].replace(/^git version /, '').slice(0, 40)}`);
        return true;
      }
      problemas.push(r.faltante ? explicarProgramaFaltante(programa) : `${programa} no respondió bien.`);
      return false;
    };

    const hayGit = await version('git');
    await version('node');
    await version('npm');

    if (hayGit) {
      const ramaR = await ejecutar('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { timeoutMs: 10000 });
      rama = ramaR.ok ? ramaR.salida.trim() : null;
      if (!rama) {
        problemas.push('No pude leer la rama del repositorio: ¿el proceso corre dentro del repositorio?');
      } else if (rama === 'HEAD') {
        problemas.push('El repositorio no está en ninguna rama (HEAD suelto): no se puede actualizar con git pull.');
      } else {
        lineas.push(`Rama: ${rama}`);
      }

      const remoto = await ejecutar('git', ['ls-remote', '--heads', 'origin'], { timeoutMs: TIMEOUT_REMOTO_MS });
      if (remoto.ok) lineas.push('Repositorio remoto: responde');
      else problemas.push(explicarFalloRemoto({ error: remoto.error, timeout: remoto.timeout }));
    }

    // Herramientas de respaldo (/reset): solo avisan, no impiden actualizar
    const respaldo = [['tar', true]];
    let motor = 'sqlite';
    try { motor = elegirMotor(); } catch { /* un DB_ENGINE inválido ya lo reporta el arranque */ }
    if (motor === 'mariadb') respaldo.push(['mysqldump', true], ['mysql', true]);
    for (const [programa] of respaldo) {
      const r = await ejecutar(programa, ['--version'], { timeoutMs: 10000 });
      lineas.push(r.ok
        ? `${programa}: disponible`
        : `Aviso: el proceso no encuentra ${programa}; /reset no podrá hacer o restaurar respaldos`);
    }

    return { ok: problemas.length === 0, lineas, problemas, rama };
  }

  /** ¿Existe update.sh en la raíz del repositorio? */
  async function hayScript() {
    try {
      await fs.access(path.join(RAIZ_REPO, NOMBRE_SCRIPT));
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Prueba de que hubo cambio: rama, hash anterior y nuevo, fecha y autor del último commit y
   * cantidad de archivos cambiados. Devuelve { texto, archivos: [nombres], titulos: [...] }.
   */
  async function pruebaDelCambio(anterior, nuevo, rama) {
    const ultimo = await ejecutar('git', ['log', '-1', '--format=%an%x1f%cI'], { timeoutMs: 10000 });
    const [autor, fecha] = ultimo.ok ? ultimo.salida.trim().split('\x1f') : ['', ''];
    const stat = await ejecutar('git', ['diff', '--stat', `${anterior}..${nuevo}`], { timeoutMs: 15000 });
    const nombres = await ejecutar('git', ['diff', '--name-only', `${anterior}..${nuevo}`], { timeoutMs: 15000 });
    const log = await ejecutar('git', ['log', '--format=%s', '-n', String(MAX_TITULOS), `${anterior}..${nuevo}`], { timeoutMs: 15000 });

    const archivos = nombres.ok ? nombres.salida.split('\n').map(l => l.trim()).filter(Boolean) : [];
    const titulos = log.ok ? log.salida.split('\n').map(l => l.trim()).filter(Boolean) : [];
    const total = stat.ok ? contarArchivosDelStat(stat.salida) : archivos.length;

    const texto =
      '<b>Prueba de la actualización</b>\n\n' +
      (rama ? `Rama: ${esc(rama)}\n` : '') +
      `Antes: ${esc(anterior.slice(0, 7))}\nAhora: ${esc(nuevo.slice(0, 7))}\n` +
      (fecha ? `Último commit: ${esc(fechaHoraChile(fecha))}${autor ? ` por ${esc(autor)}` : ''}\n` : '') +
      `Archivos cambiados: ${total}`;
    return { texto, archivos, titulos };
  }

  /**
   * Resumen en viñetas con Gemini (solo títulos y nombres de archivos); si no se puede, los títulos
   * tal cual. No cuenta para el límite de llamadas por hora: es una llamada que pide el usuario.
   */
  async function resumenDeCambios(titulos, archivos) {
    if (titulos.length === 0) return null;

    let puntos = null;
    const seguros = titulosParaIA(titulos);
    if (geminiDisponible() && seguros.length > 0) {
      puntos = await resumirCambios(seguros, archivos.slice(0, MAX_ARCHIVOS_IA));
    }
    if (puntos) return `<b>Qué cambió</b>\n${puntos.map(p => `• ${esc(p)}`).join('\n')}`;
    return `<b>Cambios</b> (títulos de los commits)\n${titulos.map(t => `• ${esc(t)}`).join('\n')}`;
  }

  /**
   * Ejecuta la actualización paso a paso, editando un solo mensaje. Cualquier fallo avisa y no
   * reinicia. Devuelve { reiniciar: true, esperado, anterior, progreso } si todo salió bien.
   */
  async function actualizar(chatId, mensajeId) {
    const progreso = crearProgreso(chatId, mensajeId, 'Actualizando');
    const detener = async (final, detalle = null, fallo = true) => {
      await progreso.terminar(final, fallo);
      if (detalle) await enviar(chatId, detalle);
      return { reiniciar: false };
    };

    // 1. Verificar el entorno
    await progreso.paso('Verificando');
    const entorno = await verificarEntorno();
    await progreso.entorno(entorno.lineas);
    if (!entorno.ok) {
      return detener('No actualicé ni reinicié porque falta algo:', entorno.problemas.map(p => `• ${esc(p)}`).join('\n'));
    }

    const anterior = await hashActual();
    if (!anterior || !esHashGit(anterior)) {
      return detener('No pude leer la versión actual del repositorio, así que no actualicé ni reinicié.');
    }

    // 2. Descargar (con update.sh si existe; si no, git pull)
    const conScript = await hayScript();
    await progreso.paso(conScript ? `Ejecutando ${NOMBRE_SCRIPT}` : 'Descargando cambios');
    if (conScript) {
      // --sin-reinicio: el script verifica, descarga e instala; PM2 se recarga al final, después de la prueba y el resumen
      const r = await ejecutar('bash', [NOMBRE_SCRIPT, '--sin-reinicio'], { timeoutMs: TIMEOUT_SCRIPT_MS });
      const salida = limpiarSalida(r.ok ? r.salida : (r.error || r.salida), 12);
      if (!r.ok) {
        const motivo = r.timeout ? 'Se agotó el tiempo de espera.' : salida;
        return detener(
          `${NOMBRE_SCRIPT} falló, así que no reinicié.`,
          motivo ? `<pre>${esc(motivo)}</pre>` : null
        );
      }
      if (salida) await enviar(chatId, `<b>Salida de ${NOMBRE_SCRIPT}</b>\n<pre>${esc(salida)}</pre>`);
    } else {
      const pull = await ejecutar('git', ['pull', '--ff-only'], { timeoutMs: TIMEOUT_GIT_MS });
      if (!pull.ok) {
        const detalle = pull.timeout ? 'Se agotó el tiempo de espera.' : limpiarSalida(pull.error);
        return detener(
          'No pude actualizar (git pull falló). No reinicié.',
          detalle ? `<pre>${esc(detalle)}</pre>` : null
        );
      }
    }

    // 3. ¿Hubo cambios?
    const nuevo = await hashActual();
    if (!nuevo || !esHashGit(nuevo)) {
      return detener('Actualicé, pero no pude leer la versión nueva. No reinicié.');
    }
    if (nuevo === anterior) {
      return detener(`Ya estaba al día (versión ${anterior.slice(0, 7)}). No reinicié.`, null, false);
    }

    // 4. Prueba del cambio
    const prueba = await pruebaDelCambio(anterior, nuevo, entorno.rama);
    await enviar(chatId, prueba.texto);

    // 5. Dependencias, solo si cambió package.json o package-lock.json (con update.sh se encarga el script)
    if (!conScript && prueba.archivos.some(archivo => ARCHIVOS_DE_DEPENDENCIAS.includes(archivo))) {
      await progreso.paso('Instalando dependencias');
      const npm = await ejecutar('npm', ['ci', '--omit=dev'], { timeoutMs: TIMEOUT_NPM_MS });
      if (!npm.ok) {
        const detalle = npm.timeout ? 'Se agotó el tiempo de espera.' : (npm.faltante ? explicarProgramaFaltante('npm') : limpiarSalida(npm.error));
        return detener(
          'El código se actualizó, pero npm ci falló, así que no reinicié.',
          detalle ? `<pre>${esc(detalle)}</pre>` : null
        );
      }
    }

    // 6. Resumen de lo nuevo
    const resumen = await resumenDeCambios(prueba.titulos, prueba.archivos);
    if (resumen) await enviar(chatId, resumen);

    return { reiniciar: true, esperado: nuevo, anterior, progreso, conScript };
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
      : '¿Actualizar la app? Verifico git, node, npm y el repositorio, hago git pull (o ejecuto update.sh si existe), instalo dependencias si cambiaron y reinicio solo si todo sale bien.';
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

      const r = await actualizar(chatId, messageId);
      if (r.reiniciar) {
        await reiniciar(chatId, messageId, 'update', { esperado: r.esperado, anterior: r.anterior, progreso: r.progreso, conScript: r.conScript });
        return true;
      }
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
