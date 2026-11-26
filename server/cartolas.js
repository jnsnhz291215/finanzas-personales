/**
 * Lectura y registro de cartolas, compartido por la API web (routes/importar.js) y el bot.
 * Las funciones de parseo se movieron desde importar.js sin cambios de lógica.
 * La BD se importa de forma diferida para poder cargar las funciones puras sin base de datos.
 */

import crypto from 'crypto';
import { parse } from 'csv-parse/sync';
import xlsx from 'xlsx';
import pdfParse from 'pdf-parse';
import { resolverTipos } from './tiposMovimiento.js';
import { buscarBanco, normalizar } from './telegram/cuentas.js';

// Parsear CSV
export function parsearCSV(buffer, encoding = 'utf8') {
  const content = buffer.toString(encoding);
  return parse(content, {
    columns: true,
    skip_empty_lines: true,
    trim: true,
    bom: true,
    relax_column_count: true
  });
}

// Parsear Excel
export function parsearExcel(buffer) {
  const workbook = xlsx.read(buffer, { type: 'buffer' });
  const sheetName = workbook.SheetNames[0];
  const sheet = workbook.Sheets[sheetName];
  return xlsx.utils.sheet_to_json(sheet);
}

// Parsear PDF (básico - extrae texto y busca patrones)
export async function parsearPDF(buffer) {
  const data = await pdfParse(buffer);
  const lineas = data.text.split('\n').filter(l => l.trim());
  
  // Intentar detectar movimientos con patrones comunes
  const movimientos = [];
  const patronFecha = /(\d{1,2}[-/]\d{1,2}[-/]\d{2,4})/;
  const patronMonto = /\$?\s*([\d.,]+)/;
  
  for (let i = 0; i < lineas.length; i++) {
    const linea = lineas[i];
    const matchFecha = linea.match(patronFecha);
    const matchMonto = linea.match(patronMonto);
    
    if (matchFecha && matchMonto) {
      movimientos.push({
        fecha_raw: matchFecha[1],
        descripcion: linea.replace(patronFecha, '').replace(patronMonto, '').trim(),
        monto_raw: matchMonto[1]
      });
    }
  }
  
  return movimientos;
}

// Normalizar fecha
export function normalizarFecha(fechaStr) {
  if (!fechaStr) return null;
  
  // Intentar varios formatos
  const formatos = [
    /(\d{1,2})[-/](\d{1,2})[-/](\d{4})/,  // DD-MM-YYYY o DD/MM/YYYY
    /(\d{1,2})[-/](\d{1,2})[-/](\d{2})/,  // DD-MM-YY o DD/MM/YY
    /(\d{4})[-/](\d{1,2})[-/](\d{1,2})/   // YYYY-MM-DD
  ];
  
  for (const formato of formatos) {
    const match = fechaStr.match(formato);
    if (match) {
      let dia, mes, anio;
      
      if (match[1].length === 4) {
        // YYYY-MM-DD
        anio = match[1];
        mes = match[2].padStart(2, '0');
        dia = match[3].padStart(2, '0');
      } else {
        // DD-MM-YYYY o DD-MM-YY
        dia = match[1].padStart(2, '0');
        mes = match[2].padStart(2, '0');
        anio = match[3];
        
        if (anio.length === 2) {
          anio = parseInt(anio) < 50 ? `20${anio}` : `19${anio}`;
        }
      }
      
      return `${anio}-${mes}-${dia}`;
    }
  }
  
  return null;
}

// Normalizar monto
export function normalizarMonto(montoStr) {
  if (!montoStr) return 0;
  
  const str = montoStr.toString().trim();
  // Eliminar símbolos de moneda y espacios
  const limpio = str.replace(/[$\s]/g, '').replace(/\./g, '').replace(',', '.');
  return parseFloat(limpio) || 0;
}

// Detectar formato automáticamente
export function detectarFormato(datos) {
  if (!datos || datos.length === 0) return null;
  
  const primeraFila = datos[0];
  const columnas = Object.keys(primeraFila).map(k => k.toLowerCase());
  
  // Banco de Chile
  if (columnas.some(c => c.includes('fecha') && c.includes('contable')) ||
      columnas.some(c => c.includes('cargo') || c.includes('abono'))) {
    return {
      banco: 'Banco de Chile',
      mapeo: {
        fecha: columnas.find(c => c.includes('fecha')),
        descripcion: columnas.find(c => c.includes('descripcion') || c.includes('detalle') || c.includes('glosa')),
        cargo: columnas.find(c => c.includes('cargo')),
        abono: columnas.find(c => c.includes('abono'))
      }
    };
  }
  
  // Banco Falabella / CMR
  if (columnas.some(c => c.includes('establecimiento')) ||
      columnas.some(c => c.includes('comercio'))) {
    return {
      banco: 'Banco Falabella',
      mapeo: {
        fecha: columnas.find(c => c.includes('fecha')),
        descripcion: columnas.find(c => c.includes('establecimiento') || c.includes('comercio') || c.includes('descripcion')),
        monto: columnas.find(c => c.includes('monto') || c.includes('importe'))
      }
    };
  }
  
  // Formato genérico
  return {
    banco: 'Genérico',
    mapeo: {
      fecha: columnas.find(c => c.includes('fecha')),
      descripcion: columnas.find(c => c.includes('descripcion') || c.includes('detalle') || c.includes('concepto')),
      monto: columnas.find(c => c.includes('monto') || c.includes('importe') || c.includes('valor')),
      cargo: columnas.find(c => c.includes('cargo') || c.includes('debe')),
      abono: columnas.find(c => c.includes('abono') || c.includes('haber'))
    }
  };
}

// Procesar datos según formato
export function procesarDatos(datos, formato, mapeoCustom = null) {
  const mapeo = mapeoCustom || formato.mapeo;
  const movimientos = [];
  
  for (const fila of datos) {
    let fecha = null;
    let descripcion = '';
    let monto = 0;
    let tipo = 'cargo';
    
    // Extraer fecha
    if (mapeo.fecha) {
      fecha = normalizarFecha(fila[mapeo.fecha]);
    }
    
    // Extraer descripción
    if (mapeo.descripcion) {
      descripcion = fila[mapeo.descripcion] || '';
    }
    
    // Extraer monto y tipo
    if (mapeo.cargo && mapeo.abono) {
      const cargo = normalizarMonto(fila[mapeo.cargo]);
      const abono = normalizarMonto(fila[mapeo.abono]);
      
      if (cargo > 0) {
        monto = cargo;
        tipo = 'cargo';
      } else if (abono > 0) {
        monto = abono;
        tipo = 'abono';
      }
    } else if (mapeo.monto) {
      monto = Math.abs(normalizarMonto(fila[mapeo.monto]));
      
      // Detectar si es cargo o abono por el signo o columnas adicionales
      if (fila[mapeo.monto] && fila[mapeo.monto].toString().includes('-')) {
        tipo = 'cargo';
      } else {
        tipo = 'abono';
      }
    }
    
    if (fecha && descripcion && monto > 0) {
      movimientos.push({
        fecha,
        descripcion: descripcion.trim(),
        monto,
        tipo
      });
    }
  }
  
  return movimientos;
}

// ---------------------------------------------------------------------------
// Análisis y registro
// ---------------------------------------------------------------------------

/** Hash sha256 de un buffer (igual al del archivo en disco) */
export function calcularHashBuffer(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

/**
 * Lee una cartola según su extensión. Devuelve { datos, esManual }; los PDF siempre requieren
 * revisión manual. Lanza si el archivo no se puede leer.
 */
export async function leerCartola(buffer, ext) {
  let datos = [];
  let esManual = false;

  if (ext === '.csv') {
    try {
      datos = parsearCSV(buffer);
    } catch (e) {
      // Intentar con otra codificación
      datos = parsearCSV(buffer, 'latin1');
    }
  } else if (['.xlsx', '.xls'].includes(ext)) {
    datos = parsearExcel(buffer);
  } else if (ext === '.pdf') {
    datos = await parsearPDF(buffer);
    esManual = true;
  }

  return { datos, esManual };
}

/** Lee la cartola y detecta formato y movimientos: { formato, movimientos, esManual, datos } */
export async function analizarCartola(buffer, ext) {
  const { datos, esManual } = await leerCartola(buffer, ext);
  const formato = datos.length > 0 ? detectarFormato(datos) : null;
  const movimientos = formato && !esManual ? procesarDatos(datos, formato) : [];
  // Solo los últimos 4 dígitos de tarjeta o cuenta que aparezcan (para reconocer la cuenta)
  const ultimos4 = buscarUltimos4(textoInicialArchivo(buffer, ext));
  return { formato, movimientos, esManual, datos, ultimos4 };
}

/** Fecha de importación de una cartola con ese hash, o null si no se ha importado */
export async function cartolaYaImportada(hash) {
  const { query } = await import('./db.js');
  const [existentes] = await query('SELECT * FROM archivos_importados WHERE hash_archivo = ?', [hash]);
  return existentes.length > 0 ? existentes[0] : null;
}

/** Clave con la que se reconoce el mismo movimiento en dos cartolas: fecha, tipo, monto y descripción normalizada */
export function claveMovimiento(m) {
  const descripcion = String(m.descripcion ?? '').toLowerCase().replace(/\s+/g, ' ').trim();
  return `${String(m.fecha).slice(0, 10)}|${m.tipo}|${Math.round(Number(m.monto))}|${descripcion}`;
}

/**
 * Separa los movimientos que ya existen. Cuenta repeticiones: si la cuenta tiene 1 compra igual y la cartola trae 2,
 * se importa 1 (la segunda es otra compra real); si no hay ninguna, se importan las 2.
 * Devuelve { nuevos, duplicados }.
 */
export function separarDuplicados(movimientos, existentes) {
  const disponibles = new Map();
  for (const e of existentes) {
    const k = claveMovimiento(e);
    disponibles.set(k, (disponibles.get(k) ?? 0) + 1);
  }
  const nuevos = [];
  let duplicados = 0;
  for (const m of movimientos) {
    const k = claveMovimiento(m);
    const n = disponibles.get(k) ?? 0;
    if (n > 0) {
      disponibles.set(k, n - 1);
      duplicados++;
    } else {
      nuevos.push(m);
    }
  }
  return { nuevos, duplicados };
}

/**
 * Registra los movimientos de una cartola (con la autocategorización por reglas) y el archivo
 * importado. `archivo` es la ruta relativa a la raíz del almacenamiento.
 * Devuelve { importados, registrados: [{ id, fecha, descripcion, monto, tipo }] }.
 */
export async function registrarImportacion({ archivo, hash, cuentaId, movimientos: todos }) {
  const { query } = await import('./db.js');
  const path = (await import('path')).default;

  // Dos cartolas que se traslapan (por ejemplo el mismo mes en dos envíos) no duplican cargos: los que ya están
  // en la cuenta (misma fecha, monto, tipo y descripción) se descartan
  let movimientos = todos;
  let duplicados = 0;
  if (todos.length > 0) {
    const fechas = todos.map(m => String(m.fecha).slice(0, 10)).sort();
    const [existentes] = await query(
      'SELECT fecha, descripcion, monto, tipo FROM movimientos WHERE cuenta_id = ? AND fecha >= ? AND fecha <= ?',
      [cuentaId, fechas[0], fechas[fechas.length - 1]]
    );
    ({ nuevos: movimientos, duplicados } = separarDuplicados(todos, existentes));
  }

  // Aplicar autocategorización a los movimientos
  const [reglas] = await query('SELECT * FROM reglas_categoria WHERE activa = true');

  const registrados = [];
  for (const mov of movimientos) {
    // Buscar categoría automática
    let categoria_id = null;
    const descripcionLower = mov.descripcion.toLowerCase();

    for (const regla of reglas) {
      if (descripcionLower.includes(regla.texto_buscar.toLowerCase())) {
        categoria_id = regla.categoria_id;
        break;
      }
    }

    const [insercion] = await query(
      `INSERT INTO movimientos (cuenta_id, fecha, descripcion, monto, tipo, tipo_movimiento, categoria_id, importado_de)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      // abono -> ingreso, cargo -> compra
      [cuentaId, mov.fecha, mov.descripcion, mov.monto, mov.tipo, resolverTipos({ tipo: mov.tipo }).tipo_movimiento, categoria_id, archivo]
    );
    registrados.push({ id: insercion.insertId, fecha: mov.fecha, descripcion: mov.descripcion, monto: mov.monto, tipo: mov.tipo });
  }

  // Registrar archivo importado
  const [registro] = await query(
    `INSERT INTO archivos_importados (nombre_archivo, hash_archivo, cuenta_id, cantidad_movimientos, ruta_archivo)
     VALUES (?, ?, ?, ?, ?)`,
    [path.basename(archivo), hash, cuentaId, registrados.length, archivo]
  );

  return { importados: registrados.length, registrados, archivoId: registro.insertId, duplicados };
}

// ---------------------------------------------------------------------------
// PDF: reglas sobre el texto y, si no alcanzan, interpretación con Gemini
// ---------------------------------------------------------------------------

/** Texto completo de un PDF (vacío si no tiene texto, por ejemplo un escaneo) */
export async function extraerTextoPDF(buffer) {
  const data = await pdfParse(buffer);
  return String(data.text ?? '');
}

const PALABRAS_ABONO = /\b(abono|dep[oó]sito|sueldo|remuneraci|devoluci|reembolso|transferencia\s+(?:de|desde|recibida)|pago\s+recibido)/i;
const PALABRAS_CARGO = /\b(cargo|compra|pago|giro|comisi[oó]n|retiro|impuesto|transferencia\s+(?:a|hacia|enviada)|avance)/i;

/**
 * Movimientos a partir del texto de un PDF con reglas. Solo se aceptan líneas con una fecha y
 * exactamente un monto (si hay dos, probablemente uno es el saldo y es ambiguo). El tipo sale
 * del signo del monto o de palabras como "abono" o "compra".
 * @returns {{ movimientos: Array, lineasCandidatas: number, sinTipo: number }}
 */
export function movimientosDesdeTextoPDF(texto) {
  const movimientos = [];
  let lineasCandidatas = 0;
  let sinTipo = 0;

  const patronFecha = /(\d{1,2}[-/]\d{1,2}[-/]\d{2,4})/;
  const patronMonto = /([-+(]?)\s*\$?\s*(\d{1,3}(?:\.\d{3})+(?:,\d{1,2})?|\d{4,})\)?(\s*-)?/g;

  for (const linea of String(texto).split('\n')) {
    const matchFecha = linea.match(patronFecha);
    if (!matchFecha) continue;

    const resto = linea.replace(matchFecha[0], ' ');
    const montos = [...resto.matchAll(patronMonto)];
    if (montos.length === 0) continue;
    lineasCandidatas++;
    if (montos.length !== 1) continue; // ambiguo (monto y saldo)

    const [textoMonto, signoPrevio, numero, signoFinal] = montos[0];
    const monto = Math.abs(normalizarMonto(numero));
    const fecha = normalizarFecha(matchFecha[1]);
    const descripcion = resto.replace(textoMonto, ' ').replace(/\s+/g, ' ').trim();
    if (!fecha || !(monto > 0) || !descripcion) continue;

    let tipo = null;
    if (signoPrevio === '-' || signoPrevio === '(' || signoFinal) tipo = 'cargo';
    else if (signoPrevio === '+') tipo = 'abono';
    else if (PALABRAS_ABONO.test(descripcion)) tipo = 'abono';
    else if (PALABRAS_CARGO.test(descripcion)) tipo = 'cargo';

    if (!tipo) {
      sinTipo++;
      continue;
    }
    movimientos.push({ fecha, descripcion, monto, tipo });
  }

  return { movimientos, lineasCandidatas, sinTipo };
}

/**
 * Enmascara números de cuenta y RUT antes de mandar texto a un servicio externo. Los montos
 * (con puntos de miles) y las fechas se conservan.
 */
export function enmascararTextoCartola(texto) {
  return String(texto)
    .replace(/\b\d{1,2}(?:\.\d{3}){2}-[\dkK]\b/g, '[rut]')
    .replace(/\b\d{7,8}-[\dkK]\b/g, '[rut]')
    .replace(/\b(rut|r\.u\.t\.?)\s*:?\s*[\d.\-kK]+/gi, '$1 [rut]')
    .replace(/\b(cuenta|cta\.?|n[°ºo]\.?|n[uú]mero)(\s+(?:corriente|vista|rut|ahorro|de))?\s*:?\s*\d[\d\- ]{5,}\d/gi, '$1$2 [cuenta]')
    .replace(/\d(?:[ -]?\d){12,18}/g, '[número]')
    .replace(/\d{9,}/g, '[cuenta]');
}

function fechaISOValida(texto) {
  if (typeof texto !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(texto)) return false;
  const [a, m, d] = texto.split('-').map(Number);
  const f = new Date(Date.UTC(a, m - 1, d));
  return f.getUTCFullYear() === a && f.getUTCMonth() === m - 1 && f.getUTCDate() === d;
}

/**
 * Valida movimientos devueltos por una IA contra el texto original: fecha real, monto entero
 * positivo, tipo cargo/abono y, para evitar datos inventados, el monto debe aparecer en el texto.
 * Descarta los que no cumplen; devuelve { movimientos, descartados }.
 */
export function validarMovimientosIA(lista, textoOriginal) {
  const digitos = String(textoOriginal).replace(/[^\d]/g, '');
  const movimientos = [];
  let descartados = 0;

  for (const m of Array.isArray(lista) ? lista : []) {
    const monto = typeof m?.monto === 'number' ? Math.round(m.monto) : NaN;
    const descripcion = typeof m?.descripcion === 'string' ? m.descripcion.replace(/\s+/g, ' ').trim().slice(0, 200) : '';
    const valido =
      fechaISOValida(m?.fecha) && Number.isFinite(monto) && monto > 0 && descripcion &&
      (m.tipo === 'cargo' || m.tipo === 'abono') && digitos.includes(String(monto));
    if (valido) movimientos.push({ fecha: m.fecha, descripcion, monto, tipo: m.tipo });
    else descartados++;
  }
  return { movimientos, descartados };
}

const MIN_MOVIMIENTOS_REGLAS = 3;
// Un PDF con menos de este largo de texto (sin contar espacios) se considera escaneado
const MIN_CARACTERES_TEXTO_PDF = 50;

/** ¿El texto extraído de un PDF es tan corto que probablemente es una imagen escaneada? */
export function pdfSinTexto(texto) {
  return String(texto ?? '').replace(/\s/g, '').length < MIN_CARACTERES_TEXTO_PDF;
}

/**
 * Analiza un PDF de cartola. Primero con reglas; si no alcanzan (menos de 3 movimientos o alguna
 * línea sin tipo claro) y se entrega `interpretarConIA`, manda a esa función SOLO el texto ya
 * enmascarado. Devuelve { movimientos, origen: 'reglas' | 'ia' | null, legible }.
 * `legible` es false si el PDF no tiene texto extraíble; en ese caso `escaneado` es true cuando
 * el PDF se leyó pero casi no trae texto (una imagen escaneada).
 */
export async function analizarPDF(buffer, { interpretarConIA = null } = {}) {
  let texto = '';
  try {
    texto = await extraerTextoPDF(buffer);
  } catch {
    return { movimientos: [], origen: null, legible: false, escaneado: false, banco: null, ultimos4: [] };
  }
  if (pdfSinTexto(texto)) return { movimientos: [], origen: null, legible: false, escaneado: true, banco: null, ultimos4: [] };

  // Banco o institución que aparece primero en el texto (sirve para sugerir la cuenta)
  const banco = buscarBanco(normalizar(texto))?.nombre ?? null;
  // Últimos 4 dígitos de tarjeta o cuenta del encabezado (nunca el número completo)
  const ultimos4 = buscarUltimos4(texto);

  const reglas = movimientosDesdeTextoPDF(texto);
  if (reglas.movimientos.length >= MIN_MOVIMIENTOS_REGLAS && reglas.sinTipo === 0) {
    return { movimientos: reglas.movimientos, origen: 'reglas', legible: true, banco, ultimos4 };
  }

  if (interpretarConIA) {
    const lista = await interpretarConIA(enmascararTextoCartola(texto));
    const { movimientos } = validarMovimientosIA(lista, texto);
    if (movimientos.length > 0) return { movimientos, origen: 'ia', legible: true, banco, ultimos4 };
  }

  return { movimientos: [], origen: null, legible: true, banco, ultimos4 };
}

/** Lee el texto de una cartola ya extraído (por ejemplo el OCR de una foto): solo reglas, sin IA. */
export function analizarTexto(texto) {
  const banco = buscarBanco(normalizar(texto))?.nombre ?? null;
  const reglas = movimientosDesdeTextoPDF(texto);
  return { movimientos: reglas.movimientos, banco, ultimos4: buscarUltimos4(texto), sinTipo: reglas.sinTipo };
}

// ---------------------------------------------------------------------------
// Últimos 4 dígitos de la tarjeta o de la cuenta que aparecen en la cartola
// ---------------------------------------------------------------------------

// Cuánto del comienzo del archivo se revisa (ahí están el encabezado y los datos de la cuenta)
const LARGO_ENCABEZADO = 6000;

// Línea que parece un movimiento: una fecha y un monto (con separador de miles o con $)
const FECHA_EN_LINEA = /\b\d{1,2}[/\-.]\d{1,2}(?:[/\-.]\d{2,4})?\b/;
const MONTO_EN_LINEA = /\$\s?\d|\b\d{1,3}(?:\.\d{3})+\b/;

/**
 * Parte de la cartola que va antes de la primera línea que parece un movimiento (fecha y monto):
 * el encabezado con los datos de la cuenta. Si no hay ninguna línea así, es todo el texto.
 * Sirve para no confundir una descripción de movimiento ("transferencia a cuenta 1234...") con
 * el número de cuenta de la cartola.
 */
export function encabezadoCartola(texto) {
  const original = String(texto ?? '');
  let posicion = 0;
  for (const linea of original.split('\n')) {
    if (FECHA_EN_LINEA.test(linea) && MONTO_EN_LINEA.test(linea)) return original.slice(0, posicion);
    posicion += linea.length + 1;
  }
  return original;
}

/**
 * Busca en un texto los últimos 4 dígitos de una tarjeta o de una cuenta: "**** 1234",
 * "XXXX-1234", "terminada en 1234", "N° cuenta 00-123-45678". Devuelve solo esos 4 dígitos,
 * con su tipo: [{ digitos, tipo: 'tarjeta' | 'cuenta' }], sin repetidos y en orden de aparición.
 * Nunca devuelve ni conserva el número completo, y no registra nada en consola.
 */
export function buscarUltimos4(texto) {
  const original = String(texto ?? '').slice(0, LARGO_ENCABEZADO);
  const hallazgos = [];
  const ocupados = [];
  const libre = (ini, fin) => !ocupados.some(([a, b]) => ini < b && fin > a);

  const agregar = (indice, fin, digitos, tipo) => {
    if (!/^\d{4}$/.test(digitos) || !libre(indice, fin)) return;
    ocupados.push([indice, fin]);
    hallazgos.push({ indice, digitos, tipo });
  };

  // Los números de cuenta solo se buscan en el encabezado (antes del primer movimiento); las
  // máscaras de tarjeta pueden estar en cualquier parte de los primeros LARGO_ENCABEZADO caracteres
  const cabecera = encabezadoCartola(original);

  // 1. Número de cuenta: se toman solo los 4 últimos dígitos del número que sigue a "cuenta"
  const cuenta = /\b(?:n[°ºo]\.?\s*(?:de\s+)?(?:cuenta|cta\.?)|(?:cuenta|cta\.?)(?:\s+(?:corriente|vista|rut|de\s+ahorro|cte\.?))?(?:\s*(?:n[°ºo]\.?|nro\.?|n[uú]mero))?)\s*:?\s*([\dxX*•][\dxX*•\-. ]{3,28}\d)/gi;
  for (const m of cabecera.matchAll(cuenta)) {
    // Una fecha después de "cuenta" no es un número de cuenta
    if (/^\d{1,2}[-. ]\d{1,2}[-. ]\d{2,4}$/.test(m[1].trim())) continue;
    const digitos = m[1].replace(/\D/g, '');
    if (digitos.length >= 4) agregar(m.index, m.index + m[0].length, digitos.slice(-4), 'cuenta');
  }

  // 2. "cuenta terminada en 1234" y "terminada en 1234" (tarjeta)
  const terminada = /\b(?:(cuenta)\s+)?(?:terminad[ao]s?|termina|final(?:iza)?)\s+en\s+(\d{4})(?!\d)/gi;
  for (const m of original.matchAll(terminada)) {
    if (m[1] && m.index >= cabecera.length) continue; // "cuenta terminada en" dentro de un movimiento
    agregar(m.index, m.index + m[0].length, m[2], m[1] ? 'cuenta' : 'tarjeta');
  }
  for (const m of original.matchAll(/\bfinal\s+(\d{4})(?!\d)/gi)) {
    agregar(m.index, m.index + m[0].length, m[1], 'tarjeta');
  }

  // 3. Máscaras de tarjeta: "**** 1234", "XXXX-1234", "XXXX XXXX XXXX 1234", "•••• 1234"
  const mascara = /(?:(?:\*{2,}|[xX]{3,}|•{2,})[\s\-.]*)+(\d{4})(?!\d)/g;
  for (const m of original.matchAll(mascara)) {
    agregar(m.index, m.index + m[0].length, m[1], 'tarjeta');
  }

  const vistos = new Set();
  return hallazgos
    .sort((a, b) => a.indice - b.indice)
    .map(({ digitos, tipo }) => ({ digitos, tipo }))
    .filter(h => {
      const clave = `${h.tipo}:${h.digitos}`;
      if (vistos.has(clave)) return false;
      vistos.add(clave);
      return true;
    })
    .slice(0, 4);
}

/** Texto del comienzo de un CSV o Excel (donde suele estar el encabezado de la cartola) */
function textoInicialArchivo(buffer, ext) {
  try {
    if (ext === '.csv') return buffer.toString('utf8').slice(0, LARGO_ENCABEZADO);
    if (['.xlsx', '.xls'].includes(ext)) {
      const libro = xlsx.read(buffer, { type: 'buffer' });
      return xlsx.utils.sheet_to_csv(libro.Sheets[libro.SheetNames[0]]).slice(0, LARGO_ENCABEZADO);
    }
  } catch {
    // si no se puede leer, simplemente no hay dígitos que detectar
  }
  return '';
}
