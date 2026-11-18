/**
 * Parser de mensajes en lenguaje natural para registrar gastos/ingresos
 * Soporta formato chileno: montos, fechas relativas, medios de pago
 */

import { fechaHoySantiago, sumarDias, diaSemana, construirFecha } from './fechas.js';

// Palabras clave para montos en "lucas" o "k"
const LUCAS_REGEX = /(\d+(?:[.,]\d+)?)\s*(?:lucas?|lks?|k)\b/i;
const MONTO_REGEX = /\$?\s*(\d{1,3}(?:\.\d{3})+|\d{4,})/g;

// Verbos de gasto/ingreso al inicio de la descripción (el "el" suelto viene de "el viernes", "el 15/11")
const VERBO_INICIAL_REGEX = /^(?:(?:el|la)\s+)?(?:pagu[eé]|gast[eé]|compr[eé]|recib[ií]|me\s+pagaron|me\s+cobraron)(?=\s|$)\s*/i;

// Fechas relativas
const DIAS_SEMANA = {
  'lunes': 1, 'martes': 2, 'miércoles': 3, 'miercoles': 3,
  'jueves': 4, 'viernes': 5, 'sábado': 6, 'sabado': 6, 'domingo': 0
};

// Medios de pago comunes
const MEDIOS_PAGO = {
  'débito': ['debito', 'débito', 'tarjeta de debito', 'con debito'],
  'crédito': ['credito', 'crédito', 'tarjeta de credito', 'con credito'],
  'CMR': ['cmr', 'falabella'],
  'efectivo': ['efectivo', 'cash', 'plata'],
  'transferencia': ['transferencia', 'transf', 'transfer']
};

// Nombres de medios de pago que el bot reconoce (también se los pasamos a Gemini)
export const MEDIOS_PAGO_NOMBRES = Object.keys(MEDIOS_PAGO);

// Categorías por palabras clave (estas se pueden ampliar según las categorías reales)
const CATEGORIAS_KEYWORDS = {
  'Supermercado': ['super', 'supermercado', 'jumbo', 'lider', 'tottus', 'unimarc', 'santa isabel'],
  'Transporte': ['uber', 'cabify', 'didi', 'metro', 'bus', 'micro', 'colectivo', 'bencina', 'peaje'],
  'Comida': ['restaurant', 'restorán', 'comida', 'almuerzo', 'cena', 'desayuno', 'pedidos ya', 'rappi', 'uber eats'],
  'Servicios': ['luz', 'agua', 'gas', 'internet', 'telefono', 'teléfono', 'celular'],
  'Salud': ['farmacia', 'doctor', 'medico', 'médico', 'hospital', 'consulta'],
  'Entretenimiento': ['cine', 'teatro', 'concierto', 'streaming', 'netflix', 'spotify'],
  'Sueldo': ['sueldo', 'salario', 'pago', 'liquidacion', 'liquidación']
};

// Montos escritos con palabras: "57 mil", "57 mil 500", "57 mil quinientos", "1,5 millones", "2 palos"
const NUMERO = '\\d+(?:[.,]\\d+)?';
const CENTENAS = {
  ciento: 100, cien: 100, doscientos: 200, trescientos: 300, cuatrocientos: 400,
  quinientos: 500, seiscientos: 600, setecientos: 700, ochocientos: 800, novecientos: 900
};
const CENTENAS_ALT = Object.keys(CENTENAS).join('|');
const MILLONES_REGEX = new RegExp(`(${NUMERO})\\s*(?:millones|mill[oó]n|palos?)\\b`, 'i');
// Tras "mil" acepta exactamente 3 dígitos (no seguidos de otro número/fecha) o una centena en palabras
const MIL_REGEX = new RegExp(
  `(${NUMERO})\\s*mil\\b(?:\\s+(?:(\\d{3})(?![./,-]?\\d)|(${CENTENAS_ALT})\\b))?`,
  'i'
);

// Palabras que marcan un monto aproximado (antes o después del monto)
const APROX_FRASES = 'y algo|y tanto|y pico|m[aá]s o menos|aprox(?:imadamente)?\\.?|cerca de|como';
const APROX_ANTES_REGEX = new RegExp(`(?:^|[\\s,(])(${APROX_FRASES})\\s*\\$?\\s*$`, 'i');
// "como" después del monto solo cuenta si cierra la frase (evita "5 lucas como regalo")
const APROX_DESPUES_REGEX = new RegExp(
  `^\\s*(?:(?:y algo|y tanto|y pico|m[aá]s o menos|aprox(?:imadamente)?\\.?|cerca de)(?![\\wáéíóúñ])|como(?=\\s*(?:[,.;!?]|$)))`,
  'i'
);

function aNumero(texto) {
  return parseFloat(texto.replace(',', '.'));
}

/**
 * Busca el monto y devuelve su posición en el texto, sin considerar palabras de aproximación
 */
function buscarMonto(mensaje) {
  let m = mensaje.match(MILLONES_REGEX);
  if (m) {
    return { monto: Math.round(aNumero(m[1]) * 1000000), inicio: m.index, fin: m.index + m[0].length };
  }

  m = mensaje.match(MIL_REGEX);
  if (m) {
    let monto = Math.round(aNumero(m[1]) * 1000);
    if (m[2]) monto += parseInt(m[2], 10);
    else if (m[3]) monto += CENTENAS[m[3].toLowerCase()];
    return { monto, inicio: m.index, fin: m.index + m[0].length };
  }

  // "lucas" o "k" (admite decimales: 57,5 lucas, 1.5k)
  m = mensaje.match(LUCAS_REGEX);
  if (m) {
    return { monto: Math.round(aNumero(m[1]) * 1000), inicio: m.index, fin: m.index + m[0].length };
  }

  // Formato de pesos chilenos: tomar el primer monto encontrado
  const matches = [...mensaje.matchAll(MONTO_REGEX)];
  if (matches.length > 0) {
    const match = matches[0];
    if (!match[1]) return null;

    // Quitar separadores de miles (punto en Chile)
    const monto = parseFloat(match[1].replace(/\s/g, '').replace(/\./g, ''));
    if (!isNaN(monto) && monto > 0) {
      return { monto: Math.round(monto), inicio: match.index, fin: match.index + match[0].length };
    }
  }

  return null;
}

/**
 * Analiza el monto de un mensaje.
 * Devuelve { monto, aproximado, inicio, fin } o null. inicio/fin delimitan el monto
 * junto con las palabras de aproximación adyacentes ("y algo", "como", "aprox"...).
 */
export function analizarMonto(mensaje) {
  const encontrado = buscarMonto(mensaje);
  if (!encontrado) return null;

  let { inicio, fin } = encontrado;
  let aproximado = false;

  const antes = mensaje.slice(0, inicio).match(APROX_ANTES_REGEX);
  if (antes) {
    aproximado = true;
    inicio = antes.index + antes[0].length - antes[0].trimStart().length;
  }

  const despues = mensaje.slice(fin).match(APROX_DESPUES_REGEX);
  if (despues) {
    aproximado = true;
    fin += despues[0].length;
  }

  return { monto: encontrado.monto, aproximado, inicio, fin };
}

/**
 * Extrae el monto de un mensaje
 * Soporta: 12500, 12.500, $12.500, 5 lucas, 5k, 1.5k, 57,5 lucas,
 * 57 mil, 57mil, 57 mil 500, 57 mil quinientos, 1 millón, 1,5 millones, 2 palos
 */
export function extraerMonto(mensaje) {
  const analisis = analizarMonto(mensaje);
  return analisis ? analisis.monto : null;
}

/**
 * Si el mensaje es únicamente un monto (por ejemplo "57500", "$57.500", "57 mil 500"),
 * devuelve ese monto; en otro caso null. Sirve para corregir un monto aproximado.
 */
export function parsearMontoExacto(mensaje) {
  const texto = mensaje.trim();
  const plano = texto.match(/^\$?\s*(\d{1,3}(?:\.\d{3})+|\d+)$/);
  if (plano) {
    const monto = parseInt(plano[1].replace(/\./g, ''), 10);
    return monto > 0 ? monto : null;
  }

  const analisis = analizarMonto(texto);
  if (!analisis || analisis.aproximado) return null;
  const resto = (texto.slice(0, analisis.inicio) + texto.slice(analisis.fin)).replace(/[$\s]/g, '');
  return resto === '' ? analisis.monto : null;
}

/**
 * Extrae la fecha del mensaje
 * Soporta: hoy, ayer, anteayer, días de la semana, dd/mm, dd-mm
 */
export function extraerFecha(mensaje) {
  const textoLower = mensaje.toLowerCase();
  // Todo se calcula sobre fechas YYYY-MM-DD en hora de Chile (America/Santiago)
  const hoy = fechaHoySantiago();

  // Hoy
  if (textoLower.includes('hoy')) {
    return hoy;
  }

  // Anteayer (debe ir antes de "ayer" porque contiene "ayer")
  if (textoLower.match(/\b(anteayer|antier)\b/)) {
    return sumarDias(hoy, -2);
  }

  // Ayer
  if (textoLower.includes('ayer')) {
    return sumarDias(hoy, -1);
  }

  // Días de la semana
  for (const [dia, numero] of Object.entries(DIAS_SEMANA)) {
    if (textoLower.includes(dia)) {
      let diferencia = numero - diaSemana(hoy);

      // Si el día ya pasó esta semana, ir a la semana pasada
      if (diferencia > 0) {
        diferencia -= 7;
      }

      return sumarDias(hoy, diferencia);
    }
  }

  // Formato dd/mm o dd-mm (asume año actual)
  const matchFecha = mensaje.match(/(\d{1,2})[/-](\d{1,2})/);
  if (matchFecha) {
    const dia = parseInt(matchFecha[1]);
    const mes = parseInt(matchFecha[2]);
    const anioActual = parseInt(hoy.slice(0, 4));

    let fecha = construirFecha(anioActual, mes, dia);
    // Si la fecha está en el futuro, asumir que es del año pasado
    if (fecha && fecha > hoy) {
      fecha = construirFecha(anioActual - 1, mes, dia);
    }
    if (fecha) {
      return fecha;
    }
  }

  // Por defecto, hoy
  return hoy;
}

/**
 * Extrae el medio de pago del mensaje
 */
export function extraerMedioPago(mensaje) {
  const textoLower = mensaje.toLowerCase();
  
  for (const [medio, palabras] of Object.entries(MEDIOS_PAGO)) {
    for (const palabra of palabras) {
      if (textoLower.includes(palabra)) {
        return medio;
      }
    }
  }
  
  return null;
}

/**
 * Detecta si es un gasto o ingreso
 */
export function detectarTipo(mensaje) {
  const textoLower = mensaje.toLowerCase();
  
  // Palabras clave de ingresos
  const palabrasIngreso = ['me pagaron', 'cobré', 'cobre', 'ingreso', 'sueldo', 'salario', 'recibí', 'recibi', 'depósito', 'deposito'];
  
  for (const palabra of palabrasIngreso) {
    if (textoLower.includes(palabra)) {
      return 'abono';
    }
  }
  
  // Por defecto, es un gasto
  return 'cargo';
}

/**
 * Detecta la categoría basándose en palabras clave
 */
export function detectarCategoria(mensaje) {
  const textoLower = mensaje.toLowerCase();
  
  for (const [categoria, palabras] of Object.entries(CATEGORIAS_KEYWORDS)) {
    for (const palabra of palabras) {
      if (textoLower.includes(palabra)) {
        return categoria;
      }
    }
  }
  
  return null;
}

/**
 * Extrae la descripción del mensaje (sin el monto)
 */
export function extraerDescripcion(mensaje) {
  // Eliminar el monto del mensaje para obtener una descripción más limpia
  const analisis = analizarMonto(mensaje);
  const sinMonto = analisis
    ? mensaje.slice(0, analisis.inicio) + ' ' + mensaje.slice(analisis.fin)
    : mensaje;
  let descripcion = sinMonto
    .replace(MONTO_REGEX, '')
    .replace(/\$+/g, '')
    .trim();
  
  // Eliminar palabras de fecha comunes
  descripcion = descripcion
    .replace(/\b(hoy|ayer|anteayer|antier)\b/gi, '')
    .replace(/\b(lunes|martes|mi[eé]rcoles|jueves|viernes|s[aá]bado|domingo)\b/gi, '')
    .replace(/\d{1,2}[/-]\d{1,2}/g, '')
    .trim();
  
  // Limpiar espacios múltiples
  descripcion = descripcion.replace(/\s+/g, ' ').trim();

  // Quitar el verbo inicial de gasto/ingreso y las preposiciones sueltas que queden al inicio.
  // Se usa (?=\s|$) y no \b porque \b no reconoce letras con tilde (pagué, gasté).
  descripcion = descripcion
    .replace(VERBO_INICIAL_REGEX, '')
    .replace(/^(?:(?:en|de)(?=\s|$)\s*)+/i, '')
    .trim();

  return descripcion || 'Gasto sin descripción';
}

/**
 * Parsea un mensaje completo y extrae toda la información
 */
export function parsearMensaje(mensaje) {
  const analisis = analizarMonto(mensaje);
  return {
    monto: analisis ? analisis.monto : null,
    aproximado: analisis ? analisis.aproximado : false,
    fecha: extraerFecha(mensaje),
    medioPago: extraerMedioPago(mensaje),
    tipo: detectarTipo(mensaje),
    categoriaDetectada: detectarCategoria(mensaje),
    descripcion: extraerDescripcion(mensaje)
  };
}
