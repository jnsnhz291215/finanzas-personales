/**
 * Migración segura del almacenamiento a la estructura por cuenta (ver storage.js):
 *
 *   cuentas/<tipo>-<titular>-<últimos4>/<año>/<mes>/cartola_2026-08.pdf | comprobante_2026-08-19_1.jpg | foto_2026-08-19_1.jpg
 *   sin-cuenta/<año>/<mes>/                       lo que no tiene cuenta
 *
 * Qué mueve: las cartolas importadas (archivos_importados.ruta_archivo, y movimientos.importado_de que la repite), los comprobantes
 * (movimientos.archivo_respaldo) y los archivos que no están en la BD (cartolas que no se pudieron leer, fotos). Se puede volver a ejecutar:
 * lo que ya está en su lugar no se mueve, y un comprobante que estaba en sin-cuenta pasa a la carpeta de su cuenta cuando el movimiento ya la tiene.
 *
 * Seguridad:
 *  - Por defecto solo muestra qué haría. Con --aplicar mueve.
 *  - Antes de mover verifica que cada archivo de origen exista y que cada destino esté libre; si algo no calza, no mueve nada.
 *  - Los archivos se mueven, se verifican (destino existe, origen ya no, mismo tamaño) y recién entonces se actualiza la BD en UNA
 *    transacción; se vuelve a verificar la BD. Si algo falla en cualquier punto, devuelve los archivos y deshace la BD.
 *  - Guarda un log de lo movido en <FINANZAS_STORAGE>/respaldos/migracion-storage-<fecha>.json (permisos 600).
 *  - No imprime nombres ni rutas: solo cantidades.
 *
 * Uso: node server/migrarStorage.js            (simula)
 *      node server/migrarStorage.js --aplicar  (mueve)
 */

import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import {
  rutaRaiz, TIPOS, carpetaBase, dentroDe, resolverArchivo, carpetaRelativaDeCuenta, nombreDeArchivo
} from './storage.js';
import { fechaHoySantiago } from './telegram/fechas.js';

async function bd() {
  return import('./db.js');
}

const CLASE_POR_TIPO = { cartolas: 'cartola', comprobantes: 'comprobante', archivos: 'foto' };

/** Fecha YYYY-MM-DD en hora de Chile de un instante */
export function fechaChile(ms) {
  return new Date(ms).toLocaleDateString('en-CA', { timeZone: 'America/Santiago' });
}

// ---------------------------------------------------------------------------
// Plan (puro)
// ---------------------------------------------------------------------------

/**
 * Arma el plan de movimientos. `items`: [{ origen (ruta relativa a la raíz), clase, cuenta|null, fecha, extension, valores: [valores que la BD
 * guarda hoy para ese archivo] }] sin repetir archivos. `ocupados`: Map carpetaRelativa -> Set de nombres que ya existen allí.
 * Devuelve [{ origen, destino, valores }] sin los que ya están en su lugar. No toca el disco.
 */
export function planificar(items, ocupados = new Map()) {
  const plan = [];
  for (const it of items) {
    const carpeta = carpetaRelativaDeCuenta(it.cuenta, it.fecha);
    // Ya está en la carpeta que le corresponde: no se mueve
    if (path.posix.dirname(it.origen) === carpeta) continue;
    const usados = ocupados.get(carpeta) ?? new Set();
    const nombre = nombreDeArchivo(it.clase, it.fecha, it.extension, usados);
    usados.add(nombre);
    ocupados.set(carpeta, usados);
    plan.push({ origen: it.origen, destino: `${carpeta}/${nombre}`, valores: it.valores ?? [] });
  }
  return plan;
}

/** Revisa el plan sin tocar nada: que no haya destinos repetidos y que cada destino quede dentro de la raíz */
export function validarPlan(plan) {
  const destinos = new Set();
  const problemas = [];
  for (const p of plan) {
    if (destinos.has(p.destino)) problemas.push('destino repetido');
    destinos.add(p.destino);
    if (!dentroDe(rutaRaiz(), path.join(rutaRaiz(), p.destino))) problemas.push('destino fuera del almacenamiento');
  }
  return problemas;
}

/** Sentencias SQL que actualizan las rutas de la BD (y las deshacen si se invierte el mapa) */
export function sentenciasDeRutas(plan, invertir = false) {
  const sentencias = [];
  for (const p of plan) {
    const nuevo = invertir ? p.origen : p.destino;
    for (const viejo of invertir ? [p.destino] : p.valores) {
      sentencias.push(
        { sql: 'UPDATE archivos_importados SET ruta_archivo = ? WHERE ruta_archivo = ?', params: [nuevo, viejo] },
        { sql: 'UPDATE movimientos SET importado_de = ? WHERE importado_de = ?', params: [nuevo, viejo] },
        { sql: 'UPDATE movimientos SET archivo_respaldo = ? WHERE archivo_respaldo = ?', params: [nuevo, viejo] },
        { sql: 'UPDATE historial_cambios SET antes = REPLACE(antes, ?, ?) WHERE antes LIKE ?', params: [viejo, nuevo, `%${viejo}%`] },
        { sql: 'UPDATE historial_cambios SET despues = REPLACE(despues, ?, ?) WHERE despues LIKE ?', params: [viejo, nuevo, `%${viejo}%`] }
      );
    }
  }
  return sentencias;
}

// ---------------------------------------------------------------------------
// Inventario (lee BD y disco)
// ---------------------------------------------------------------------------

async function existe(ruta) {
  try {
    await fs.access(ruta);
    return true;
  } catch {
    return false;
  }
}

/** Ruta relativa a la raíz de un archivo absoluto, o null si queda fuera */
function relativaARaiz(absoluta) {
  return dentroDe(rutaRaiz(), absoluta) ? path.relative(rutaRaiz(), absoluta).split(path.sep).join('/') : null;
}

async function recorrer(carpeta) {
  const salida = [];
  let entradas;
  try {
    entradas = await fs.readdir(carpeta, { withFileTypes: true });
  } catch {
    return salida;
  }
  for (const e of entradas) {
    const ruta = path.join(carpeta, e.name);
    if (e.isDirectory()) salida.push(...await recorrer(ruta));
    else if (e.isFile()) salida.push(ruta);
  }
  return salida;
}

/** Junta lo que hay que mover: archivos referenciados por la BD y archivos huérfanos de las carpetas de tipo */
export async function construirInventario() {
  const { query } = await bd();
  const [cuentasFilas] = await query('SELECT id, tipo, titular, ultimos4, ultimos4_cuenta FROM cuentas');
  const cuentas = new Map(cuentasFilas.map(c => [Number(c.id), c]));

  const porArchivo = new Map(); // absoluta -> item
  const sinResolver = [];
  const agregar = (absoluta, item, valor) => {
    const existente = porArchivo.get(absoluta);
    if (existente) {
      existente.valores.add(valor);
      // Si otro registro sí conoce la cuenta, se prefiere
      if (!existente.cuenta && item.cuenta) Object.assign(existente, { cuenta: item.cuenta, fecha: item.fecha, clase: item.clase });
      return;
    }
    porArchivo.set(absoluta, { ...item, valores: new Set([valor]) });
  };

  // Cartolas importadas
  const [archivos] = await query(
    `SELECT a.id, a.ruta_archivo, a.cuenta_id, a.periodo_hasta, a.fecha_importacion,
            (SELECT MAX(m.fecha) FROM movimientos m WHERE m.importado_de = a.ruta_archivo) AS ultimo_mov
     FROM archivos_importados a WHERE a.ruta_archivo IS NOT NULL AND a.ruta_archivo <> ''`
  );
  for (const a of archivos) {
    const absoluta = await resolverArchivo(a.ruta_archivo);
    if (!absoluta) { sinResolver.push('cartola'); continue; }
    const fecha = String(a.periodo_hasta ?? a.ultimo_mov ?? a.fecha_importacion ?? fechaHoySantiago()).slice(0, 10);
    agregar(absoluta, { clase: 'cartola', cuenta: cuentas.get(Number(a.cuenta_id)) ?? null, fecha, extension: path.extname(absoluta) }, a.ruta_archivo);
  }

  // Comprobantes de movimientos
  const [respaldos] = await query(
    `SELECT id, cuenta_id, fecha, archivo_respaldo FROM movimientos WHERE archivo_respaldo IS NOT NULL AND archivo_respaldo <> ''`
  );
  for (const m of respaldos) {
    const absoluta = await resolverArchivo(m.archivo_respaldo);
    if (!absoluta) { sinResolver.push('comprobante'); continue; }
    agregar(absoluta, { clase: 'comprobante', cuenta: cuentas.get(Number(m.cuenta_id)) ?? null, fecha: String(m.fecha).slice(0, 10), extension: path.extname(absoluta) }, m.archivo_respaldo);
  }

  // Archivos que la BD no menciona, en las carpetas de tipo
  for (const tipo of TIPOS) {
    for (const absoluta of await recorrer(carpetaBase(tipo))) {
      if (porArchivo.has(absoluta)) continue;
      const stat = await fs.stat(absoluta);
      agregar(absoluta, { clase: CLASE_POR_TIPO[tipo], cuenta: null, fecha: fechaChile(stat.mtimeMs), extension: path.extname(absoluta) }, `\u0000huerfano:${absoluta}`);
    }
  }

  // Archivos que ya están en la estructura nueva se revisan también (por si ahora conocen su cuenta), pero solo los de sin-cuenta
  const items = [];
  const ocupados = new Map();
  for (const [absoluta, it] of porArchivo) {
    const rel = relativaARaiz(absoluta);
    if (!rel) { sinResolver.push('fuera de la raíz'); continue; }
    items.push({ ...it, origen: rel, valores: [...it.valores].filter(v => !v.startsWith('\u0000')) });
  }
  // Nombres que ya existen en cada carpeta destino (para no pisar nada)
  for (const it of items) {
    const carpeta = carpetaRelativaDeCuenta(it.cuenta, it.fecha);
    if (!ocupados.has(carpeta)) {
      try {
        ocupados.set(carpeta, new Set(await fs.readdir(path.join(rutaRaiz(), carpeta))));
      } catch {
        ocupados.set(carpeta, new Set());
      }
    }
  }
  return { items, ocupados, sinResolver };
}

// ---------------------------------------------------------------------------
// Ejecución
// ---------------------------------------------------------------------------

async function moverArchivo(origenRel, destinoRel) {
  const origen = path.join(rutaRaiz(), origenRel);
  const destino = path.join(rutaRaiz(), destinoRel);
  await fs.mkdir(path.dirname(destino), { recursive: true });
  const tamano = (await fs.stat(origen)).size;
  try {
    await fs.rename(origen, destino);
  } catch (error) {
    if (error.code !== 'EXDEV') throw error;
    await fs.copyFile(origen, destino);
    if ((await fs.stat(destino)).size !== tamano) throw new Error('la copia no coincide');
    await fs.unlink(origen);
  }
  if (!(await existe(destino)) || await existe(origen) || (await fs.stat(destino)).size !== tamano) throw new Error('el archivo no quedó donde debía');
}

async function guardarLog(contenido, nombre = null) {
  const carpeta = path.join(rutaRaiz(), 'respaldos');
  await fs.mkdir(carpeta, { recursive: true });
  const sello = new Date().toISOString().replace(/[-:]/g, '').replace(/\..+$/, '').replace('T', '_');
  const archivo = nombre ?? `migracion-storage-${sello}.json`;
  await fs.writeFile(path.join(carpeta, archivo), JSON.stringify(contenido), { mode: 0o600 });
  return archivo;
}

/**
 * Migra al orden por cuenta. `aplicar` false = solo simula. Devuelve { movidos, yaEnSuLugar, sinResolver, aplicado, log } o lanza si algo
 * no calzó (en ese caso no queda nada movido).
 */
export async function migrarStorage({ aplicar = false } = {}) {
  const { items, ocupados, sinResolver } = await construirInventario();
  const plan = planificar(items, ocupados);
  const resumen = { total: items.length, movidos: plan.length, yaEnSuLugar: items.length - plan.length, sinResolver: sinResolver.length, aplicado: false, log: null };

  // Verificación previa: ninguno de los archivos de origen falta y ningún destino existe
  const problemas = validarPlan(plan);
  for (const p of plan) {
    if (!(await existe(path.join(rutaRaiz(), p.origen)))) problemas.push('falta un archivo de origen');
    if (await existe(path.join(rutaRaiz(), p.destino))) problemas.push('un destino ya existe');
  }
  if (problemas.length > 0) throw new Error(`la migración no es segura, no moví nada (${[...new Set(problemas)].join(', ')})`);
  if (!aplicar || plan.length === 0) return resumen;

  const registro = { version: 1, inicio: new Date().toISOString(), estado: 'en curso', movimientos: plan.map(p => ({ origen: p.origen, destino: p.destino })) };
  const nombreLog = await guardarLog(registro);

  const hechos = [];
  const revertirArchivos = async () => {
    for (const h of [...hechos].reverse()) await moverArchivo(h.destino, h.origen).catch(() => {});
  };

  try {
    for (const p of plan) {
      await moverArchivo(p.origen, p.destino);
      hechos.push(p);
    }
    const { ejecutarEnTransaccion } = await import('./resetCuenta.js');
    await ejecutarEnTransaccion(sentenciasDeRutas(plan));

    // Verificación posterior de la BD: nada debe seguir apuntando a las rutas viejas
    const { query } = await bd();
    for (const p of plan) {
      for (const viejo of p.valores) {
        const [archivosAun] = await query('SELECT COUNT(*) AS n FROM archivos_importados WHERE ruta_archivo = ?', [viejo]);
        const [movsAun] = await query('SELECT COUNT(*) AS n FROM movimientos WHERE importado_de = ? OR archivo_respaldo = ?', [viejo, viejo]);
        if (Number(archivosAun[0]?.n ?? 0) > 0 || Number(movsAun[0]?.n ?? 0) > 0) throw new Error('la BD sigue apuntando a una ruta vieja');
      }
    }
  } catch (error) {
    // Se devuelve todo a como estaba
    try {
      const { ejecutarEnTransaccion } = await import('./resetCuenta.js');
      await ejecutarEnTransaccion(sentenciasDeRutas(plan, true));
    } catch {
      // si las rutas aún no se habían cambiado, no hay nada que devolver
    }
    await revertirArchivos();
    await guardarLog({ ...registro, estado: 'revertida', error: error.code ?? error.message }, nombreLog);
    throw new Error('la migración falló y devolví todo a su lugar');
  }

  await guardarLog({ ...registro, estado: 'completada', fin: new Date().toISOString() }, nombreLog);
  return { ...resumen, aplicado: true, log: nombreLog };
}

// ---------------------------------------------------------------------------
// Línea de comandos
// ---------------------------------------------------------------------------

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const aplicar = process.argv.includes('--aplicar');
  migrarStorage({ aplicar })
    .then(r => {
      console.log(`${aplicar ? 'Migración aplicada' : 'Simulación'}: ${r.total} archivos revisados, ${r.movidos} ${aplicar ? 'movidos' : 'por mover'}, ${r.yaEnSuLugar} ya en su lugar, ${r.sinResolver} registros sin archivo.`);
      if (r.log) console.log('Log guardado en la carpeta respaldos/ del almacenamiento.');
      if (!aplicar) console.log('Para mover: node server/migrarStorage.js --aplicar');
      process.exit(0);
    })
    .catch(error => {
      console.error(`Error: ${error.message}`);
      process.exit(1);
    });
}
