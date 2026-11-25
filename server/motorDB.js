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
