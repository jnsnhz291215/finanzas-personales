/**
 * Reinicio total de los datos desde el bot (/reset) y restauración del último respaldo.
 *
 * Protecciones:
 *  - Antes de borrar siempre se hace un respaldo en <storage>/respaldos/reset-{fecha}/: una copia de
 *    la BD (SQLite: finanzas.db con la API de respaldo de better-sqlite3; MariaDB: mysqldump) y un
 *    .tar.gz de storage. Si el respaldo falla, no se borra nada. El reset nunca toca respaldos/.
 *  - Los comandos externos (mysqldump, mysql, tar) se ejecutan sin shell. La contraseña de MariaDB
 *    nunca va en argumentos: viaja en un archivo de opciones temporal con permisos 600 que se
 *    borra al terminar.
 *  - El borrado de la BD es una sola transacción, respetando las claves foráneas.
 *
 * La BD se importa de forma diferida para poder probar las funciones puras sin base de datos. Nada
 * de esto imprime nombres de archivo, contraseñas ni rutas del servidor en los logs.
 */

import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import crypto from 'crypto';
import { createReadStream } from 'fs';
import { execFile, spawn } from 'child_process';
import { rutaRaiz, carpetaBase, TIPOS } from './storage.js';

async function dbModulo() {
  return import('./db.js');
}

// ---------------------------------------------------------------------------
// Constantes y funciones puras
// ---------------------------------------------------------------------------

export const MODOS = ['movimientos', 'todo'];

// Hijos antes que padres, para borrar sin romper claves foráneas
export const TABLAS_MOVIMIENTOS = ['movimientos', 'pagos_prestamos', 'archivos_importados', 'mensajes_registro', 'historial_cambios'];
export const TABLAS_TODO = [
  ...TABLAS_MOVIMIENTOS,
  'gastos_fijos', 'datos_transferencia', 'reglas_categoria', 'compras_cuotas', 'cuentas', 'categorias'
];
// Tablas que se copian al restaurar un respaldo SQLite, padres antes que hijos (usuario no se toca)
const ORDEN_RESTAURAR = [
  'categorias', 'cuentas', 'compras_cuotas', 'reglas_categoria', 'movimientos', 'pagos_prestamos',
  'archivos_importados', 'gastos_fijos', 'datos_transferencia', 'plan_ahorro', 'mensajes_registro', 'historial_cambios'
];

export const FRASES = {
  movimientos: 'BORRAR MOVIMIENTOS',
  todo: 'BORRAR TODO',
  restaurar: 'RESTAURAR RESPALDO'
};

export const CATEGORIAS_BASE = [
  ['Supermercado', '#10B981', 'fa-shopping-cart'],
  ['Transporte', '#3B82F6', 'fa-bus'],
  ['Comida', '#F59E0B', 'fa-utensils'],
  ['Cuentas y Servicios', '#EF4444', 'fa-file-invoice-dollar'],
  ['Suscripciones', '#8B5CF6', 'fa-sync'],
  ['Salud', '#EC4899', 'fa-heartbeat'],
  ['Entretenimiento', '#14B8A6', 'fa-film'],
  ['Educación', '#6366F1', 'fa-graduation-cap'],
  ['Vivienda', '#F97316', 'fa-home'],
  ['Ingresos', '#22C55E', 'fa-arrow-down'],
  ['Otros', '#6B7280', 'fa-ellipsis-h']
];

const NOMBRES_BASE = new Set(CATEGORIAS_BASE.map(c => c[0].toLowerCase()));

/** Frase exacta que hay que escribir para confirmar la acción ('movimientos' | 'todo' | 'restaurar') */
export function fraseDe(accion) {
  return FRASES[accion] ?? null;
}

/** ¿Escribió exactamente la frase? Distingue mayúsculas; solo ignora espacios al borde. */
export function fraseCorrecta(texto, accion) {
  const esperada = fraseDe(accion);
  return Boolean(esperada) && typeof texto === 'string' && texto.trim() === esperada;
}

/** Cuántas categorías no son de las que trae la app */
export function contarCategoriasPersonalizadas(nombres) {
  return nombres.filter(n => !NOMBRES_BASE.has(String(n).toLowerCase())).length;
}

const pad = (n) => String(n).padStart(2, '0');

/** Nombre de carpeta de un respaldo en hora de Chile: reset-2026-11-25_143005 */
export function nombreCarpetaRespaldo(prefijo, ahora = new Date()) {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat('en-CA', {
      timeZone: 'America/Santiago',
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23'
    }).formatToParts(ahora).map(x => [x.type, x.value])
  );
  return `${prefijo}-${p.year}-${p.month}-${p.day}_${pad(p.hour)}${pad(p.minute)}${pad(p.second)}`;
}

/** Archivo de opciones de mysql/mysqldump: así la contraseña no viaja en los argumentos */
export function contenidoOpcionesMysql({ host, port, user, password }) {
  const valor = (v) => `"${String(v ?? '').replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '')}"`;
  return `[client]\nhost=${valor(host)}\nport=${Number(port) || 3306}\nuser=${valor(user)}\npassword=${valor(password)}\n`;
}

/** Texto de lo que se va a borrar, con conteos (texto plano) */
export function lineasConteos(c) {
  return [
    `Movimientos: ${c.movimientos}`,
    `Cuentas: ${c.cuentas}`,
    `Compras en cuotas: ${c.cuotas}`,
    `Plan de ahorro: ${c.planAhorro ? 'configurado' : 'sin configurar'}`,
    `Gastos fijos: ${c.gastosFijos}`,
    `Datos de transferencia: ${c.datosTransferencia}`,
    `Reglas de categoría: ${c.reglas}`,
    `Categorías personalizadas: ${c.categoriasPersonalizadas}`,
    `Archivos en storage: ${c.archivos}`
  ];
}

// ---------------------------------------------------------------------------
// Conteos
// ---------------------------------------------------------------------------

async function contar(query, tabla) {
  const [filas] = await query(`SELECT COUNT(*) AS n FROM ${tabla}`);
  return Number(filas[0]?.n ?? 0);
}

async function contarArchivosEn(carpeta) {
  let total = 0;
  let entradas;
  try {
    entradas = await fs.readdir(carpeta, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const e of entradas) {
    if (e.isDirectory()) total += await contarArchivosEn(path.join(carpeta, e.name));
    else if (e.isFile()) total++;
  }
  return total;
}

/** Cantidad de archivos de cartolas, comprobantes y archivos (sin tmp ni respaldos) */
export async function contarArchivosStorage() {
  let total = 0;
  for (const tipo of TIPOS) total += await contarArchivosEn(carpetaBase(tipo));
  return total;
}

/** Conteos de todo lo que borraría un reset */
export async function contarDatos() {
  const { query } = await dbModulo();
  const [categorias] = await query('SELECT nombre FROM categorias');
  const [plan] = await query('SELECT ingreso_base FROM plan_ahorro WHERE id = 1');
  return {
    movimientos: await contar(query, 'movimientos'),
    cuentas: await contar(query, 'cuentas'),
    cuotas: await contar(query, 'compras_cuotas'),
    planAhorro: plan[0]?.ingreso_base !== null && plan[0]?.ingreso_base !== undefined,
    gastosFijos: await contar(query, 'gastos_fijos'),
    datosTransferencia: await contar(query, 'datos_transferencia'),
    reglas: await contar(query, 'reglas_categoria'),
    categoriasPersonalizadas: contarCategoriasPersonalizadas(categorias.map(c => c.nombre)),
    archivos: await contarArchivosStorage()
  };
}

// ---------------------------------------------------------------------------
// Comandos externos (sin shell)
// ---------------------------------------------------------------------------

function ejecutar(programa, argumentos, { timeoutMs = 10 * 60 * 1000 } = {}) {
  return new Promise((resolve, reject) => {
    execFile(programa, argumentos, { timeout: timeoutMs, maxBuffer: 5 * 1024 * 1024, windowsHide: true }, (error) => {
      if (error) reject(Object.assign(new Error('falló un comando externo'), { codigo: error.code ?? 'EXEC' }));
      else resolve();
    });
  });
}

function configMariaDB() {
  return {
    host: process.env.DB_HOST,
    port: parseInt(process.env.DB_PORT) || 3306,
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD || '',
    database: process.env.DB_NAME || 'finanzas_personales_juan'
  };
}

/** Escribe el archivo de opciones (permisos 600), ejecuta `fn(ruta)` y lo borra siempre */
async function conArchivoDeOpciones(fn) {
  const ruta = path.join(os.tmpdir(), `fin-mysql-${crypto.randomBytes(8).toString('hex')}.cnf`);
  await fs.writeFile(ruta, contenidoOpcionesMysql(configMariaDB()), { mode: 0o600, flag: 'wx' });
  try {
    return await fn(ruta);
  } finally {
    await fs.unlink(ruta).catch(() => {});
  }
}

/** mysql con el volcado por stdin (spawn sin shell) */
function importarVolcado(rutaOpciones, rutaVolcado) {
  return new Promise((resolve, reject) => {
    const hijo = spawn('mysql', [`--defaults-extra-file=${rutaOpciones}`, configMariaDB().database], { stdio: ['pipe', 'ignore', 'ignore'] });
    hijo.on('error', (error) => reject(Object.assign(new Error('mysql no se pudo ejecutar'), { codigo: error.code ?? 'SPAWN' })));
    hijo.on('close', (codigo) => (codigo === 0 ? resolve() : reject(Object.assign(new Error('mysql falló'), { codigo }))));
    createReadStream(rutaVolcado).on('error', reject).pipe(hijo.stdin);
  });
}

// ---------------------------------------------------------------------------
// Respaldo
// ---------------------------------------------------------------------------

const NOMBRE_BD_SQLITE = 'finanzas.db';
const NOMBRE_BD_MARIADB = 'finanzas.sql';
const NOMBRE_STORAGE = 'storage.tar.gz';

export function carpetaRespaldos() {
  return path.join(rutaRaiz(), 'respaldos');
}

async function tamano(ruta) {
  try {
    return (await fs.stat(ruta)).size;
  } catch {
    return 0;
  }
}

/**
 * Crea el respaldo: BD y storage en respaldos/<prefijo>-<fecha>/. Devuelve { ruta (relativa a
 * storage), absoluta }. Si algo falla, borra lo que alcanzó a crear y lanza.
 */
export async function crearRespaldo(prefijo = 'reset') {
  const { getConnection, motorDB } = await dbModulo();
  const nombre = nombreCarpetaRespaldo(prefijo);
  const absoluta = path.join(carpetaRespaldos(), nombre);
  await fs.mkdir(absoluta, { recursive: true, mode: 0o700 });

  try {
    if (motorDB === 'sqlite') {
      const db = await getConnection();
      const destino = path.join(absoluta, NOMBRE_BD_SQLITE);
      await db.backup(destino);
      if (await tamano(destino) === 0) throw new Error('la copia de la base de datos quedó vacía');
    } else {
      const destino = path.join(absoluta, NOMBRE_BD_MARIADB);
      await conArchivoDeOpciones(opciones => ejecutar('mysqldump', [
        `--defaults-extra-file=${opciones}`,
        '--single-transaction',
        '--routines',
        `--result-file=${destino}`,
        configMariaDB().database
      ]));
      if (await tamano(destino) === 0) throw new Error('el volcado quedó vacío');
    }

    // storage sin respaldos/ (para no copiarse a sí mismo) ni tmp/
    const tar = path.join(absoluta, NOMBRE_STORAGE);
    await ejecutar('tar', ['-czf', tar, '--exclude=./respaldos', '--exclude=./tmp', '-C', rutaRaiz(), '.']);
    if (await tamano(tar) === 0) throw new Error('el archivo de storage quedó vacío');
  } catch (error) {
    await fs.rm(absoluta, { recursive: true, force: true }).catch(() => {});
    throw Object.assign(new Error('no se pudo crear el respaldo'), { codigo: error.codigo ?? error.code ?? 'RESPALDO' });
  }

  return { ruta: `respaldos/${nombre}`, absoluta };
}

/** Último respaldo de un reset (respaldos/reset-*) que tiene la copia de la BD, o null */
export async function ultimoRespaldo() {
  const { motorDB } = await dbModulo();
  const archivoBD = motorDB === 'sqlite' ? NOMBRE_BD_SQLITE : NOMBRE_BD_MARIADB;
  let entradas;
  try {
    entradas = await fs.readdir(carpetaRespaldos(), { withFileTypes: true });
  } catch {
    return null;
  }
  const nombres = entradas.filter(e => e.isDirectory() && /^reset-\d{4}-\d{2}-\d{2}_\d{6}$/.test(e.name)).map(e => e.name).sort().reverse();
  for (const nombre of nombres) {
    const absoluta = path.join(carpetaRespaldos(), nombre);
    if (await tamano(path.join(absoluta, archivoBD)) > 0) {
      return {
        nombre,
        ruta: `respaldos/${nombre}`,
        absoluta,
        archivoBD,
        conArchivos: await tamano(path.join(absoluta, NOMBRE_STORAGE)) > 0
      };
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Borrado
// ---------------------------------------------------------------------------

/** Borra el contenido de cartolas/, comprobantes/ y archivos/ (las carpetas se conservan) */
async function vaciarStorage() {
  let borrados = 0;
  for (const tipo of TIPOS) {
    const base = carpetaBase(tipo);
    let entradas = [];
    try {
      entradas = await fs.readdir(base);
    } catch {
      continue;
    }
    for (const nombre of entradas) {
      const ruta = path.join(base, nombre);
      borrados += await contarArchivosEn(ruta) || 1;
      await fs.rm(ruta, { recursive: true, force: true });
    }
  }
  return borrados;
}

const PLAN_POR_DEFECTO_SQL = 'UPDATE plan_ahorro SET ingreso_base = NULL, pct_fijos = 50, pct_libres = 30, pct_ahorro = 20 WHERE id = 1';

function sembrarSQLite(db) {
  const insertarCategoria = db.prepare('INSERT OR IGNORE INTO categorias (nombre, color, icono) VALUES (?, ?, ?)');
  for (const c of CATEGORIAS_BASE) insertarCategoria.run(...c);
  db.prepare("INSERT INTO cuentas (nombre, tipo) VALUES ('Efectivo', 'efectivo')").run();
}

async function borrarBDSqlite(modo) {
  const { getConnection } = await dbModulo();
  const db = await getConnection();
  const tablas = modo === 'todo' ? TABLAS_TODO : TABLAS_MOVIMIENTOS;
  db.transaction(() => {
    for (const t of tablas) db.prepare(`DELETE FROM ${t}`).run();
    db.prepare(`DELETE FROM sqlite_sequence WHERE name IN (${tablas.map(() => '?').join(', ')})`).run(...tablas);
    if (modo === 'todo') {
      db.prepare(PLAN_POR_DEFECTO_SQL).run();
      sembrarSQLite(db);
    }
  })();
}

// Tablas con AUTO_INCREMENT en MariaDB (todas las que se borran)
async function borrarBDMariaDB(modo) {
  const { getConnection } = await dbModulo();
  const pool = await getConnection();
  const tablas = modo === 'todo' ? TABLAS_TODO : TABLAS_MOVIMIENTOS;
  const conexion = await pool.getConnection();
  try {
    await conexion.beginTransaction();
    for (const t of tablas) await conexion.query(`DELETE FROM ${t}`);
    if (modo === 'todo') await conexion.query(PLAN_POR_DEFECTO_SQL);
    await conexion.commit();
  } catch (error) {
    await conexion.rollback().catch(() => {});
    throw error;
  } finally {
    conexion.release();
  }

  // ALTER TABLE confirma implícitamente, por eso va después de la transacción
  for (const t of tablas) await pool.query(`ALTER TABLE ${t} AUTO_INCREMENT = 1`);
  if (modo === 'todo') {
    for (const c of CATEGORIAS_BASE) {
      await pool.query('INSERT IGNORE INTO categorias (nombre, color, icono) VALUES (?, ?, ?)', c);
    }
    await pool.query("INSERT INTO cuentas (nombre, tipo) VALUES ('Efectivo', 'efectivo')");
  }
}

/** Anota el reset o la restauración en historial_cambios (si la tabla existe; nunca lanza) */
async function registrarEnHistorial(accion, chatId, antes, despues) {
  try {
    const { query } = await dbModulo();
    await query(
      `INSERT INTO historial_cambios (creado_ms, accion, tipo, registro_id, chat_id, antes, despues)
       VALUES (?, ?, 'sistema', NULL, ?, ?, ?)`,
      [Date.now(), accion, chatId ?? null, JSON.stringify(antes), JSON.stringify(despues)]
    );
  } catch (error) {
    console.error('[reset] no se pudo anotar en el historial:', error.code ?? error.name);
  }
}

/**
 * Reset: respaldo, borrado de la BD en una transacción, borrado de archivos y registro en el
 * historial. `modo`: 'movimientos' (movimientos, préstamos pagados, importaciones y archivos) o
 * 'todo'. Devuelve { antes (conteos), respaldo: { ruta }, archivosBorrados }.
 */
export async function ejecutarReset(modo, chatId = null) {
  if (!MODOS.includes(modo)) throw new Error('modo de reset no válido');
  const { motorDB } = await dbModulo();

  const antes = await contarDatos();
  const respaldo = await crearRespaldo('reset');

  if (motorDB === 'sqlite') await borrarBDSqlite(modo);
  else await borrarBDMariaDB(modo);

  const archivosBorrados = await vaciarStorage();
  await registrarEnHistorial('reset', chatId, antes, { modo, respaldo: respaldo.ruta, archivosBorrados });
  return { antes, respaldo: { ruta: respaldo.ruta }, archivosBorrados };
}

// ---------------------------------------------------------------------------
// Restaurar
// ---------------------------------------------------------------------------

async function restaurarBDSqlite(rutaBD) {
  const { getConnection } = await dbModulo();
  const db = await getConnection();
  db.prepare('ATTACH DATABASE ? AS respaldo').run(rutaBD);
  try {
    const columnas = (esquema, tabla) => {
      try {
        return db.pragma(`${esquema}.table_info(${tabla})`).map(c => c.name);
      } catch {
        return [];
      }
    };
    db.transaction(() => {
      for (const t of [...ORDEN_RESTAURAR].reverse()) db.prepare(`DELETE FROM main.${t}`).run();
      for (const t of ORDEN_RESTAURAR) {
        const enRespaldo = columnas('respaldo', t);
        const comunes = columnas('main', t).filter(c => enRespaldo.includes(c));
        if (comunes.length === 0) continue;
        const lista = comunes.join(', ');
        db.prepare(`INSERT INTO main.${t} (${lista}) SELECT ${lista} FROM respaldo.${t}`).run();
      }
      // Que los autoincrementos sigan donde estaban en el respaldo
      const tieneSecuencia = db.prepare("SELECT 1 FROM respaldo.sqlite_master WHERE name = 'sqlite_sequence'").get();
      if (tieneSecuencia) {
        db.prepare('DELETE FROM main.sqlite_sequence').run();
        db.prepare('INSERT INTO main.sqlite_sequence (name, seq) SELECT name, seq FROM respaldo.sqlite_sequence').run();
      }
    })();
  } finally {
    db.prepare('DETACH DATABASE respaldo').run();
  }
}

/**
 * Restaura un respaldo (el que devuelve ultimoRespaldo). Antes hace otro respaldo del estado
 * actual (antes-de-restaurar-...) para poder volver atrás. Devuelve { respaldoPrevio: { ruta } }.
 */
export async function restaurarRespaldo(respaldo, chatId = null) {
  const { motorDB } = await dbModulo();
  const previo = await crearRespaldo('antes-de-restaurar');

  if (motorDB === 'sqlite') {
    await restaurarBDSqlite(path.join(respaldo.absoluta, respaldo.archivoBD));
  } else {
    await conArchivoDeOpciones(opciones => importarVolcado(opciones, path.join(respaldo.absoluta, respaldo.archivoBD)));
  }

  if (respaldo.conArchivos) {
    await vaciarStorage();
    await ejecutar('tar', ['-xzf', path.join(respaldo.absoluta, NOMBRE_STORAGE), '-C', rutaRaiz()]);
  }

  await registrarEnHistorial('restaurar', chatId, { respaldoPrevio: previo.ruta }, { respaldo: respaldo.ruta });
  return { respaldoPrevio: { ruta: previo.ruta } };
}
