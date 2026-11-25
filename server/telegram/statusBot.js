/**
 * /status: revisa cada parte de la app y dice claramente qué funciona y qué no. También responde a
 * "estado", "todo bien?" y "status", y corre solo al arrancar en producción (avisa únicamente si
 * algo no funciona).
 *
 * Cada chequeo corre en paralelo con su propio tiempo máximo (8 s) y devuelve elementos con estado:
 *   ok     -> Funciona
 *   fallo  -> No funciona (con el motivo corto)
 *   aviso  -> Aviso (algo a revisar, no cuenta como problema)
 *
 * Privacidad: nunca se imprimen secretos, valores de variables, contraseñas, tokens ni rutas
 * completas de .env. De las variables solo se muestran los nombres.
 */

import os from 'os';
import path from 'path';
import fs from 'fs/promises';
import { execFile } from 'child_process';
import { fileURLToPath } from 'url';
import { rutaRaiz, carpetaBase, carpetaTmp } from '../storage.js';
import { probarGemini, geminiDisponible } from './gemini.js';
import { elegirMotor } from '../motorDB.js';
import { decidirWeb, direccionEscuchando, esLoopback } from '../web.js';
import { explicarFalloRemoto } from './sistemaBot.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const RAIZ_REPO = path.resolve(__dirname, '../..');
const RUTA_SQLITE = path.resolve(RAIZ_REPO, 'finanzas.db');

export const TIMEOUT_CHEQUEO_MS = 8000;
const TIMEOUT_FETCH_MS = 6000;

const ICONO = { ok: '✅', fallo: '❌' };

// ---------------------------------------------------------------------------
// Funciones puras
// ---------------------------------------------------------------------------

/** Rechaza si la promesa no termina en `ms` milisegundos */
export function conTimeout(promesa, ms) {
  let temporizador;
  const limite = new Promise((_, reject) => {
    temporizador = setTimeout(() => reject(Object.assign(new Error('tiempo agotado'), { esTimeout: true })), ms);
  });
  return Promise.race([promesa, limite]).finally(() => clearTimeout(temporizador));
}

/** 1536 -> "1,5 KB"; 3 GB -> "3,0 GB" */
export function formatearTamano(bytes) {
  const n = Number(bytes);
  if (!Number.isFinite(n) || n < 0) return 'desconocido';
  const unidades = ['B', 'KB', 'MB', 'GB', 'TB'];
  let valor = n;
  let i = 0;
  while (valor >= 1024 && i < unidades.length - 1) {
    valor /= 1024;
    i++;
  }
  return `${i === 0 ? valor : valor.toFixed(1).replace('.', ',')} ${unidades[i]}`;
}

/** "1,5 KB", o "más de 1,5 KB" si el conteo quedó incompleto */
export function textoTamano(bytes, parcial = false) {
  return `${parcial ? 'más de ' : ''}${formatearTamano(bytes)}`;
}

/** 93784 s -> "1 d 2 h 3 min" */
export function formatearDuracion(segundos) {
  let resto = Math.max(0, Math.floor(Number(segundos) || 0));
  const dias = Math.floor(resto / 86400);
  resto -= dias * 86400;
  const horas = Math.floor(resto / 3600);
  resto -= horas * 3600;
  const minutos = Math.floor(resto / 60);
  const partes = [];
  if (dias) partes.push(`${dias} d`);
  if (horas || dias) partes.push(`${horas} h`);
  partes.push(`${minutos} min`);
  return partes.join(' ');
}

/** Cantidad de elementos que no funcionan */
export function contarProblemas(secciones) {
  return secciones.reduce((suma, s) => suma + s.items.filter(i => i.estado === 'fallo').length, 0);
}

export function contarAvisos(secciones) {
  return secciones.reduce((suma, s) => suma + s.items.filter(i => i.estado === 'aviso').length, 0);
}

/** Línea final: "Todo en orden" o "Hay N problemas" */
export function lineaFinal(secciones) {
  const problemas = contarProblemas(secciones);
  const avisos = contarAvisos(secciones);
  if (problemas === 0) return `Todo en orden${avisos ? ` (${avisos} ${avisos === 1 ? 'aviso' : 'avisos'})` : ''}`;
  return `Hay ${problemas} ${problemas === 1 ? 'problema' : 'problemas'}`;
}

/**
 * Mensaje único: una sección por chequeo, con ✅ / ❌ o "Aviso:" por elemento y la línea final. Se
 * recorta a 4.000 caracteres para no pasar el límite de Telegram.
 */
export function formatearEstado(secciones, esc = (t) => t) {
  const bloques = secciones.map(s => {
    const lineas = s.items.map(i => (i.estado === 'aviso'
      ? `Aviso: ${esc(i.texto)}`
      : `${ICONO[i.estado] ?? ICONO.fallo} ${esc(i.texto)}`));
    return `<b>${esc(s.titulo)}</b>\n${lineas.join('\n')}`;
  });
  const texto = `<b>Estado de la app</b>\n\n${bloques.join('\n\n')}\n\n<b>${esc(lineaFinal(secciones))}</b>`;
  return texto.length > 4000 ? `${texto.slice(0, 3990)}\n...` : texto;
}

/**
 * Variables de entorno: solo nombres. `env` es process.env (o un objeto de prueba) y `motor` el
 * motor de BD. Devuelve elementos { estado, texto }.
 */
export function revisarVariables(env, motor) {
  const requeridas = ['TELEGRAM_BOT_TOKEN', 'TELEGRAM_ALLOWED_CHAT_IDS'];
  if (motor === 'mariadb') requeridas.push(...['DB_HOST', 'DB_USER', 'DB_PASSWORD', 'DB_NAME']);
  const definida = (nombre) => env[nombre] !== undefined && (nombre === 'DB_PASSWORD' || String(env[nombre]).trim() !== '');

  const faltan = requeridas.filter(n => !definida(n));
  const items = [];
  if (faltan.length > 0) items.push({ estado: 'fallo', texto: `Faltan variables requeridas: ${faltan.join(', ')}` });
  else items.push({ estado: 'ok', texto: `Variables requeridas presentes (${requeridas.length})` });

  // SESSION_SECRET solo sirve a la web: es opcional (y se avisa solo si se sirve el frontend)
  const recomendadas = ['FINANZAS_STORAGE', 'GEMINI_API_KEY'];
  if (env.SERVIR_FRONTEND === 'true') recomendadas.push('SESSION_SECRET');
  if (env.NODE_ENV === 'production') recomendadas.push('DB_ENGINE');
  const sinDefinir = recomendadas.filter(n => !definida(n));
  if (sinDefinir.length > 0) items.push({ estado: 'aviso', texto: `Sin definir (opcionales): ${sinDefinir.join(', ')}` });
  return items;
}

// ---------------------------------------------------------------------------
// Utilidades de sistema
// ---------------------------------------------------------------------------

function ejecutar(programa, argumentos, { timeoutMs = 5000, cwd = RAIZ_REPO } = {}) {
  return new Promise((resolve) => {
    execFile(programa, argumentos, {
      cwd,
      timeout: timeoutMs,
      windowsHide: true,
      maxBuffer: 1024 * 1024,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0' }
    }, (error, stdout, stderr) => {
      resolve(error
        ? { ok: false, salida: String(stdout ?? ''), error: String(stderr || error.message || ''), timeout: Boolean(error.killed), faltante: error.code === 'ENOENT' }
        : { ok: true, salida: String(stdout ?? ''), error: '' });
    });
  });
}

const TOPE_TAMANO_MS = 5000;

/**
 * Suma el tamaño de una carpeta hasta que se acabe el tiempo (`limite.hasta`). Si se pasa, marca
 * `limite.truncado` y devuelve lo contado hasta ahí (el tamaño real es mayor).
 */
async function tamanoDeCarpeta(carpeta, limite = { hasta: Date.now() + TOPE_TAMANO_MS, truncado: false }) {
  let total = 0;
  let entradas;
  try {
    entradas = await fs.readdir(carpeta, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const e of entradas) {
    if (Date.now() > limite.hasta) {
      limite.truncado = true;
      break;
    }
    const ruta = path.join(carpeta, e.name);
    if (e.isDirectory()) total += await tamanoDeCarpeta(ruta, limite);
    else if (e.isFile()) {
      try {
        total += (await fs.stat(ruta)).size;
      } catch {
        // un archivo que desaparece mientras se cuenta no importa
      }
    }
  }
  return total;
}

// ---------------------------------------------------------------------------
// Chequeos (cada uno devuelve un arreglo de { estado, texto })
// ---------------------------------------------------------------------------

async function chequeoServidor() {
  const items = [];

  let so = `${os.platform()} ${os.release()}`;
  try {
    const texto = await fs.readFile('/etc/os-release', 'utf8');
    const m = /^PRETTY_NAME="?([^"\n]+)"?/m.exec(texto);
    if (m) so = m[1];
  } catch {
    // sin /etc/os-release (macOS, Windows): se usa plataforma y versión
  }
  items.push({ estado: 'ok', texto: `Sistema: ${so}` });
  items.push({ estado: 'ok', texto: `Equipo: ${os.hostname()}, encendido hace ${formatearDuracion(os.uptime())}` });
  items.push({ estado: 'ok', texto: `App activa hace ${formatearDuracion(process.uptime())}` });
  items.push({ estado: 'ok', texto: `Node ${process.version}, NODE_ENV=${process.env.NODE_ENV || 'sin definir'}` });

  const libre = os.freemem();
  const total = os.totalmem();
  const pctMem = total > 0 ? (libre / total) * 100 : 100;
  items.push({
    estado: pctMem < 5 ? 'aviso' : 'ok',
    texto: `Memoria libre: ${formatearTamano(libre)} de ${formatearTamano(total)}${pctMem < 5 ? ' (muy poca)' : ''}`
  });

  try {
    const disco = await fs.statfs(rutaRaiz());
    const libreDisco = disco.bavail * disco.bsize;
    const totalDisco = disco.blocks * disco.bsize;
    const pct = totalDisco > 0 ? (libreDisco / totalDisco) * 100 : 100;
    items.push({
      estado: pct < 2 ? 'fallo' : pct < 10 ? 'aviso' : 'ok',
      texto: `Disco del storage: ${formatearTamano(libreDisco)} libres de ${formatearTamano(totalDisco)} (${pct.toFixed(0)}%)${pct < 10 ? ', queda poco espacio' : ''}`
    });
  } catch {
    items.push({ estado: 'aviso', texto: 'No pude leer el espacio en disco del storage' });
  }
  return items;
}

async function chequeoApp() {
  const items = [];
  const commit = await ejecutar('git', ['log', '-1', '--format=%h%x1f%s']);
  if (!commit.ok) {
    return [{ estado: 'fallo', texto: commit.faltante ? 'git no está disponible: no puedo leer la versión' : 'No pude leer la versión del repositorio' }];
  }
  const [hash, titulo] = commit.salida.trim().split('\x1f');
  items.push({ estado: 'ok', texto: `Versión: ${hash} - ${(titulo ?? '').slice(0, 80)}` });

  const rama = await ejecutar('git', ['rev-parse', '--abbrev-ref', 'HEAD']);
  const nombreRama = rama.ok ? rama.salida.trim() : null;
  items.push(nombreRama
    ? { estado: nombreRama === 'HEAD' ? 'aviso' : 'ok', texto: nombreRama === 'HEAD' ? 'Rama: ninguna (HEAD suelto)' : `Rama: ${nombreRama}` }
    : { estado: 'aviso', texto: 'No pude leer la rama' });

  const estado = await ejecutar('git', ['status', '--porcelain']);
  if (estado.ok) {
    const cambios = estado.salida.split('\n').filter(Boolean).length;
    items.push(cambios > 0
      ? { estado: 'aviso', texto: `Hay ${cambios} ${cambios === 1 ? 'archivo' : 'archivos'} con cambios locales sin commit` }
      : { estado: 'ok', texto: 'Sin cambios locales sin commit' });
  }

  const fetch = await ejecutar('git', ['fetch', '--quiet', 'origin'], { timeoutMs: TIMEOUT_FETCH_MS });
  if (!fetch.ok) {
    items.push({ estado: 'aviso', texto: `No pude consultar el repositorio remoto: ${explicarFalloRemoto({ error: fetch.error, timeout: fetch.timeout })}` });
  } else {
    const nuevos = await ejecutar('git', ['rev-list', '--count', 'HEAD..@{u}']);
    if (!nuevos.ok) items.push({ estado: 'aviso', texto: 'La rama no tiene una rama remota asociada para comparar' });
    else {
      const n = Number(nuevos.salida.trim());
      items.push(n > 0
        ? { estado: 'aviso', texto: `El remoto tiene ${n} ${n === 1 ? 'commit nuevo' : 'commits nuevos'}: usa /update` }
        : { estado: 'ok', texto: 'Al día con el remoto' });
    }
  }
  return items;
}

async function chequeoPM2() {
  const bajoPM2 = process.env.pm_id !== undefined;
  if (bajoPM2) {
    const reinicios = Number(process.env.restart_time ?? 0);
    return [{
      estado: reinicios > 10 ? 'aviso' : 'ok',
      texto: `Corre bajo PM2: ${process.env.name || 'sin nombre'}, ${reinicios} ${reinicios === 1 ? 'reinicio' : 'reinicios'}${reinicios > 10 ? ' (muchos: revisa los logs)' : ''}`
    }];
  }
  return [process.env.NODE_ENV === 'production'
    ? { estado: 'aviso', texto: 'No corre bajo PM2: si se cae, nadie lo levanta' }
    : { estado: 'ok', texto: 'No corre bajo PM2 (modo desarrollo)' }];
}

const TABLAS_PRINCIPALES = [
  'usuario', 'cuentas', 'categorias', 'reglas_categoria', 'movimientos', 'pagos_prestamos', 'archivos_importados',
  'compras_cuotas', 'plan_ahorro', 'gastos_fijos', 'datos_transferencia', 'mensajes_registro', 'historial_cambios'
];

async function chequeoBaseDeDatos() {
  const items = [];
  const { query, motorDB } = await import('../db.js');
  items.push({ estado: 'ok', texto: `Motor: ${motorDB}` });

  try {
    if (motorDB === 'mariadb') {
      const [filas] = await query('SELECT CURRENT_USER() AS usuario, DATABASE() AS base, VERSION() AS version');
      items.push({ estado: 'ok', texto: `Conexión correcta como ${filas[0].usuario}` });
      items.push({ estado: 'ok', texto: `Base: ${filas[0].base}, servidor ${filas[0].version}` });
    } else {
      const [filas] = await query('SELECT sqlite_version() AS version');
      items.push({ estado: 'ok', texto: 'Conexión correcta (SQLite no usa usuario)' });
      let tamano = 'tamaño desconocido';
      try {
        tamano = formatearTamano((await fs.stat(RUTA_SQLITE)).size);
      } catch {
        // el archivo puede estar en otra ruta
      }
      items.push({ estado: 'ok', texto: `Base: ${path.basename(RUTA_SQLITE)} (${tamano}), SQLite ${filas[0].version}` });
    }
  } catch (error) {
    items.push({ estado: 'fallo', texto: `No puedo consultar la base de datos (${error.code ?? error.name})` });
    return items;
  }

  const faltan = [];
  for (const tabla of TABLAS_PRINCIPALES) {
    try {
      await query(`SELECT 1 FROM ${tabla} LIMIT 1`);
    } catch {
      faltan.push(tabla);
    }
  }
  items.push(faltan.length > 0
    ? { estado: 'fallo', texto: `Faltan tablas: ${faltan.join(', ')}` }
    : { estado: 'ok', texto: `Tablas principales presentes (${TABLAS_PRINCIPALES.length})` });

  try {
    const cuenta = async (sql) => Number((await query(sql))[0][0].n);
    const movimientos = await cuenta('SELECT COUNT(*) AS n FROM movimientos');
    const cuentas = await cuenta('SELECT COUNT(*) AS n FROM cuentas WHERE activa = 1');
    const cuotas = await cuenta('SELECT COUNT(*) AS n FROM compras_cuotas WHERE activa = 1 AND terminada = 0');
    items.push({ estado: 'ok', texto: `Movimientos: ${movimientos}, cuentas activas: ${cuentas}, cuotas activas: ${cuotas}` });
  } catch (error) {
    items.push({ estado: 'aviso', texto: `No pude contar los registros (${error.code ?? error.name})` });
  }
  return items;
}

/** Estado de la web a partir de la decisión (env) y de la dirección en que escucha de verdad */
export function revisarWeb(decision, escucha) {
  if (!decision.habilitada) return [{ estado: 'ok', texto: 'Deshabilitada (no se escucha ningún puerto)' }];
  if (decision.bloqueo) return [{ estado: 'fallo', texto: `Habilitada pero bloqueada: ${decision.bloqueo}` }];
  if (!escucha) return [{ estado: 'fallo', texto: `Habilitada pero no está escuchando en ${decision.host}:${decision.puerto}` }];
  if (!esLoopback(escucha.host)) {
    return [{ estado: 'fallo', texto: `Escucha fuera de localhost (${escucha.host}:${escucha.puerto}): cualquiera en la red podría entrar` }];
  }
  return [{ estado: 'ok', texto: `Escuchando en ${escucha.host}:${escucha.puerto}` }];
}

async function chequeoWeb() {
  return revisarWeb(decidirWeb(process.env), direccionEscuchando());
}

async function chequeoGemini() {
  if (!geminiDisponible()) {
    return [{ estado: 'aviso', texto: 'Sin GEMINI_API_KEY: el bot funciona solo con reglas' }];
  }
  const r = await probarGemini();
  return [r.ok
    ? { estado: 'ok', texto: `Gemini responde (${r.ms} ms)` }
    : { estado: 'fallo', texto: `Gemini no funciona: ${r.motivo}` }];
}

async function chequeoTelegram(ctx) {
  const items = [];
  try {
    const yo = await ctx.bot.getMe();
    items.push({ estado: 'ok', texto: `Bot conectado: @${yo.username}` });
  } catch (error) {
    return [{ estado: 'fallo', texto: `Telegram no responde (${error?.response?.body?.error_code ?? error?.code ?? 'sin código'})` }];
  }

  const primero = (ctx.chatIds?.() ?? []).find(id => Number.isInteger(id));
  if (primero === undefined) {
    items.push({ estado: 'fallo', texto: 'No hay chats autorizados en TELEGRAM_ALLOWED_CHAT_IDS' });
    return items;
  }
  try {
    const comandos = await ctx.bot.getMyCommands({ scope: { type: 'chat', chat_id: primero } });
    items.push(comandos.length > 0
      ? { estado: 'ok', texto: `Menú de comandos registrado (${comandos.length})` }
      : { estado: 'aviso', texto: 'El menú de comandos no está registrado' });
  } catch {
    items.push({ estado: 'aviso', texto: 'No pude leer el menú de comandos' });
  }
  return items;
}

async function chequeoStorage() {
  const items = [];
  const raiz = rutaRaiz();
  items.push({ estado: 'ok', texto: `Ruta: ${process.env.FINANZAS_STORAGE ? 'definida en FINANZAS_STORAGE' : 'por defecto (storage/ del repositorio)'}` });

  try {
    if (!(await fs.stat(raiz)).isDirectory()) throw new Error('no es una carpeta');
  } catch {
    items.push({ estado: 'fallo', texto: 'La carpeta de storage no existe' });
    return items;
  }

  // Escribir y borrar un archivo de prueba en tmp/
  const prueba = path.join(carpetaTmp(), `status-${process.pid}-${Date.now()}.txt`);
  try {
    await fs.mkdir(carpetaTmp(), { recursive: true });
    await fs.writeFile(prueba, 'prueba', { flag: 'wx' });
    await fs.unlink(prueba);
    items.push({ estado: 'ok', texto: 'Se puede escribir en storage (prueba en tmp/)' });
  } catch (error) {
    await fs.unlink(prueba).catch(() => {});
    items.push({ estado: 'fallo', texto: `No se puede escribir en storage (${error.code ?? 'sin código'}): revisa los permisos` });
  }

  const carpetas = {
    cartolas: carpetaBase('cartolas'),
    comprobantes: carpetaBase('comprobantes'),
    archivos: carpetaBase('archivos'),
    respaldos: path.join(raiz, 'respaldos')
  };
  // Un solo tope de tiempo para todo el conteo: si se pasa, se muestra "más de X"
  const limite = { hasta: Date.now() + TOPE_TAMANO_MS, truncado: false };
  const tamanos = {};
  for (const [nombre, ruta] of Object.entries(carpetas)) {
    tamanos[nombre] = { bytes: await tamanoDeCarpeta(ruta, limite), parcial: limite.truncado };
  }
  const total = Object.values(tamanos).reduce((a, t) => a + t.bytes, 0);
  items.push({
    estado: 'ok',
    texto: `Tamaño: ${textoTamano(total, limite.truncado)} (${Object.entries(tamanos).map(([n, t]) => `${n} ${textoTamano(t.bytes, t.parcial)}`).join(', ')})`
  });
  return items;
}

async function chequeoHerramientas() {
  let motor = 'sqlite';
  try {
    motor = elegirMotor();
  } catch {
    // un DB_ENGINE inválido ya se ve en el chequeo de la base de datos
  }
  // [programa, ¿si falta es un problema?]: tar y los clientes de MariaDB solo afectan a /reset
  const programas = [['git', true], ['node', true], ['npm', true], ['tar', false]];
  if (motor === 'mariadb') programas.push(['mysqldump', false], ['mysql', false]);

  return Promise.all(programas.map(async ([programa, esencial]) => {
    const r = await ejecutar(programa, ['--version']);
    if (r.ok) return { estado: 'ok', texto: `${programa}: ${r.salida.trim().split('\n')[0].replace(/^git version /, '').slice(0, 40)}` };
    const texto = r.faltante
      ? `${programa}: no está en el PATH del proceso${programa === 'npm' || programa === 'node' ? ' (revisa PATH o nvm)' : ''}`
      : `${programa}: no respondió bien`;
    return { estado: esencial ? 'fallo' : 'aviso', texto: esencial ? texto : `${texto}; /reset no podrá hacer respaldos` };
  }));
}

async function chequeoRespaldos() {
  const carpeta = path.join(rutaRaiz(), 'respaldos');
  let entradas;
  try {
    entradas = await fs.readdir(carpeta, { withFileTypes: true });
  } catch {
    return [{ estado: 'aviso', texto: 'Todavía no hay respaldos (se crean con /reset)' }];
  }
  let ultimo = null;
  for (const e of entradas.filter(x => x.isDirectory())) {
    try {
      const { mtimeMs } = await fs.stat(path.join(carpeta, e.name));
      if (!ultimo || mtimeMs > ultimo.mtimeMs) ultimo = { nombre: e.name, mtimeMs };
    } catch {
      // se ignora lo que no se pueda leer
    }
  }
  if (!ultimo) return [{ estado: 'aviso', texto: 'Todavía no hay respaldos (se crean con /reset)' }];
  const hace = formatearDuracion((Date.now() - ultimo.mtimeMs) / 1000);
  return [{ estado: 'ok', texto: `Último respaldo: ${ultimo.nombre}, hace ${hace}` }];
}

async function chequeoVariables() {
  let motor = 'sqlite';
  try {
    motor = elegirMotor();
  } catch {
    return [{ estado: 'fallo', texto: 'DB_ENGINE no es válido: usa sqlite o mariadb' }];
  }
  return revisarVariables(process.env, motor);
}

// ---------------------------------------------------------------------------
// Ejecución
// ---------------------------------------------------------------------------

/** Corre un chequeo con su tiempo máximo; un error o un timeout se vuelven "No funciona" */
export async function ejecutarChequeo(titulo, funcion, ms = TIMEOUT_CHEQUEO_MS) {
  try {
    return { titulo, items: await conTimeout(Promise.resolve().then(funcion), ms) };
  } catch (error) {
    const texto = error?.esTimeout
      ? `No respondió en ${Math.round(ms / 1000)} segundos`
      : `No pude revisarlo (${error?.code ?? error?.name ?? 'error'})`;
    return { titulo, items: [{ estado: 'fallo', texto }] };
  }
}

export function crearStatus(ctx) {
  const { bot, enviar, editar, esc, esChatAutorizado } = ctx;
  let enCurso = false;

  /** Todos los chequeos en paralelo; el orden de las secciones es fijo */
  async function revisarTodo() {
    const chequeos = [
      ['Servidor', chequeoServidor],
      ['App', chequeoApp],
      ['PM2', chequeoPM2],
      ['Web', chequeoWeb],
      ['Base de datos', chequeoBaseDeDatos],
      ['Gemini', chequeoGemini],
      ['Telegram', () => chequeoTelegram({ bot, chatIds: ctx.chatIds })],
      ['Storage', chequeoStorage],
      ['Herramientas', chequeoHerramientas],
      ['Respaldos', chequeoRespaldos],
      ['Variables', chequeoVariables]
    ];
    return Promise.all(chequeos.map(([titulo, fn]) => ejecutarChequeo(titulo, fn)));
  }

  /** Responde al chat con el estado completo en un solo mensaje */
  async function responder(chatId) {
    if (!esChatAutorizado(chatId)) {
      await enviar(chatId, 'No estás autorizado para usar este bot.');
      return true;
    }
    if (enCurso) {
      await enviar(chatId, 'Ya estoy revisando, espera un momento.');
      return true;
    }
    enCurso = true;
    try {
      const aviso = await enviar(chatId, 'Revisando...');
      const texto = formatearEstado(await revisarTodo(), esc);
      const editado = aviso?.message_id
        ? await editar(texto, { chat_id: chatId, message_id: aviso.message_id })
        : null;
      if (!editado) await enviar(chatId, texto);
    } catch (error) {
      console.error('[status] error:', error.code ?? error.name);
      await enviar(chatId, 'No pude completar la revisión.');
    } finally {
      enCurso = false;
    }
    return true;
  }

  /**
   * Al arrancar en producción: corre el chequeo y avisa a los chats autorizados solo si algo no
   * funciona. Nunca lanza.
   */
  async function revisarAlArrancar() {
    if (process.env.NODE_ENV !== 'production') return;
    try {
      const secciones = await revisarTodo();
      if (contarProblemas(secciones) === 0) return;
      const texto = formatearEstado(secciones, esc);
      for (const chatId of (ctx.chatIds?.() ?? []).filter(id => Number.isInteger(id))) {
        await enviar(chatId, texto);
      }
    } catch (error) {
      console.error('[status] error al arrancar:', error.code ?? error.name);
    }
  }

  function configurarComandos() {
    bot.onText(/^\/status(?:@\w+)?\s*$/i, async (msg) => {
      await responder(msg.chat.id);
    });
  }

  return { configurarComandos, responder, revisarAlArrancar };
}
