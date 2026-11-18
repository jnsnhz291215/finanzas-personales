/**
 * Almacenamiento de archivos bajo una sola raíz configurable (FINANZAS_STORAGE), ordenado
 * por tipo y por mes de recepción (America/Santiago):
 *
 *   <raíz>/cartolas/{YYYY-MM}/       cartolas importadas (web y bot)
 *   <raíz>/comprobantes/{YYYY-MM}/   comprobantes de cuotas y respaldos de movimientos
 *   <raíz>/archivos/{YYYY-MM}/       otros archivos que se mandan al bot
 *   <raíz>/tmp/                      temporales
 *
 * En la BD se guarda la ruta relativa a la raíz, por ejemplo
 * comprobantes/2026-11/respaldo_cuota_123_foto.jpg. Las variables CARTOLAS_PATH y
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
