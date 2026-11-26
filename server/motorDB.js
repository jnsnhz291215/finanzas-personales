/**
 * Elección del motor de base de datos por la variable de entorno DB_ENGINE.
 *  - sqlite (por defecto): archivo finanzas.db, pensado para desarrollo.
 *  - mariadb: MariaDB/MySQL, con DB_HOST, DB_USER, DB_PASSWORD y DB_NAME (y DB_PORT si no es 3306).
 * Funciones puras: no leen .env ni se conectan a nada.
 */

/** 'sqlite' | 'mariadb'. Sin DB_ENGINE es sqlite; un valor desconocido lanza un error claro. */
export function elegirMotor(env = process.env) {
  const valor = String(env.DB_ENGINE ?? '').trim().toLowerCase();
  if (valor === '' || valor === 'sqlite') return 'sqlite';
  if (valor === 'mariadb' || valor === 'mysql') return 'mariadb';
  throw new Error('DB_ENGINE no es válido: usa "sqlite" o "mariadb".');
}

/** Variables de MariaDB que faltan (la contraseña puede estar vacía, pero la variable debe existir) */
export function variablesFaltantesMariaDB(env = process.env) {
  return ['DB_HOST', 'DB_USER', 'DB_PASSWORD', 'DB_NAME'].filter(nombre => env[nombre] === undefined || (nombre !== 'DB_PASSWORD' && String(env[nombre]).trim() === ''));
}

/**
 * Sentencias de database/schema.sql que se pueden ejecutar en cada arranque de MariaDB: sin
 * comentarios y sin CREATE DATABASE / USE (la base la elige DB_NAME) ni ALTER TABLE (no son
 * idempotentes; la clave foránea de movimientos a compras_cuotas se asegura aparte en db.js).
 */
export function sentenciasDeEsquema(texto) {
  return String(texto ?? '')
    .split('\n')
    .filter(linea => !linea.trim().startsWith('--'))
    .join('\n')
    .split(';')
    .map(s => s.trim())
    .filter(s => s && !/^(CREATE\s+DATABASE|USE|ALTER\s+TABLE)\b/i.test(s));
}

const MENSAJES_ERROR_BD = {
  ECONNREFUSED: 'MariaDB no acepta conexiones en DB_HOST y DB_PORT: ¿está encendido el servicio?',
  ENOTFOUND: 'No se encuentra el servidor de DB_HOST: revisa el nombre.',
  EAI_AGAIN: 'No se pudo resolver DB_HOST: revisa el DNS.',
  ETIMEDOUT: 'MariaDB no respondió a tiempo: revisa DB_HOST, DB_PORT y el firewall.',
  PROTOCOL_CONNECTION_LOST: 'Se perdió la conexión con MariaDB.',
  ER_ACCESS_DENIED_ERROR: 'MariaDB rechazó el usuario o la contraseña (DB_USER y DB_PASSWORD).',
  ER_BAD_DB_ERROR: 'La base de datos de DB_NAME no existe: créala (utf8mb4) y dale permisos al usuario.',
  ER_DBACCESS_DENIED_ERROR: 'El usuario no tiene permisos sobre la base de DB_NAME (falta el GRANT).'
};

/**
 * Texto de un error de base de datos apto para el log: en lenguaje simple para los casos conocidos y,
 * para el resto, el mensaje acotado y sin la contraseña (por si algún driver la incluyera).
 */
export function describirErrorBD(error, env = process.env) {
  const codigo = error?.code ?? error?.name ?? 'desconocido';
  if (MENSAJES_ERROR_BD[codigo]) return `${MENSAJES_ERROR_BD[codigo]} (${codigo})`;
  let mensaje = String(error?.message ?? 'sin mensaje').slice(0, 160);
  const clave = env.DB_PASSWORD;
  if (clave) mensaje = mensaje.split(clave).join('***');
  return `${mensaje} (${codigo})`;
}
