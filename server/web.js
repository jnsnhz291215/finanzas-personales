/**
 * Decide si la web (Express) se levanta y en qué dirección. Por defecto no se levanta: la app se
 * usa por el bot de Telegram y no expone nada por HTTP.
 *
 *  - WEB_HABILITADA=true la activa; sin ella (o con cualquier otro valor) no hay Express ni puerto.
 *  - Escucha solo en HOST (por defecto 127.0.0.1). 0.0.0.0 y :: (todas las interfaces) no se aceptan.
 *  - Sin ADMIN_PASSWORD, o con la de ejemplo "cambiar123", la web no arranca.
 *
 * Funciones puras (más un pequeño registro de en qué dirección quedó escuchando, para /status).
 * Nunca lee ni imprime valores secretos.
 */

export const HOST_POR_DEFECTO = '127.0.0.1';
export const PUERTO_POR_DEFECTO = 3005;
const CLAVE_DE_EJEMPLO = 'cambiar123';

const COMODINES = new Set(['0.0.0.0', '::', '0:0:0:0:0:0:0:0', '[::]']);

/** ¿La dirección es solo de este equipo? (127.x.x.x, ::1 o localhost) */
export function esLoopback(host) {
  const h = String(host ?? '').trim().toLowerCase().replace(/^\[|\]$/g, '');
  return h === 'localhost' || h === '::1' || /^127(?:\.\d{1,3}){3}$/.test(h);
}

/**
 * { habilitada, host, puerto, bloqueo }: `bloqueo` es el motivo (texto corto, sin secretos) por el
 * que, estando habilitada, la web no debe arrancar.
 */
export function decidirWeb(env = process.env) {
  const habilitada = String(env.WEB_HABILITADA ?? '').trim().toLowerCase() === 'true';
  const host = String(env.HOST ?? '').trim() || HOST_POR_DEFECTO;
  const puerto = Number(env.PORT) || PUERTO_POR_DEFECTO;
  if (!habilitada) return { habilitada: false, host, puerto, bloqueo: null };

  const password = String(env.ADMIN_PASSWORD ?? '').trim();
  let bloqueo = null;
  if (COMODINES.has(host.toLowerCase())) {
    bloqueo = 'HOST no puede ser 0.0.0.0 ni :: (expondría la web a toda la red); usa 127.0.0.1';
  } else if (!password || password === CLAVE_DE_EJEMPLO) {
    bloqueo = 'falta ADMIN_PASSWORD o sigue siendo la de ejemplo (cambiar123)';
  }
  return { habilitada: true, host, puerto, bloqueo };
}

// En qué dirección quedó escuchando de verdad el servidor (la registra index.js)
let escucha = null;

export function registrarEscucha(direccion) {
  escucha = direccion && typeof direccion === 'object'
    ? { host: String(direccion.address), puerto: Number(direccion.port) }
    : null;
}

export function direccionEscuchando() {
  return escucha;
}
