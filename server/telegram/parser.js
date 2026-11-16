/**
 * Parser de mensajes en lenguaje natural para registrar gastos/ingresos
 * Soporta formato chileno: montos, fechas relativas, medios de pago
 */

// Palabras clave para montos en "lucas" o "k"
const LUCAS_REGEX = /(\d+(?:[.,]\d+)?)\s*(?:lucas?|lks?|k)\b/i;
const MONTO_REGEX = /\$?\s*(\d{1,3}(?:\.\d{3})+|\d{4,})/g;

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

/**
 * Extrae el monto de un mensaje
 * Soporta: 12500, 12.500, $12.500, 5 lucas, 5k
 */
export function extraerMonto(mensaje) {
  const textoLower = mensaje.toLowerCase();
  
  // Buscar primero "lucas" o "k"
  const matchLucas = mensaje.match(LUCAS_REGEX);
  if (matchLucas) {
    const valor = parseFloat(matchLucas[1].replace(',', '.'));
    return Math.round(valor * 1000);
  }
  
  // Buscar formato de pesos chilenos
  const matches = [...mensaje.matchAll(MONTO_REGEX)];
  if (matches && matches.length > 0) {
    // Tomar el primer monto encontrado
    const match = matches[0];
    const montoCapturado = match[1];
    
    if (!montoCapturado) return null;
    
    const montoStr = montoCapturado
      .replace('$', '')
      .replace(/\s/g, '')
      .replace(/\./g, ''); // Quitar separadores de miles (punto en Chile)
    
    const monto = parseFloat(montoStr);
    if (!isNaN(monto) && monto > 0) {
      return Math.round(monto);
    }
  }
  
  return null;
}

/**
 * Extrae la fecha del mensaje
 * Soporta: hoy, ayer, anteayer, días de la semana, dd/mm, dd-mm
 */
export function extraerFecha(mensaje) {
  const textoLower = mensaje.toLowerCase();
  const hoy = new Date();
  
  // Hoy
  if (textoLower.includes('hoy')) {
    return formatearFecha(hoy);
  }
  
  // Anteayer (debe ir antes de "ayer" porque contiene "ayer")
  if (textoLower.match(/\b(anteayer|antier)\b/)) {
    const anteayer = new Date(hoy);
    anteayer.setDate(anteayer.getDate() - 2);
    return formatearFecha(anteayer);
  }
  
  // Ayer
  if (textoLower.includes('ayer')) {
    const ayer = new Date(hoy);
    ayer.setDate(ayer.getDate() - 1);
    return formatearFecha(ayer);
  }
  
  // Días de la semana
  for (const [dia, numero] of Object.entries(DIAS_SEMANA)) {
    if (textoLower.includes(dia)) {
      const diaActual = hoy.getDay();
      let diferencia = numero - diaActual;
      
      // Si el día ya pasó esta semana, ir a la semana pasada
      if (diferencia > 0) {
        diferencia -= 7;
      }
      
      const fecha = new Date(hoy);
      fecha.setDate(fecha.getDate() + diferencia);
      return formatearFecha(fecha);
    }
  }
  
  // Formato dd/mm o dd-mm (asume año actual)
  const matchFecha = mensaje.match(/(\d{1,2})[/-](\d{1,2})/);
  if (matchFecha) {
    const dia = parseInt(matchFecha[1]);
    const mes = parseInt(matchFecha[2]) - 1; // JavaScript months are 0-indexed
    
    if (dia >= 1 && dia <= 31 && mes >= 0 && mes <= 11) {
      const fecha = new Date(hoy.getFullYear(), mes, dia);
      // Si la fecha está en el futuro, asumir que es del año pasado
      if (fecha > hoy) {
        fecha.setFullYear(fecha.getFullYear() - 1);
      }
      return formatearFecha(fecha);
    }
  }
  
  // Por defecto, hoy
  return formatearFecha(hoy);
}

/**
 * Formatea fecha a YYYY-MM-DD
 */
function formatearFecha(fecha) {
  const anio = fecha.getFullYear();
  const mes = String(fecha.getMonth() + 1).padStart(2, '0');
  const dia = String(fecha.getDate()).padStart(2, '0');
  return `${anio}-${mes}-${dia}`;
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
  let descripcion = mensaje
    .replace(LUCAS_REGEX, '')
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
  
  return descripcion || 'Gasto sin descripción';
}

/**
 * Parsea un mensaje completo y extrae toda la información
 */
export function parsearMensaje(mensaje) {
  return {
    monto: extraerMonto(mensaje),
    fecha: extraerFecha(mensaje),
    medioPago: extraerMedioPago(mensaje),
    tipo: detectarTipo(mensaje),
    categoriaDetectada: detectarCategoria(mensaje),
    descripcion: extraerDescripcion(mensaje)
  };
}
