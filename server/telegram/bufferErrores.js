/**
 * Últimas líneas de error del propio proceso (para /mantenimiento > "Últimos errores del bot").
 *
 * Envuelve console.error una sola vez: cada línea se guarda ya saneada (sin tokens, keys, URLs, RUT, rutas ni números largos) en un buffer
 * circular en memoria, y además se sigue escribiendo donde siempre. Si existe el log de errores de PM2 (logs/err.log, ruta fija junto a la
 * app, ver ecosystem.config.cjs) se lee de ahí; si no, del buffer.
 */

import fs from 'fs/promises';
import path from 'path';
import util from 'util';
import { fileURLToPath } from 'url';
import { sanear } from './errores.js';

const MAX_LINEAS_BUFFER = 300;
const LEER_BYTES = 96 * 1024;
const MAX_LARGO_LINEA = 240;

const lineas = [];
let instalado = false;

/** Ruta fija del log de errores de PM2 (ecosystem.config.cjs: error_file ./logs/err.log, relativo a la carpeta de la app) */
export const RUTA_LOG_ERRORES = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'logs', 'err.log');

/** Recorta y sanea una línea para mostrarla */
export function limpiarLinea(linea) {
  return sanear(String(linea).replace(/\s+$/g, '')).slice(0, MAX_LARGO_LINEA);
}

export function instalarBufferErrores() {
  if (instalado) return;
  instalado = true;
  const original = console.error.bind(console);
  console.error = (...args) => {
    try {
      for (const l of util.format(...args).split('\n')) {
        if (!l.trim()) continue;
        lineas.push(`${new Date().toISOString().slice(0, 19)} ${limpiarLinea(l)}`);
      }
      if (lineas.length > MAX_LINEAS_BUFFER) lineas.splice(0, lineas.length - MAX_LINEAS_BUFFER);
    } catch {
      // el buffer nunca debe romper un log
    }
    original(...args);
  };
}

/** Últimas `n` líneas (saneadas) del buffer en memoria */
export function lineasDelBuffer(n = 30) {
  return lineas.slice(-n);
}

/**
 * Últimas `n` líneas de error: del log de PM2 si existe y tiene algo; si no, del buffer en memoria.
 * Devuelve { origen: 'log de PM2' | 'memoria', lineas }. Solo lee el final del archivo (96 KB).
 */
export async function ultimasLineasDeError(n = 30, ruta = RUTA_LOG_ERRORES) {
  try {
    const archivo = await fs.open(ruta, 'r');
    try {
      const { size } = await archivo.stat();
      const desde = Math.max(0, size - LEER_BYTES);
      const buffer = Buffer.alloc(size - desde);
      await archivo.read(buffer, 0, buffer.length, desde);
      const todas = buffer.toString('utf8').split('\n').filter(l => l.trim());
      // Si se empezó a leer a mitad de archivo, la primera línea puede venir cortada
      if (desde > 0) todas.shift();
      if (todas.length > 0) return { origen: 'log de PM2', lineas: todas.slice(-n).map(limpiarLinea) };
    } finally {
      await archivo.close();
    }
  } catch {
    // sin archivo (por ejemplo en desarrollo): se usa el buffer
  }
  return { origen: 'memoria', lineas: lineasDelBuffer(n) };
}
