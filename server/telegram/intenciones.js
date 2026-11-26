/**
 * Enrutador de intenciones: entiende un mensaje libre (sin /comando) y lo manda a la función que
 * ya existe. Primero reglas rápidas (sin tildes ni mayúsculas) y, si no alcanzan, Gemini con un
 * prompt corto. Los comandos siguen funcionando como respaldo.
 *
 * Intenciones: registrar, pagar_cuota, nueva_compra_cuotas, consultar_gastos, plan,
 * datos_transferencia, cuentas, cuotas_pendientes, buscar, ayuda, eliminar_ultimo, asignar_digitos, guardar_cuenta, estado, reset y
 * restaurar_respaldo.
 *
 * También entiende las respuestas (reply de Telegram) a un mensaje que creó un registro: eliminar,
 * corregir o deshacer (clasificarReply; la ejecución está en registrosBot.js).
 *
 * Privacidad: a Gemini nunca viaja nada de datos de transferencia, RUT, correos ni números de
 * cuenta. Si el mensaje parece contener algo así, ni siquiera se consulta (puedeEnviarseAGemini).
 * Guardar cuentas y datos de transferencia sigue siendo solo por comando (/savecard, /savetrans).
 *
 * Si la intención es ambigua o falta un dato, el bot pregunta con botones en vez de adivinar. Lo que
 * escribe en la BD siempre pasa por una confirmación; cuando la confianza es baja (la intención la
 * dedujo Gemini) esa confirmación agrega el botón "Corregir".
 */

import { analizarMonto, parsearMontoExacto } from './parser.js';
import { fechaHoySantiago, sumarDias, diaSemana, construirFecha } from './fechas.js';
import { detectarConsultaDatos, terminoDesdeTexto } from './datosTransferencia.js';
import { detectarConsultaPlan } from '../planAhorro.js';
import { parsearPagoCuota, detectarAltaCuotas, detectarConsultaCuotas } from './cuotas.js';
import { normalizar, capitalizarNombre } from './cuentas.js';
import { interpretarIntencion, geminiDisponible } from './gemini.js';
import { limitadorGemini } from './limiteGemini.js';

const ESPERA_MS = 10 * 60 * 1000;

// Códigos cortos para callback_data
const CODIGOS = {
  registrar: 're',
  pagar_cuota: 'pc',
  nueva_compra_cuotas: 'nc',
  consultar_gastos: 'cg',
  plan: 'pl',
  datos_transferencia: 'dt',
  cuentas: 'ct',
  cuotas_pendientes: 'cp',
  buscar: 'bs',
  ayuda: 'ay',
  guardar_cuenta: 'gc'
};
const INTENCION_POR_CODIGO = Object.fromEntries(Object.entries(CODIGOS).map(([i, c]) => [c, i]));

const ETIQUETAS = {
  registrar: 'Registrar un gasto o ingreso',
  consultar_gastos: 'Ver mis gastos del mes',
  plan: 'Ver cuánto puedo gastar',
  cuotas_pendientes: 'Ver mis cuotas',
  cuentas: 'Ver mis cuentas',
  guardar_cuenta: 'Guardar una cuenta o tarjeta',
  ayuda: 'Qué puedes hacer'
};

// ---------------------------------------------------------------------------
// Reglas rápidas (funciones puras)
// ---------------------------------------------------------------------------

// Palabras de relleno al buscar movimientos ("busca uber de octubre" -> "uber octubre")
const RELLENO_BUSQUEDA = new Set([
  'de', 'del', 'en', 'el', 'la', 'los', 'las', 'mis', 'mi', 'movimientos', 'movimiento', 'gastos', 'gasto',
  'compras', 'pagos', 'que', 'dicen', 'digan', 'con', 'por', 'favor'
]);

/** Quita palabras de relleno de una búsqueda libre y deja el texto y el mes */
export function limpiarBusqueda(texto) {
  return String(texto ?? '')
    .split(/\s+/)
    .filter(p => p && !RELLENO_BUSQUEDA.has(normalizar(p)))
    .join(' ')
    .trim();
}

// ---------------------------------------------------------------------------
// Respuestas a un registro: eliminar, corregir, deshacer
// ---------------------------------------------------------------------------

const VERBO_ELIMINAR = /\b(?:elimin\w*|borr\w*|sac(?:a|alo|ala|ar)|quit(?:a|alo|ala|ar)|anul\w*)\b/;
const VERBO_DESHACER = /\b(?:deshac\w*|deshaz\w*|revert\w*|restaur\w*|recuper\w*|vuelve atras|volver atras)\b/;

/**
 * "qué datos tienes guardados", "datos guardados", "qué tienes registrado": pide la vista de
 * /cuentas (cuentas, vínculos, cuotas y totales). No confundir con los datos de transferencia
 * ("pásame los datos de la mercado pago"), que llevan un nombre de cuenta.
 */
export function detectarDatosGuardados(texto) {
  const norm = normalizar(texto).replace(/[¿?¡!.,;:]/g, ' ').replace(/\s+/g, ' ').trim();
  return /^(?:(?:que|cuales)\s+(?:datos|cosas)\s+(?:tienes|tengo|hay)\s+(?:guardad[oa]s?|registrad[oa]s?)|(?:mis\s+)?datos\s+(?:guardad[oa]s?|registrad[oa]s?)|que\s+tienes\s+(?:guardad[oa]|registrad[oa])|que\s+(?:cuentas\s+y\s+tarjetas|tarjetas\s+y\s+cuentas)\s+tengo)$/.test(norm);
}

/** "estado", "status", "todo bien?": pide el chequeo de /status. Solo calza el mensaje completo. */
export function detectarEstado(texto) {
  const norm = normalizar(texto).replace(/[¿?¡!.,;:]/g, ' ').replace(/\s+/g, ' ').trim();
  return /^(?:estado|status|todo bien|todo ok|esta todo bien|como esta todo|como va todo|estado de la app)$/.test(norm);
}

/**
 * "empezar de cero", "borrar todo", "resetear" -> 'reset'; "restaurar último respaldo" ->
 * 'restaurar_respaldo'; otra cosa -> null. Solo calzan mensajes que son exactamente eso, y el bot
 * igual pide botones y una frase escrita antes de tocar nada.
 */
export function detectarReset(texto) {
  const norm = normalizar(texto).replace(/[¿?¡!.,;:]/g, ' ').replace(/\s+/g, ' ').trim();
  if (/^(?:quiero\s+)?(?:empezar|comenzar|partir)\s+de\s+cero$/.test(norm)) return 'reset';
  if (/^(?:borra(?:r)?|elimina(?:r)?)\s+todo(?:\s+(?:los\s+|mis\s+)?(?:datos|movimientos))?$/.test(norm)) return 'reset';
  if (/^reset(?:ea(?:r)?)?(?:\s+(?:todo|(?:los\s+|mis\s+)?datos))?$/.test(norm)) return 'reset';
  if (/^restaura(?:r)?\s+(?:el\s+)?(?:ultimo\s+)?respaldo$/.test(norm)) return 'restaurar_respaldo';
  return null;
}

const VERBO_GUARDAR_CUENTA = /^(?:por favor\s+)?(?:(?:quiero|necesito|puedes|podrias|podr[ií]as)\s+)?(?:guarda(?:r|me)?|agrega(?:r|me)?|a[ñn]ade|a[ñn]adir|crea(?:r|me)?|registra(?:r|me)?|anota(?:r|me)?|nueva|nuevo)\b/;

/**
 * Frases naturales para guardar una cuenta o tarjeta: "guarda la tarjeta crédito 8263 es de Valeska Sanhueza",
 * "agrega mi cuenta rut 1234 del banco estado", "nueva tarjeta débito 5555 de Juan", "la tarjeta 8263 es de Valeska".
 * Devuelve { textoCuenta, ultimos4, titular, numeroLargo } o null. `textoCuenta` es el texto reescrito en el formato de
 * /savecard ("tarjeta crédito terminada en 8263 a nombre de Valeska Sanhueza") para pasarlo a parsearCuenta; de un
 * número largo solo se toman los últimos 4 dígitos. Reglas locales: nada de esto va a Gemini.
 */
export function detectarGuardarCuenta(texto) {
  const original = String(texto ?? '').trim();
  if (!original || original.startsWith('/')) return null;
  const norm = normalizar(original).replace(/[¿?¡!,;:]/g, ' ').replace(/\s+/g, ' ').trim();
  if (!/\b(?:tarjeta|cuenta)\b/.test(norm)) return null;

  // El número de la tarjeta o cuenta: un grupo de 4 a 19 dígitos (con espacios o guiones); nunca un monto con $ o "mil"
  const numero = /(?<![\d$])(\d(?:[\s.-]?\d){3,18})(?![\d])(?!\s*(?:pesos|mil|lucas|luca|palos|k)\b)/.exec(original);
  if (!numero || /\$\s*$/.test(original.slice(0, numero.index))) return null;
  const digitos = numero[1].replace(/\D/g, '');
  if (digitos.length < 4) return null;
  const ultimos4 = digitos.slice(-4);

  const conVerbo = VERBO_GUARDAR_CUENTA.test(norm);
  const esDe = /\b(?:es|pertenece|va|son)\s+(?:de|a)\s+(\S.*)$/i.exec(original);
  const estructura = new RegExp('^(?:la|mi|el)?\\s*(?:tarjeta|cuenta)\\b').test(norm) && Boolean(esDe);
  if (!conVerbo && !estructura) return null;

  // Titular: "es de X", "a nombre de X", "titular X" o un "de X" al final que no sea el banco
  let titular = null;
  const nombre = (t) => t.replace(/[¿?¡!.,;:]+$/g, '').replace(/\s+/g, ' ').trim();
  const esNombre = (t) => t && !/\d/.test(t) && !/^(?:banco|la|el|los|las|mi|mis|ahorro|cuenta|tarjeta)\b/i.test(t) && t.split(' ').length <= 5;
  let m;
  if (esDe && esNombre(nombre(esDe[1]))) titular = nombre(esDe[1]);
  else if ((m = /\b(?:a nombre de|titular(?: es)?)\s+(\S.*)$/i.exec(original)) && esNombre(nombre(m[1]))) titular = nombre(m[1]);
  else if ((m = /\bde\s+([A-Za-zÁÉÍÓÚÜÑáéíóúüñ]+(?:\s+[A-Za-zÁÉÍÓÚÜÑáéíóúüñ]+){0,3})\s*$/.exec(original)) && esNombre(nombre(m[1]))) titular = nombre(m[1]);

  // Texto en el formato de /savecard: sin el verbo ni el "es de X", con "terminada en NNNN" y el titular como "a nombre de"
  let cuerpo = original
    .replace(/^\s*(?:por favor\s+)?(?:(?:quiero|necesito|puedes|podr[ií]as)\s+)?(?:guarda(?:r|me)?|agrega(?:r|me)?|a[ñn]ade|a[ñn]adir|crea(?:r|me)?|registra(?:r|me)?|anota(?:r|me)?)\s+/i, '')
    .replace(/^\s*(?:nueva|nuevo)\s+/i, '')
    .replace(numero[1], ` terminada en ${ultimos4} `);
  if (titular) {
    cuerpo = cuerpo.replace(/\b(?:es|pertenece|va|son)\s+(?:de|a)\s+\S.*$/i, ' ')
      .replace(/\b(?:a nombre de|titular(?: es)?)\s+\S.*$/i, ' ')
      .replace(new RegExp(`\\bde\\s+${titular.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*$`, 'i'), ' ');
  }
  cuerpo = cuerpo.replace(/\s+/g, ' ').trim();
  const textoCuenta = `${cuerpo}${titular ? ` a nombre de ${titular}` : ''}`.replace(/\s+/g, ' ').trim();

  return { textoCuenta, ultimos4, titular, numeroLargo: digitos.length > 4 };
}

/**
 * "la FAN termina en 6958", "la cuenta de la falabella termina en 1234": asigna los últimos 4 dígitos
 * a una cuenta. Devuelve { termino, digitos, tipo } (tipo 'tarjeta' | 'cuenta' | null si el texto
 * no lo dice) o null. Solo 4 dígitos: un número más largo no calza.
 */
export function detectarAsignarDigitos(texto) {
  const norm = normalizar(texto).replace(/[¿?¡!.,;:]/g, ' ').replace(/\s+/g, ' ').trim();
  const m = /^(?:(?:la|el|mi)\s+)?(?:(cuenta|tarjeta)\s+(?:del?\s+)?(?:(?:la|el|mi)\s+)?)?(.+?)\s+(?:termina|terminada|terminado|finaliza|acaba)\s+en\s+(\d{4})$/.exec(norm);
  if (!m) return null;
  const termino = m[2].trim();
  if (!termino || termino.length > 40 || /\d/.test(termino) || ['cuenta', 'tarjeta'].includes(termino)) return null;
  return { termino, digitos: m[3], tipo: m[1] ?? null };
}

/** "elimina el último gasto", "borra el último" (sin responder a ningún mensaje) */
export function detectarEliminarUltimo(texto) {
  const norm = normalizar(texto).replace(/[¿?¡!.,;:]/g, ' ').replace(/\s+/g, ' ').trim();
  if (!VERBO_ELIMINAR.test(norm) || /\d/.test(norm)) return false;
  return /\bultim[oa]\b/.test(norm) && norm.split(' ').length <= 8;
}

const MESES_NOMBRE = {
  enero: 1, febrero: 2, marzo: 3, abril: 4, mayo: 5, junio: 6, julio: 7,
  agosto: 8, septiembre: 9, setiembre: 9, octubre: 10, noviembre: 11, diciembre: 12
};
const DIAS_NOMBRE = { domingo: 0, lunes: 1, martes: 2, miercoles: 3, jueves: 4, viernes: 5, sabado: 6 };

const RELLENO_FECHA = new Set([
  'no', 'fue', 'era', 'es', 'fueron', 'eran', 'del', 'de', 'el', 'la', 'dia', 'lo', 'hice', 'pague', 'compre',
  'gaste', 'fecha', 'cambia', 'cambiala', 'cambialo', 'corrige', 'a', 'seria'
]);

/**
 * Fecha (YYYY-MM-DD) cuando el texto es SOLO una fecha con palabras de relleno: "fue ayer",
 * "era del 15", "el lunes", "15/11", "fue el 3 de noviembre". Si hay algo más, devuelve null.
 */
export function fechaDeTexto(texto, hoy = fechaHoySantiago()) {
  const palabras = normalizar(texto).replace(/[¿?¡!.,;:]/g, ' ').split(/\s+/).filter(Boolean);
  while (palabras.length > 1 && RELLENO_FECHA.has(palabras[0])) palabras.shift();
  const expr = palabras.join(' ');
  if (!expr) return null;

  if (expr === 'hoy') return hoy;
  if (expr === 'ayer') return sumarDias(hoy, -1);
  if (expr === 'anteayer' || expr === 'antier') return sumarDias(hoy, -2);

  if (expr in DIAS_NOMBRE) {
    let diferencia = DIAS_NOMBRE[expr] - diaSemana(hoy);
    if (diferencia > 0) diferencia -= 7;
    return sumarDias(hoy, diferencia);
  }

  const anioHoy = Number(hoy.slice(0, 4));
  const mesHoy = Number(hoy.slice(5, 7));
  let m;

  // 15/11, 15-11, 15/11/2026
  if ((m = /^(\d{1,2})[/-](\d{1,2})(?:[/-](\d{2}|\d{4}))?$/.exec(expr))) {
    const anioDado = m[3] ? (m[3].length === 2 ? 2000 + Number(m[3]) : Number(m[3])) : null;
    let f = construirFecha(anioDado ?? anioHoy, Number(m[2]), Number(m[1]));
    if (f && !anioDado && f > hoy) f = construirFecha(anioHoy - 1, Number(m[2]), Number(m[1]));
    return f && f <= hoy ? f : null;
  }

  // 15 de noviembre [de 2026]
  if ((m = /^(\d{1,2})\s+de\s+([a-z]+)(?:\s+de\s+(\d{4}))?$/.exec(expr)) && MESES_NOMBRE[m[2]]) {
    const anioDado = m[3] ? Number(m[3]) : null;
    let f = construirFecha(anioDado ?? anioHoy, MESES_NOMBRE[m[2]], Number(m[1]));
    if (f && !anioDado && f > hoy) f = construirFecha(anioHoy - 1, MESES_NOMBRE[m[2]], Number(m[1]));
    return f && f <= hoy ? f : null;
  }

  // Solo el día: el 15 (de este mes, o del anterior si todavía no llega)
  if ((m = /^(\d{1,2})$/.exec(expr)) && palabras.length === 1 && /\b(?:el|del|dia)\b/.test(normalizar(texto))) {
    let f = construirFecha(anioHoy, mesHoy, Number(m[1]));
    if (!f || f > hoy) {
      const mesAnterior = mesHoy === 1 ? 12 : mesHoy - 1;
      f = construirFecha(mesHoy === 1 ? anioHoy - 1 : anioHoy, mesAnterior, Number(m[1]));
    }
    return f;
  }

  return null;
}

const TIPOS_CUENTA_PALABRA = [
  { palabra: 'debito', tipo: 'tarjeta_debito' },
  { palabra: 'credito', tipo: 'tarjeta_credito' },
  { palabra: 'efectivo', tipo: 'efectivo' },
  { palabra: 'corriente', tipo: 'cuenta_corriente' },
  { palabra: 'vista', tipo: 'cuenta_vista' },
  { palabra: 'rut', tipo: 'cuenta_vista' },
  { palabra: 'ahorro', tipo: 'cuenta_ahorro' }
];

/**
 * Busca la cuenta que nombra el texto ("falabella", "débito", "FAN"). Devuelve { cuenta },
 * { ambiguas: [cuentas] } si varias calzan por igual, o null. `cuentas`: { id, nombre, banco, tipo }.
 */
export function buscarCuentaPorTexto(texto, cuentas = []) {
  const t = normalizar(texto).replace(/[¿?¡!.,;:]/g, ' ').replace(/\s+/g, ' ').trim();
  if (!t) return null;

  const puntuadas = cuentas.map(c => {
    const nombre = normalizar(c.nombre ?? '');
    const banco = normalizar(c.banco ?? '');
    let puntos = 0;
    if (nombre && nombre === t) puntos = 100;
    else if (nombre.length >= 3 && t.length >= 3 && (nombre.includes(t) || t.includes(nombre))) puntos = 80;
    else if (banco && banco === t) puntos = 70;
    else if (banco.length >= 3 && t.length >= 3 && (banco.includes(t) || t.includes(banco))) puntos = 60;
    else if (TIPOS_CUENTA_PALABRA.some(x => x.tipo === c.tipo && new RegExp(`\\b${x.palabra}\\b`).test(t))) puntos = 50;
    return { cuenta: c, puntos };
  }).filter(x => x.puntos > 0);

  if (puntuadas.length === 0) return null;
  const mejor = Math.max(...puntuadas.map(x => x.puntos));
  const empatadas = puntuadas.filter(x => x.puntos === mejor).map(x => x.cuenta);
  return empatadas.length === 1 ? { cuenta: empatadas[0] } : { ambiguas: empatadas };
}

/** Categoría que nombra el texto: igual o, si no, la única que lo contiene. null si no hay una clara. */
export function buscarCategoriaPorTexto(texto, categorias = []) {
  const t = normalizar(texto).replace(/[¿?¡!.,;:]/g, ' ').replace(/\s+/g, ' ').trim();
  if (!t) return null;
  const igual = categorias.find(c => normalizar(c.nombre) === t);
  if (igual) return igual;
  const parecidas = categorias.filter(c => {
    const n = normalizar(c.nombre);
    return t.length >= 3 && n.length >= 3 && (n.includes(t) || t.includes(n));
  });
  return parecidas.length === 1 ? parecidas[0] : null;
}

const PREFIJO_MONTO = /^\s*(?:no[,.]?\s*)?(?:eran|era|son|fueron|fue|es|ser[ií]an?|el\s+monto\s+(?:es|era|fue|son)|monto|corrige(?:\s+el)?\s+monto(?:\s+a)?|cambia(?:lo)?(?:\s+el\s+monto)?\s+a|c[aá]mbialo\s+a)\s*(?:de\s+)?(.+)$/i;

/**
 * Aplica a una cuenta/categoría nombrada en `termino` el cambio que corresponda. `soloCuenta` o
 * `soloCategoria` limitan la búsqueda cuando el texto lo dice ("la categoría es...").
 */
function resolverTermino(termino, { cuentas, categorias }, { soloCuenta = false, soloCategoria = false } = {}, salida) {
  if (!soloCategoria) {
    const c = buscarCuentaPorTexto(termino, cuentas);
    if (c?.cuenta) { salida.cambios.cuenta_id = c.cuenta.id; return true; }
    if (c?.ambiguas) { salida.ambiguas = c.ambiguas; return true; }
  }
  if (!soloCuenta) {
    const cat = buscarCategoriaPorTexto(termino, categorias);
    if (cat) { salida.cambios.categoria_id = cat.id; return true; }
  }
  const donde = soloCuenta ? 'cuentas' : soloCategoria ? 'categorías' : 'cuentas ni categorías';
  salida.problemas.push(`No encontré «${termino.trim().slice(0, 40)}» entre tus ${donde}.`);
  return true;
}

// Muletillas al comienzo de una corrección ("en realidad eran 4690", "creo que fue...", "perdón, son...")
const RELLENO_INICIAL = /^\s*(?:(?:no|ups|oye|ah|eh|bueno|mejor|digo|perd[oó]n|disculpa|ojo|la verdad|en realidad|realmente|me equivoqu[eé]|creo que|creo|parece que|seg[uú]n yo)\b[\s,.:;-]*)+/i;
// Palabras de aproximación que no cambian el monto ("como 4 mil", "unos 4690", "aprox")
const APROXIMACION = /\b(?:como|aprox\.?|aproximadamente|unos|unas|casi|cerca de|m[aá]s o menos)\b/gi;

/** Quita muletillas iniciales y palabras de aproximación de una corrección de monto */
export function limpiarCorreccion(texto) {
  return String(texto ?? '').replace(RELLENO_INICIAL, '').replace(APROXIMACION, ' ').replace(/\s+/g, ' ').trim();
}

/**
 * Interpreta la respuesta a un mensaje que creó un registro, solo con reglas. Devuelve
 *   { accion: 'deshacer' } | { accion: 'eliminar' } |
 *   { accion: 'corregir', cambios: { monto?, fecha?, cuenta_id?, categoria_id?, descripcion? }, ambiguas?, problemas }
 * o null si las reglas no alcanzan (entonces se consulta a Gemini). Función pura.
 */
export function clasificarReply(texto, { cuentas = [], categorias = [], hoy = fechaHoySantiago() } = {}) {
  const original = String(texto ?? '').trim();
  if (!original || original.startsWith('/')) return null;

  const norm = normalizar(original).replace(/[¿?¡!.,;:]/g, ' ').replace(/\s+/g, ' ').trim();
  if (norm.split(' ').length > 14) return null;

  if (VERBO_DESHACER.test(norm)) return { accion: 'deshacer', origen: 'reglas' };
  if (VERBO_ELIMINAR.test(norm) && !analizarMonto(original)) return { accion: 'eliminar', origen: 'reglas' };

  const salida = { accion: 'corregir', cambios: {}, problemas: [], ambiguas: null, origen: 'reglas' };

  // Un monto solo ("4500") o precedido de "eran", "era", "son"..., con o sin muletillas ("en realidad", "creo que")
  const limpio = limpiarCorreccion(original);
  const exacto = parsearMontoExacto(limpio);
  if (exacto) {
    salida.cambios.monto = exacto;
    return salida;
  }
  const conPrefijo = PREFIJO_MONTO.exec(limpio);
  if (conPrefijo) {
    const resto = conPrefijo[1].replace(/\b(?:pesos|clp)\b/gi, '').trim();
    const monto = parsearMontoExacto(resto);
    if (monto) {
      salida.cambios.monto = monto;
      return salida;
    }
  }

  const fecha = fechaDeTexto(original, hoy);
  if (fecha) {
    salida.cambios.fecha = fecha;
    return salida;
  }

  const contexto = { cuentas, categorias };
  let m;
  if ((m = /\bcategoria\s*(?:es|era|seria|a|de|:)?\s+(.+)$/.exec(norm))) {
    resolverTermino(m[1], contexto, { soloCategoria: true }, salida);
  } else if ((m = /\bcuenta\s*(?:es|era|seria|a|de|:)?\s+(.+)$/.exec(norm)) || (m = /^(?:no\s+)?(?:con|desde)\s+(?:la\s+|el\s+|mi\s+)?(?:tarjeta\s+)?(.+)$/.exec(norm))) {
    resolverTermino(m[1], contexto, { soloCuenta: true }, salida);
  } else if ((m = /^\s*(?:la\s+)?descripci[oó]n\s*(?:es|era|seria|a|:)?\s+(.+)$/i.exec(original))) {
    salida.cambios.descripcion = capitalizarNombre(m[1].replace(/^(?:el|la|los|las)\s+/i, '').trim());
  } else if ((m = /^(?:no\s+)?(?:era|fue|es|seria)\s+(?:con|de|desde|en)\s+(?:la\s+|el\s+|mi\s+)?(?:tarjeta\s+|cuenta\s+)?(.+)$/.exec(norm))) {
    // "era en el líder": si no es una cuenta ni una categoría, es el lugar del gasto (su descripción)
    const enLugar = /^\s*(?:no[,.]?\s*)?(?:era|fue|es|ser[ií]a)\s+en\s+(?:el\s+|la\s+|los\s+|las\s+)?(.+)$/i.exec(original);
    const esCuenta = buscarCuentaPorTexto(m[1], cuentas);
    if (enLugar && !esCuenta && !buscarCategoriaPorTexto(m[1], categorias)) {
      salida.cambios.descripcion = capitalizarNombre(enLugar[1].replace(/[¿?¡!.,;:]+$/g, '').trim());
    } else {
      resolverTermino(m[1], contexto, {}, salida);
    }
  } else {
    return null;
  }
  return salida;
}

/**
 * Convierte lo que devolvió Gemini ({ accion, monto, fecha, cuenta, categoria }) en lo mismo que
 * clasificarReply. Lo que no se pueda resolver con las cuentas y categorías reales queda en problemas.
 */
export function replyDesdeGemini(ia, { cuentas = [], categorias = [], hoy = fechaHoySantiago() } = {}) {
  if (!ia || !['eliminar', 'corregir', 'deshacer'].includes(ia.accion)) return null;
  if (ia.accion !== 'corregir') return { accion: ia.accion, origen: 'gemini' };

  const salida = { accion: 'corregir', cambios: {}, problemas: [], ambiguas: null, origen: 'gemini' };
  if (Number.isInteger(ia.monto) && ia.monto > 0) salida.cambios.monto = ia.monto;
  if (typeof ia.fecha === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(ia.fecha) && ia.fecha <= hoy) salida.cambios.fecha = ia.fecha;
  if (ia.cuenta) resolverTermino(ia.cuenta, { cuentas, categorias }, { soloCuenta: true }, salida);
  if (ia.categoria) resolverTermino(ia.categoria, { cuentas, categorias }, { soloCategoria: true }, salida);

  const hayAlgo = Object.keys(salida.cambios).length > 0 || salida.ambiguas || salida.problemas.length > 0;
  return hayAlgo ? salida : null;
}

/**
 * Clasifica un mensaje con reglas. Devuelve { intencion, datos, confianza: 'alta', origen: 'reglas' }
 * o null si ninguna regla alcanza. Función pura.
 */
export function clasificarPorReglas(texto) {
  const original = String(texto ?? '').trim();
  if (!original || original.startsWith('/')) return null;

  const norm = normalizar(original).replace(/[¿?¡!]/g, ' ').replace(/\s+/g, ' ').trim();
  const hayMonto = Boolean(analizarMonto(original));
  const resultado = (intencion, datos = {}) => ({ intencion, datos, confianza: 'alta', origen: 'reglas' });

  // "elimina el último gasto" sin responder a ningún mensaje
  if (detectarEliminarUltimo(original)) return resultado('eliminar_ultimo');

  // "qué datos tienes guardados": la vista de /cuentas (siempre por reglas, sin Gemini)
  if (detectarDatosGuardados(original)) return resultado('cuentas');

  // "estado", "todo bien?": el chequeo de /status
  if (detectarEstado(original)) return resultado('estado');

  // Reinicio total y restauración: solo abren la confirmación (botones y frase escrita)
  const reinicio = detectarReset(original);
  if (reinicio) return resultado(reinicio);

  // "guarda la tarjeta crédito 8263 es de Valeska": guardar una cuenta o tarjeta (siempre por reglas, sin Gemini)
  const nuevaCuenta = detectarGuardarCuenta(original);
  if (nuevaCuenta) return resultado('guardar_cuenta', nuevaCuenta);

  // "la FAN termina en 6958": asignar los últimos 4 dígitos a una cuenta (siempre con confirmación)
  const digitos = detectarAsignarDigitos(original);
  if (digitos) return resultado('asignar_digitos', digitos);

  // Pedidos sin monto
  if (!hayMonto) {
    if (/\b(que puedes hacer|que sabes hacer|para que sirves|como te uso|como funciona|que haces|ayuda|help)\b/.test(norm)) {
      return resultado('ayuda');
    }
    if (/\b(?:que|cuales)\s+cuentas\s+(?:tengo|hay|activas)\b|\bmis\s+cuentas\b|\bcuentas\s+(?:activas|que\s+tengo)\b|\b(?:lista(?:me)?|muestrame|ver)\s+(?:las\s+|mis\s+)?cuentas\b/.test(norm)) {
      return resultado('cuentas');
    }
  }

  const consultaDatos = detectarConsultaDatos(original);
  if (consultaDatos) return resultado('datos_transferencia', { termino: consultaDatos.termino });

  if (detectarConsultaPlan(original)) return resultado('plan');

  if (parsearPagoCuota(original)) return resultado('pagar_cuota', { texto: original });
  if (detectarAltaCuotas(original)) return resultado('nueva_compra_cuotas', { texto: original });
  if (detectarConsultaCuotas(original)) return resultado('cuotas_pendientes', { texto: original });
  if (!hayMonto && /\b(?:mis\s+cuotas|cuotas\s+pendientes|que\s+cuotas\s+(?:tengo|debo|me\s+quedan)|compras\s+en\s+cuotas)\b/.test(norm)) {
    return resultado('cuotas_pendientes', { lista: true });
  }

  if (!hayMonto) {
    const buscar = /^(?:busca(?:me)?|buscar|encuentra(?:me)?|muestrame(?:\s+los)?\s+movimientos(?:\s+de)?)\s+(.+)$/.exec(norm);
    if (buscar) {
      // Se conserva el texto original (con tildes) sin el verbo del comienzo
      const sinVerbo = original.replace(/^\s*(?:busca(?:me)?|buscar|encuentra(?:me)?|mu[eé]strame(?:\s+los)?\s+movimientos(?:\s+de)?)\s+/i, '');
      return resultado('buscar', { texto: limpiarBusqueda(sinVerbo) });
    }

    if (
      /\bcuanto\s+(?:he\s+|hemos\s+)?(?:gaste|gastado|gastamos|llevo|llevamos)\b/.test(norm) ||
      /\b(?:mis\s+)?gastos\s+(?:del?\s+)?(?:este\s+)?mes\b|\btotal\s+de\s+gastos\b/.test(norm)
    ) {
      return resultado('consultar_gastos', { texto: original });
    }
  }

  // Un monto sin ninguna otra intención: un gasto o un ingreso
  if (hayMonto) return resultado('registrar');

  return null;
}

/**
 * ¿Se puede mandar este mensaje a Gemini sin riesgo? Nunca si parece traer datos de transferencia,
 * RUT, correos o números de cuenta.
 */
export function puedeEnviarseAGemini(texto) {
  const t = String(texto ?? '');
  const norm = normalizar(t);
  if (/@/.test(t)) return false;
  if (/\b(rut|r\.u\.t|titular|datos de transferencia|savetrans|numero de cuenta|n[°º]\s*de\s*cuenta)\b/.test(norm)) return false;
  if (/\bcuenta\s+(?:corriente|vista|rut|de\s+ahorro)\b/.test(norm)) return false;
  if (/\b\d{1,2}(?:\.\d{3}){2}-[\dkK]\b|\b\d{7,8}-[\dkK]\b/.test(t)) return false;
  if (/\d(?:[ -]?\d){12,18}/.test(t) || /\d{9,}/.test(t)) return false;
  return true;
}

// ---------------------------------------------------------------------------
// Enrutador
// ---------------------------------------------------------------------------

export function crearIntenciones(ctx) {
  const { enviar, editar, responderCallback, esc } = ctx;
  // Límite de llamadas a Gemini por chat (30 por hora); se puede inyectar en pruebas
  const limitador = ctx.limitador ?? limitadorGemini;

  // Mensajes que esperan que el usuario elija la intención: clave -> { texto }
  const preguntas = new Map();
  // Chat al que se le pidió el monto de un gasto: chatId -> { texto, hasta }
  const esperandoMonto = new Map();
  let contador = 0;

  const nuevaClave = (chatId) => `${chatId}_${Date.now()}_${contador++}`;

  /** Pregunta con botones qué quiso hacer el usuario (nunca se adivina) */
  async function preguntarIntencion(chatId, texto, sugerida = null) {
    const key = nuevaClave(chatId);
    preguntas.set(key, { texto });
    setTimeout(() => preguntas.delete(key), ESPERA_MS);

    const candidatas = Object.keys(ETIQUETAS);
    if (sugerida && ETIQUETAS[sugerida]) {
      candidatas.splice(candidatas.indexOf(sugerida), 1);
      candidatas.unshift(sugerida);
    }

    await enviar(chatId, 'No entendí ese mensaje. ¿Quieres guardar una cuenta, registrar un gasto o ver algo? Elige:', {
      reply_markup: {
        inline_keyboard: [
          ...candidatas.map(i => [{ text: ETIQUETAS[i], callback_data: `inte_${key}_${CODIGOS[i]}` }]),
          [{ text: 'Cancelar', callback_data: `intx_${key}` }]
        ]
      }
    });
    return true;
  }

  /** Se pasó el límite de Gemini: no se interpreta el mensaje y se muestran ejemplos */
  async function noEntendido(chatId) {
    await enviar(chatId,
      'No entendí ese mensaje. Prueba con algo como:\n' +
      '• almuerzo 5500 débito\n' +
      '• me pagaron 400 mil\n' +
      '• cuánto gasté este mes\n' +
      '• cuánto puedo gastar\n' +
      '• pagué cuota tía mac 7/12\n\n' +
      'Escribe /help para ver más ejemplos.'
    );
    return true;
  }

  /** Falta el monto de un gasto o ingreso: se pregunta y se espera la respuesta */
  async function preguntarMonto(chatId, texto) {
    esperandoMonto.set(chatId, { texto, hasta: Date.now() + ESPERA_MS });
    await enviar(chatId, '¿De cuánto fue? Escribe el monto (por ejemplo 5.500 o 5 lucas).', {
      reply_markup: { inline_keyboard: [[{ text: 'Cancelar', callback_data: 'intm_x' }]] }
    });
    return true;
  }

  /** Ejecuta una intención ya decidida. Devuelve true si el mensaje quedó atendido. */
  async function ejecutar(r, msg) {
    const chatId = msg.chat.id;
    const texto = msg.text.trim();
    const datos = r.datos ?? {};

    switch (r.intencion) {
      case 'registrar':
        // Sin monto no se adivina: se pregunta
        if (!analizarMonto(texto)) return preguntarMonto(chatId, texto);
        await ctx.registrar(msg, { confianzaBaja: r.confianza === 'baja' });
        return true;

      case 'pagar_cuota':
      case 'nueva_compra_cuotas':
      case 'cuotas_pendientes': {
        if (datos.lista) {
          await ctx.cuotasLista(chatId);
          return true;
        }
        // El texto canónico (lo que reescribió Gemini) se prueba primero; si no sirve, el original
        const candidatos = [datos.texto, texto].filter((t, i, todos) => t && todos.indexOf(t) === i);
        for (const candidato of candidatos) {
          if (await ctx.cuotasMensaje({ ...msg, text: candidato })) return true;
        }
        if (r.intencion === 'cuotas_pendientes') {
          await ctx.cuotasLista(chatId);
          return true;
        }
        return preguntarIntencion(chatId, texto);
      }

      case 'consultar_gastos':
        await ctx.consultarGastos(chatId, datos.texto ?? texto);
        return true;

      case 'plan':
        await ctx.plan(chatId);
        return true;

      case 'datos_transferencia': {
        // Solo el nombre de la cuenta o institución; la búsqueda y la respuesta son locales
        const termino = datos.termino !== undefined ? datos.termino : (terminoDesdeTexto(datos.texto ?? '') || null);
        await ctx.datos(chatId, termino);
        return true;
      }

      case 'cuentas':
        await ctx.cuentas(chatId);
        return true;

      case 'buscar':
        await ctx.buscar(chatId, limpiarBusqueda(datos.texto ?? texto));
        return true;

      case 'ayuda':
        await ctx.ayuda(chatId);
        return true;

      case 'guardar_cuenta':
        if (datos.textoCuenta && ctx.guardarCuenta) {
          await ctx.guardarCuenta(msg, datos);
          return true;
        }
        if (ctx.ayudaGuardarCuenta) {
          await ctx.ayudaGuardarCuenta(chatId);
          return true;
        }
        return preguntarIntencion(chatId, texto);

      case 'estado':
        if (ctx.estado) {
          await ctx.estado(chatId);
          return true;
        }
        return preguntarIntencion(chatId, texto);

      case 'reset':
        if (ctx.reset) {
          await ctx.reset(chatId);
          return true;
        }
        return preguntarIntencion(chatId, texto);

      case 'restaurar_respaldo':
        if (ctx.restaurarRespaldo) {
          await ctx.restaurarRespaldo(chatId);
          return true;
        }
        return preguntarIntencion(chatId, texto);

      case 'asignar_digitos':
        if (ctx.asignarDigitos && datos.digitos) {
          await ctx.asignarDigitos(chatId, datos);
          return true;
        }
        return preguntarIntencion(chatId, texto);

      case 'eliminar_ultimo':
        if (ctx.eliminarUltimo) {
          await ctx.eliminarUltimo(chatId);
          return true;
        }
        return preguntarIntencion(chatId, texto);

      default:
        return preguntarIntencion(chatId, texto);
    }
  }

  /**
   * Atiende un mensaje de texto libre (sin comando). Siempre lo resuelve: lo ejecuta o pregunta.
   * Devuelve true.
   */
  async function manejarTexto(msg) {
    const chatId = msg.chat.id;
    const texto = msg.text.trim();

    // Respuesta al "¿De cuánto fue?"
    const espera = esperandoMonto.get(chatId);
    if (espera) {
      esperandoMonto.delete(chatId);
      if (Date.now() <= espera.hasta && parsearMontoExacto(texto)) {
        await ctx.registrar({ ...msg, text: `${espera.texto} ${texto}` }, { confianzaBaja: false });
        return true;
      }
    }

    // 1. Reglas rápidas
    const porReglas = clasificarPorReglas(texto);
    if (porReglas) return ejecutar(porReglas, msg);

    // 2. Gemini, solo con mensajes que no traen datos sensibles
    if (geminiDisponible() && puedeEnviarseAGemini(texto)) {
      // Máximo 30 llamadas por hora por chat; al pasarlo no se interpreta y se muestran ejemplos
      if (!limitador.consumir(chatId)) return noEntendido(chatId);

      const ia = await interpretarIntencion(texto);
      if (ia && ia.intencion !== 'desconocida') {
        const datos = ia.intencion === 'datos_transferencia' ? { texto: ia.texto } : { texto: ia.texto ?? undefined };
        // La intención la dedujo un modelo: confianza media como máximo
        const confianza = ia.confianza === 'baja' ? 'baja' : 'media';

        // Lo que escribe en la BD con confianza baja se confirma con "Corregir"; con las demás
        // intenciones de baja confianza se pregunta antes de ejecutar
        if (confianza === 'baja' && ia.intencion !== 'registrar') return preguntarIntencion(chatId, texto, ia.intencion);
        return ejecutar({ intencion: ia.intencion, datos, confianza, origen: 'gemini' }, msg);
      }
    }

    // 3. Nada alcanzó (o el mensaje trae datos sensibles y no va a Gemini): se pregunta, nunca se queda en silencio.
    // Si habla de una tarjeta o cuenta, "guardar una cuenta" va primero.
    return preguntarIntencion(chatId, texto, /\b(?:tarjeta|cuenta)\b/.test(normalizar(texto)) ? 'guardar_cuenta' : null);
  }

  /** Botones de este módulo. Devuelve true si el callback era suyo. */
  async function manejarCallback(cb, chatId, data) {
    const messageId = cb.message.message_id;
    let m;

    if (data === 'intm_x') {
      esperandoMonto.delete(chatId);
      await editar('Cancelado', { chat_id: chatId, message_id: messageId });
      await responderCallback(cb.id, { text: 'Cancelado' });
      return true;
    }

    if (data.startsWith('intx_')) {
      preguntas.delete(data.replace('intx_', ''));
      await editar('Cancelado', { chat_id: chatId, message_id: messageId });
      await responderCallback(cb.id, { text: 'Cancelado' });
      return true;
    }

    if ((m = data.match(/^inte_(.+)_([a-z]{2})$/))) {
      const pregunta = preguntas.get(m[1]);
      const intencion = INTENCION_POR_CODIGO[m[2]];
      if (!pregunta || !intencion) {
        await responderCallback(cb.id, { text: 'Solicitud expirada' });
        return true;
      }
      preguntas.delete(m[1]);
      await editar(esc(ETIQUETAS[intencion] ?? 'Listo'), { chat_id: chatId, message_id: messageId });
      await responderCallback(cb.id, {});

      // El usuario eligió: se ejecuta con confianza alta
      await ejecutar(
        { intencion, datos: intencion === 'consultar_gastos' ? { texto: pregunta.texto } : {}, confianza: 'alta', origen: 'boton' },
        { chat: { id: chatId }, text: pregunta.texto }
      );
      return true;
    }

    return false;
  }

  return { manejarTexto, manejarCallback };
}
