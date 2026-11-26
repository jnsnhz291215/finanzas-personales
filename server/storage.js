/**
 * Almacenamiento de archivos bajo una sola raíz configurable (FINANZAS_STORAGE), ordenado
 * por tipo y por mes de recepción (America/Santiago):
 *
 *   <raíz>/cartolas/{YYYY-MM}/       cartolas importadas (web y bot)
 *   <raíz>/comprobantes/{YYYY-MM}/   comprobantes de cuotas y respaldos de movimientos
 *   <raíz>/archivos/{YYYY-MM}/       otros archivos que se mandan al bot
 *   <raíz>/tmp/                      temporales
 *
 * Estructura nueva (la que usa todo lo que se guarda desde ahora):
 *
 *   <raíz>/cuentas/<tipo>-<titular>-<últimos4>/<año>/<mes 01-12>/cartola_2026-08.pdf
 *                                                              /comprobante_2026-08-19_1.jpg
 *                                                              /foto_2026-08-19_1.jpg
 *   <raíz>/sin-cuenta/<año>/<mes>/   lo que no tiene cuenta
 *   <raíz>/papelera/<fecha>/         archivos que /resetcuenta mueve en vez de borrar
 *
 * La carpeta de una cuenta NO usa su nombre (que se puede editar) sino el tipo, el titular y los últimos 4 dígitos. server/migrarStorage.js
 * mueve a esta estructura lo que se guardó antes.
 *
 * En la BD se guarda la ruta relativa a la raíz, por ejemplo
 * comprobantes/2026-11/respaldo_cuota_123_foto.jpg (estructura anterior) o cuentas/credito-valeska-8263/2026/08/cartola_2026-08.pdf. Las variables CARTOLAS_PATH y
 * RESPALDOS_PATH están obsoletas: si están definidas siguen mandando para su tipo (con un
 * aviso). Las rutas anteriores (/uploads/respaldos/<archivo>, nombres sueltos y rutas
 * absolutas de cartolas) se siguen resolviendo; los archivos existentes no se mueven.
 *
 * Nunca se escribe en consola el nombre ni el contenido de un archivo.
 */

import path from 'path';
import fs from 'fs/promises';
import crypto from 'crypto';
import multer from 'multer';
import { fileURLToPath } from 'url';
import { fechaHoySantiago } from './telegram/fechas.js';
import { normalizar } from './telegram/cuentas.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// En desarrollo: storage/ en la raíz del repo (ignorada por git). En prod:
// FINANZAS_STORAGE=/home/basalto/apps/finanzas-juan/storage
const RAIZ_POR_DEFECTO = path.join(__dirname, '../storage');
// Carpeta uploads/ de versiones anteriores
const UPLOADS_ANTERIOR = path.join(__dirname, '../uploads');

export const TIPOS = ['cartolas', 'comprobantes', 'archivos'];

// Variables obsoletas que, si están definidas, siguen mandando para su tipo
const VARIABLE_OBSOLETA = { cartolas: 'CARTOLAS_PATH', comprobantes: 'RESPALDOS_PATH' };

function validarTipo(tipo) {
  if (!TIPOS.includes(tipo)) throw new Error('tipo de almacenamiento no válido');
}

/** Raíz del almacenamiento (FINANZAS_STORAGE o storage/ del repo) */
export function rutaRaiz() {
  return path.resolve(process.env.FINANZAS_STORAGE || RAIZ_POR_DEFECTO);
}

function variableObsoleta(tipo) {
  const nombre = VARIABLE_OBSOLETA[tipo];
  const valor = nombre ? (process.env[nombre] || '').trim() : '';
  return valor ? path.resolve(valor) : null;
}

/** Carpeta base de un tipo: la variable obsoleta si está definida; si no, <raíz>/<tipo> */
export function carpetaBase(tipo) {
  validarTipo(tipo);
  return variableObsoleta(tipo) ?? path.join(rutaRaiz(), tipo);
}

/** Carpeta de temporales (<raíz>/tmp) */
export function carpetaTmp() {
  return path.join(rutaRaiz(), 'tmp');
}

/** ¿La ruta queda estrictamente dentro de la base? (evita salirse con .. o rutas absolutas) */
export function dentroDe(base, ruta) {
  const relativa = path.relative(path.resolve(base), path.resolve(ruta));
  return relativa !== '' && !relativa.startsWith('..') && !path.isAbsolute(relativa);
}

/** Mes de recepción YYYY-MM en hora de Chile (por defecto, el de hoy) */
export function mesRecepcion(fecha = fechaHoySantiago()) {
  return String(fecha).slice(0, 7);
}

/**
 * Nombre de archivo seguro: solo el nombre (path.basename), sin caracteres raros ni puntos
 * iniciales y de largo acotado conservando la extensión.
 */
export function nombreSeguro(nombre) {
  let limpio = path.basename(String(nombre ?? '')).replace(/[^\p{L}\p{N}._ ()-]/gu, '_').replace(/^\.+/, '').trim();
  if (limpio.length > 120) {
    const extension = path.extname(limpio).slice(0, 10);
    limpio = limpio.slice(0, 120 - extension.length) + extension;
  }
  return limpio || 'archivo';
}

/** Ruta relativa que se guarda en la BD: <tipo>/<YYYY-MM>/<archivo> (siempre con /) */
export function rutaRelativa(tipo, mes, nombre) {
  validarTipo(tipo);
  return `${tipo}/${mes}/${nombre}`;
}

/** Carpeta del mes de un tipo, creándola si no existe */
export async function carpetaDelMes(tipo, mes = mesRecepcion()) {
  const carpeta = path.join(carpetaBase(tipo), mes);
  await fs.mkdir(carpeta, { recursive: true });
  return carpeta;
}

/**
 * Guarda un buffer en <tipo>/<mes>/<prefijo><nombre seguro>. Nunca sobrescribe: si el nombre
 * ya existe agrega un sufijo. Devuelve { ruta (relativa para la BD), absoluta, nombre }.
 */
export async function guardarBuffer(tipo, nombreSugerido, buffer, { prefijo = '', mes = mesRecepcion() } = {}) {
  const base = carpetaBase(tipo);
  const carpeta = await carpetaDelMes(tipo, mes);

  let nombre = `${nombreSeguro(`${prefijo}${nombreSeguro(nombreSugerido)}`)}`;
  let destino = path.join(carpeta, nombre);
  for (let intento = 0; ; intento++) {
    if (!dentroDe(base, destino)) throw new Error('la ruta queda fuera del almacenamiento');
    try {
      await fs.writeFile(destino, buffer, { flag: 'wx' });
      break;
    } catch (error) {
      if (error.code !== 'EEXIST' || intento >= 5) throw error;
      const extension = path.extname(nombre);
      nombre = `${nombre.slice(0, nombre.length - extension.length)}-${crypto.randomBytes(3).toString('hex')}${extension}`;
      destino = path.join(carpeta, nombre);
    }
  }

  return { ruta: rutaRelativa(tipo, mes, nombre), absoluta: destino, nombre };
}

/**
 * Almacenamiento de multer para una carpeta de tipo y mes. Con soloExtension el archivo se
 * llama <timestamp>-<aleatorio><extensión> (sin el nombre original).
 */
export function almacenamientoMulter(tipo, { soloExtension = false } = {}) {
  validarTipo(tipo);
  return multer.diskStorage({
    destination: (req, file, cb) => {
      carpetaDelMes(tipo).then(carpeta => cb(null, carpeta)).catch(cb);
    },
    filename: (req, file, cb) => {
      const unico = `${Date.now()}-${crypto.randomInt(1e9)}`;
      const nombre = soloExtension
        ? `${unico}${path.extname(nombreSeguro(file.originalname)).slice(0, 10)}`
        : `${unico}-${nombreSeguro(file.originalname)}`;
      cb(null, nombre);
    }
  });
}

/** Ruta relativa (para la BD) de un archivo que multer ya escribió en la carpeta del tipo */
export function rutaRelativaDeMulter(tipo, archivo) {
  const relativa = path.relative(carpetaBase(tipo), archivo.path).split(path.sep).join('/');
  if (relativa.startsWith('..')) throw new Error('la ruta queda fuera del almacenamiento');
  return `${tipo}/${relativa}`;
}

// ---------------------------------------------------------------------------
// Estructura por cuenta: cuentas/<tipo>-<titular>-<últimos4>/<año>/<mes>/
// ---------------------------------------------------------------------------

const TIPO_CORTO = {
  tarjeta_credito: 'credito', tarjeta_debito: 'debito', cuenta_corriente: 'corriente', cuenta_vista: 'vista', cuenta_ahorro: 'ahorro', efectivo: 'efectivo',
  credito: 'credito', debito: 'debito', ahorro: 'ahorro'
};

const slug = (texto, largo = 30) => normalizar(texto ?? '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, largo).replace(/-+$/, '');

/**
 * Nombre de la carpeta de una cuenta: <tipo>-<titular>-<últimos4>, por ejemplo credito-valeska-8263. No usa el nombre de la cuenta (que se
 * puede editar). Sin titular, "propio"; sin dígitos, "sin-digitos".
 */
export function slugCuenta(cuenta) {
  const tipo = TIPO_CORTO[cuenta?.tipo] ?? (slug(cuenta?.tipo, 12) || 'cuenta');
  const titular = slug(cuenta?.titular) || 'propio';
  const digitos = [cuenta?.ultimos4, cuenta?.ultimos4_cuenta].find(d => /^\d{4}$/.test(String(d ?? ''))) ?? 'sin-digitos';
  return `${tipo}-${titular}-${digitos}`;
}

/** Carpeta relativa donde va un archivo: cuentas/<slug>/<año>/<mes> o, sin cuenta, sin-cuenta/<año>/<mes>. `fecha` es YYYY-MM-DD (o YYYY-MM). */
export function carpetaRelativaDeCuenta(cuenta, fecha = fechaHoySantiago()) {
  const [anio, mes] = String(fecha).slice(0, 7).split('-');
  return cuenta ? `cuentas/${slugCuenta(cuenta)}/${anio}/${mes}` : `sin-cuenta/${anio}/${mes}`;
}

/**
 * Nombre del archivo: cartola_2026-08.pdf (por el mes de la cartola) o comprobante_2026-08-19_1.jpg / foto_2026-08-19_1.jpg (fecha y número).
 * `ocupados` es el conjunto de nombres que ya existen en la carpeta; se elige el primero libre.
 */
export function nombreDeArchivo(clase, fecha, extension, ocupados = new Set()) {
  const ext = String(extension ?? '').toLowerCase().replace(/^(?=[^.])/, '.').slice(0, 10);
  if (clase === 'cartola') {
    const base = `cartola_${String(fecha).slice(0, 7)}`;
    for (let n = 1; ; n++) {
      const nombre = `${base}${n === 1 ? '' : `_${n}`}${ext}`;
      if (!ocupados.has(nombre)) return nombre;
    }
  }
  const prefijo = clase === 'comprobante' ? 'comprobante' : 'foto';
  for (let n = 1; ; n++) {
    const nombre = `${prefijo}_${String(fecha).slice(0, 10)}_${n}${ext}`;
    if (!ocupados.has(nombre)) return nombre;
  }
}

/**
 * Decide dónde va un archivo (sin escribirlo): { relativa, absoluta, carpeta }. Crea la carpeta. `clase`: cartola | comprobante | foto.
 */
export async function destinoEnCuenta({ cuenta = null, clase, fecha = fechaHoySantiago(), extension }) {
  const carpetaRel = carpetaRelativaDeCuenta(cuenta, fecha);
  const carpeta = path.join(rutaRaiz(), carpetaRel);
  if (!dentroDe(rutaRaiz(), carpeta)) throw new Error('la ruta queda fuera del almacenamiento');
  await fs.mkdir(carpeta, { recursive: true });
  let ocupados = new Set();
  try {
    ocupados = new Set(await fs.readdir(carpeta));
  } catch {
    // carpeta recién creada
  }
  const nombre = nombreDeArchivo(clase, fecha, extension, ocupados);
  return { relativa: `${carpetaRel}/${nombre}`, absoluta: path.join(carpeta, nombre), carpeta };
}

/** Guarda un buffer en la estructura por cuenta. Devuelve { ruta (relativa para la BD), absoluta, nombre }. Nunca sobrescribe. */
export async function guardarEnCuenta({ cuenta = null, clase, fecha, nombreOriginal = '', buffer }) {
  const extension = path.extname(nombreSeguro(nombreOriginal)) || (clase === 'cartola' ? '.pdf' : '.jpg');
  for (let intento = 0; ; intento++) {
    const d = await destinoEnCuenta({ cuenta, clase, fecha, extension });
    try {
      await fs.writeFile(d.absoluta, buffer, { flag: 'wx' });
      return { ruta: d.relativa, absoluta: d.absoluta, nombre: path.basename(d.absoluta) };
    } catch (error) {
      // Otro archivo ocupó el nombre entre medio: se vuelve a elegir
      if (error.code !== 'EEXIST' || intento >= 5) throw error;
    }
  }
}

// ---------------------------------------------------------------------------
// Resolver y borrar (incluye las rutas anteriores)
// ---------------------------------------------------------------------------

function basesConocidas() {
  const bases = [
    rutaRaiz(),
    ...TIPOS.map(carpetaBase),
    UPLOADS_ANTERIOR
  ];
  if (process.env.UPLOADS_PATH) bases.push(path.resolve(process.env.UPLOADS_PATH));
  return bases;
}

async function existe(ruta) {
  try {
    await fs.access(ruta);
    return true;
  } catch {
    return false;
  }
}

/**
 * Ruta absoluta de un archivo guardado, o null si no existe o queda fuera del almacenamiento.
 * Acepta:
 *  - la ruta nueva: comprobantes/2026-11/archivo.jpg (cartolas/..., archivos/...)
 *  - la anterior de la API y del bot: /uploads/respaldos/<archivo>
 *  - una ruta absoluta anterior (ruta_archivo de las cartolas)
 *  - un nombre suelto anterior (cartolas)
 */
export async function resolverArchivo(valor) {
  if (!valor || typeof valor !== 'string') return null;
  const texto = valor.trim().replace(/\\/g, '/');
  const candidatas = [];

  const nueva = /^(cartolas|comprobantes|archivos)\/(.+)$/.exec(texto);
  if (nueva) {
    candidatas.push({ base: carpetaBase(nueva[1]), relativa: nueva[2] });
  } else if (/^(?:cuentas|sin-cuenta|papelera)\//.test(texto)) {
    // Estructura nueva: relativa a la raíz
    candidatas.push({ base: rutaRaiz(), relativa: texto });
  } else if (/^\/?uploads\/respaldos\//.test(texto)) {
    const nombre = path.basename(texto);
    const bases = [path.join(UPLOADS_ANTERIOR, 'respaldos')];
    if (process.env.RESPALDOS_PATH) bases.unshift(path.resolve(process.env.RESPALDOS_PATH));
    for (const base of bases) candidatas.push({ base, relativa: nombre });
  } else if (path.isAbsolute(texto)) {
    for (const base of basesConocidas()) {
      if (dentroDe(base, texto)) candidatas.push({ base, relativa: path.relative(base, texto) });
    }
  } else {
    const nombre = path.basename(texto);
    const bases = [path.join(UPLOADS_ANTERIOR, 'cartolas'), path.join(UPLOADS_ANTERIOR, 'respaldos')];
    if (process.env.CARTOLAS_PATH) bases.unshift(path.resolve(process.env.CARTOLAS_PATH));
    for (const base of bases) candidatas.push({ base, relativa: nombre });
  }

  for (const { base, relativa } of candidatas) {
    const absoluta = path.resolve(base, relativa);
    if (dentroDe(base, absoluta) && await existe(absoluta)) return absoluta;
  }
  return null;
}

/** Borra un archivo guardado (si existe). Nunca lanza ni registra el nombre. true si lo borró. */
export async function borrarArchivo(valor) {
  try {
    const absoluta = await resolverArchivo(valor);
    if (!absoluta) return false;
    await fs.unlink(absoluta);
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Arranque
// ---------------------------------------------------------------------------

let avisoEmitido = false;

/**
 * Crea la raíz, tmp/ y las carpetas del mes actual de cada tipo (mkdir recursive) y avisa
 * si CARTOLAS_PATH o RESPALDOS_PATH siguen definidas. No lanza: si una carpeta no se puede
 * crear, registra solo el código del error.
 */
export async function ensureStorageDirs() {
  if (!avisoEmitido) {
    avisoEmitido = true;
    for (const tipo of Object.keys(VARIABLE_OBSOLETA)) {
      if (variableObsoleta(tipo)) {
        console.warn(`[storage] ${VARIABLE_OBSOLETA[tipo]} está obsoleta: usa FINANZAS_STORAGE. Por ahora sigue mandando para ${tipo}.`);
      }
    }
  }

  const carpetas = [rutaRaiz(), carpetaTmp()];
  for (const tipo of TIPOS) carpetas.push(path.join(carpetaBase(tipo), mesRecepcion()));

  for (const carpeta of carpetas) {
    try {
      await fs.mkdir(carpeta, { recursive: true });
    } catch (error) {
      console.error(`[storage] no se pudo crear una carpeta: error_code=${error.code ?? 'desconocido'}`);
    }
  }
}

// ---------------------------------------------------------------------------
// Temporales: archivos sin confirmar (tmp/) y su limpieza
// ---------------------------------------------------------------------------

const EDAD_MAXIMA_TMP_MS = 24 * 60 * 60 * 1000;

/**
 * Guarda un archivo pendiente de confirmación en <raíz>/tmp. Devuelve { ruta, absoluta }, con la
 * ruta relativa a la raíz (tmp/<archivo>).
 */
export async function guardarTemporal(nombreSugerido, buffer) {
  const carpeta = carpetaTmp();
  await fs.mkdir(carpeta, { recursive: true });

  const nombre = `${Date.now()}-${crypto.randomBytes(4).toString('hex')}-${nombreSeguro(nombreSugerido)}`;
  const absoluta = path.join(carpeta, nombre);
  if (!dentroDe(carpeta, absoluta)) throw new Error('la ruta queda fuera del almacenamiento');

  await fs.writeFile(absoluta, buffer, { flag: 'wx' });
  return { ruta: `tmp/${nombre}`, absoluta };
}

/** Ruta absoluta de un temporal (tmp/<archivo>) o null si no es válida o no existe */
async function resolverTemporal(ruta) {
  const m = /^tmp\/([^/]+)$/.exec(String(ruta ?? '').replace(/\\/g, '/'));
  if (!m) return null;
  const absoluta = path.join(carpetaTmp(), path.basename(m[1]));
  return dentroDe(carpetaTmp(), absoluta) && await existe(absoluta) ? absoluta : null;
}

/**
 * Confirma un temporal: lo mueve a <tipo>/<mes de hoy>/ (mes de recepción en hora de Chile) y
 * devuelve la ruta relativa definitiva. Quita el prefijo de tiempo del nombre temporal.
 */
export async function confirmarTemporal(ruta, tipo = 'cartolas', { prefijo = '', destino: dondeVa = null } = {}) {
  const origen = await resolverTemporal(ruta);
  if (!origen) throw new Error('el archivo temporal ya no existe');

  // Estructura por cuenta: cuentas/<tipo>-<titular>-<últimos4>/<año>/<mes>/cartola_YYYY-MM.pdf (o sin-cuenta/...)
  if (dondeVa) {
    const d = await destinoEnCuenta({
      cuenta: dondeVa.cuenta ?? null,
      clase: dondeVa.clase ?? 'cartola',
      fecha: dondeVa.fecha ?? fechaHoySantiago(),
      extension: path.extname(origen) || '.pdf'
    });
    try {
      await fs.rename(origen, d.absoluta);
    } catch (error) {
      if (error.code !== 'EXDEV') throw error;
      await fs.copyFile(origen, d.absoluta);
      await fs.unlink(origen);
    }
    return d.relativa;
  }

  const base = carpetaBase(tipo);
  const mes = mesRecepcion();
  const carpeta = await carpetaDelMes(tipo, mes);
  // tmp/<timestamp>-<aleatorio>-<nombre> -> <prefijo><nombre>
  const limpio = path.basename(origen).replace(/^\d+-[0-9a-f]{8}-/, '');
  let nombre = nombreSeguro(`${prefijo}${limpio}`);
  let destino = path.join(carpeta, nombre);

  for (let intento = 0; ; intento++) {
    if (!dentroDe(base, destino)) throw new Error('la ruta queda fuera del almacenamiento');
    if (!(await existe(destino))) break;
    if (intento >= 5) throw new Error('no se pudo elegir un nombre libre');
    const extension = path.extname(nombre);
    nombre = `${nombre.slice(0, nombre.length - extension.length)}-${crypto.randomBytes(3).toString('hex')}${extension}`;
    destino = path.join(carpeta, nombre);
  }

  try {
    await fs.rename(origen, destino);
  } catch (error) {
    if (error.code !== 'EXDEV') throw error;
    await fs.copyFile(origen, destino);
    await fs.unlink(origen);
  }
  return rutaRelativa(tipo, mes, nombre);
}

/** Borra un temporal sin confirmar; nunca lanza */
export async function borrarTemporal(ruta) {
  try {
    const absoluta = await resolverTemporal(ruta);
    if (!absoluta) return false;
    await fs.unlink(absoluta);
    return true;
  } catch {
    return false;
  }
}

/**
 * "Papelera" para poder deshacer una eliminación: mueve un archivo guardado a tmp/ (que se limpia
 * a las 24 horas, igual que la ventana de deshacer) y le renueva la fecha para que ese plazo
 * cuente desde ahora. Devuelve la ruta tmp/<archivo> o null si no había archivo. Nunca lanza.
 */
export async function enviarAPapelera(valor) {
  try {
    const origen = await resolverArchivo(valor);
    if (!origen) return null;
    const carpeta = carpetaTmp();
    await fs.mkdir(carpeta, { recursive: true });
    const nombre = `${Date.now()}-${crypto.randomBytes(4).toString('hex')}-${nombreSeguro(path.basename(origen))}`;
    const destino = path.join(carpeta, nombre);
    try {
      await fs.rename(origen, destino);
    } catch (error) {
      if (error.code !== 'EXDEV') throw error;
      await fs.copyFile(origen, destino);
      await fs.unlink(origen);
    }
    const ahora = new Date();
    await fs.utimes(destino, ahora, ahora).catch(() => {});
    return `tmp/${nombre}`;
  } catch (error) {
    console.error(`[storage] papelera: error_code=${error.code ?? 'desconocido'}`);
    return null;
  }
}

/**
 * Devuelve un archivo de la papelera a su ruta relativa original (cartolas/2026-11/x.pdf, etc.).
 * Solo restaura rutas nuevas (<tipo>/<mes>/<archivo>). true si lo restauró. Nunca lanza.
 */
export async function restaurarDePapelera(rutaTmp, rutaOriginal) {
  try {
    const origen = await resolverTemporal(rutaTmp);
    const texto = String(rutaOriginal ?? '').replace(/\\/g, '/');
    const m = /^(cartolas|comprobantes|archivos)\/(.+)$/.exec(texto) ?? /^((?:cuentas|sin-cuenta))\/(.+)$/.exec(texto);
    if (!origen || !m) return false;
    // La estructura nueva cuelga de la raíz y la ruta se conserva entera
    const base = TIPOS.includes(m[1]) ? carpetaBase(m[1]) : rutaRaiz();
    const destino = path.resolve(base, TIPOS.includes(m[1]) ? m[2] : texto);
    if (!dentroDe(base, destino) || await existe(destino)) return false;
    await fs.mkdir(path.dirname(destino), { recursive: true });
    try {
      await fs.rename(origen, destino);
    } catch (error) {
      if (error.code !== 'EXDEV') throw error;
      await fs.copyFile(origen, destino);
      await fs.unlink(origen);
    }
    return true;
  } catch (error) {
    console.error(`[storage] restaurar de papelera: error_code=${error.code ?? 'desconocido'}`);
    return false;
  }
}

/**
 * Borra de tmp/ los archivos con más de 24 horas (o `maxEdadMs`). Devuelve cuántos borró.
 * No registra nombres; nunca lanza.
 */
export async function limpiarTemporales(maxEdadMs = EDAD_MAXIMA_TMP_MS) {
  let borrados = 0;
  try {
    const carpeta = carpetaTmp();
    const entradas = await fs.readdir(carpeta, { withFileTypes: true });
    const limite = Date.now() - maxEdadMs;
    for (const entrada of entradas) {
      if (!entrada.isFile()) continue;
      const absoluta = path.join(carpeta, entrada.name);
      try {
        if ((await fs.stat(absoluta)).mtimeMs < limite) {
          await fs.unlink(absoluta);
          borrados++;
        }
      } catch {
        // si un archivo no se puede revisar o borrar, se sigue con el resto
      }
    }
  } catch (error) {
    if (error.code !== 'ENOENT') {
      console.error(`[storage] limpieza de tmp: error_code=${error.code ?? 'desconocido'}`);
    }
  }
  return borrados;
}

let temporizadorLimpieza = null;

/**
 * Limpia tmp/ al arrancar y luego cada hora, sin dependencias nuevas. El temporizador no
 * mantiene vivo el proceso.
 */
export function iniciarLimpiezaTemporales() {
  if (temporizadorLimpieza) return;
  const ejecutar = async () => {
    const n = await limpiarTemporales();
    if (n > 0) console.log(`[storage] se borraron ${n} archivos temporales sin confirmar`);
  };
  ejecutar();
  temporizadorLimpieza = setInterval(ejecutar, 60 * 60 * 1000);
  temporizadorLimpieza.unref?.();
}
