/**
 * Mis propios datos de transferencia (los que entrego para que me depositen), uno por
 * cuenta o institución, y su consulta en lenguaje natural ("pásame los datos de la
 * mercado pago").
 *
 * Son datos sensibles (RUT, número de cuenta, correo): este módulo no registra nada en
 * consola y quien lo use no debe loguearlos.
 */

import { analizarMonto } from './parser.js';
import { buscarBanco, normalizar, capitalizarNombre } from './cuentas.js';

export const TIPOS_CUENTA_TRANSFERENCIA = ['corriente', 'vista', 'rut', 'ahorro'];

export const ETIQUETAS_TIPO_TRANSFERENCIA = {
  corriente: 'Cuenta Corriente',
  vista: 'Cuenta Vista',
  rut: 'Cuenta RUT',
  ahorro: 'Cuenta de Ahorro'
};

// ---------------------------------------------------------------------------
// RUT
// ---------------------------------------------------------------------------

/** Dígito verificador (módulo 11) de un cuerpo de RUT: '0'-'9' o 'K' */
export function calcularDV(cuerpo) {
  let suma = 0;
  let multiplicador = 2;
  for (let i = cuerpo.length - 1; i >= 0; i--) {
    suma += Number(cuerpo[i]) * multiplicador;
    multiplicador = multiplicador === 7 ? 2 : multiplicador + 1;
  }
  const resto = 11 - (suma % 11);
  if (resto === 11) return '0';
  if (resto === 10) return 'K';
  return String(resto);
}

/**
 * Normaliza un RUT a 12345678-5 (sin puntos, DV en mayúscula) y valida el dígito
 * verificador. Devuelve null si el formato o el DV no son válidos.
 */
export function normalizarRut(texto) {
  const limpio = String(texto ?? '').replace(/[.\s]/g, '').toUpperCase();
  const m = /^(\d{7,8})-?([\dK])$/.exec(limpio);
  if (!m) return null;
  return calcularDV(m[1]) === m[2] ? `${m[1]}-${m[2]}` : null;
}

/** 12345678-5 -> 12.345.678-5 */
export function formatearRut(rut) {
  const m = /^(\d+)-([\dK])$/.exec(String(rut ?? ''));
  if (!m) return String(rut ?? '');
  return `${m[1].replace(/\B(?=(\d{3})+(?!\d))/g, '.')}-${m[2]}`;
}

// ---------------------------------------------------------------------------
// Interpretación de /savetrans
// ---------------------------------------------------------------------------

const PATRONES_TIPO = [
  ['rut', /cuenta\s+rut/],
  ['vista', /(?:cuenta\s+)?vista/],
  ['corriente', /(?:cuenta\s+)?corriente|cta\.?\s*cte\.?/],
  ['ahorro', /(?:cuenta\s+(?:de\s+)?)?ahorro/]
];

// Palabras sueltas que no son parte del nombre del titular
const PALABRAS_VACIAS = new Set([
  'cuenta', 'cta', 'de', 'del', 'la', 'el', 'mi', 'mis', 'datos', 'transferencia', 'tipo', 'banco',
  'con', 'y', 'a', 'en', 'nro', 'numero', 'n', 'rut', 'correo', 'email', 'mail', 'titular', 'alias',
  'nombre', 'para'
]);

/**
 * Interpreta el texto de /savetrans (con o sin el comando delante).
 * @returns {{
 *   alias: string|null, titular: string|null, rut: string|null, rutInvalido: boolean,
 *   banco: string|null, tipoCuenta: string|null, numeroCuenta: string|null, email: string|null
 * }}
 */
export function parsearDatos(texto) {
  let original = String(texto ?? '').normalize('NFC').replace(/^\s*\/\w+(?:@\w+)?\s*/, '');
  let norm = normalizar(original);
  if (norm.length !== original.length) norm = original.toLowerCase();

  // Se "borra" un tramo con espacios en ambas copias para conservar los índices
  const quitar = (inicio, fin) => {
    const blanco = ' '.repeat(fin - inicio);
    original = original.slice(0, inicio) + blanco + original.slice(fin);
    norm = norm.slice(0, inicio) + blanco + norm.slice(fin);
  };

  const r = {
    alias: null,
    titular: null,
    rut: null,
    rutInvalido: false,
    banco: null,
    tipoCuenta: null,
    numeroCuenta: null,
    email: null
  };

  // 1. Correo
  const correo = /(?:\b(?:correo|email|e-mail|mail)\s*:?\s*)?([a-z0-9._%+-]+@[a-z0-9-]+(?:\.[a-z0-9-]+)+)/i.exec(original);
  if (correo) {
    r.email = correo[1].toLowerCase();
    quitar(correo.index, correo.index + correo[0].length);
  }

  // 2. Tipo de cuenta (el que aparece primero). Va antes que el RUT para que "cuenta rut"
  //    no se confunda con la palabra "rut" que precede al número
  let mejorTipo = null;
  for (const [tipo, regex] of PATRONES_TIPO) {
    const m = regex.exec(norm);
    if (m && (!mejorTipo || m.index < mejorTipo.inicio)) {
      mejorTipo = { tipo, inicio: m.index, fin: m.index + m[0].length };
    }
  }
  if (mejorTipo) {
    r.tipoCuenta = mejorTipo.tipo;
    quitar(mejorTipo.inicio, mejorTipo.fin);
  }

  // 3. RUT: con guion ("12.345.678-5", "12345678-5", con o sin "rut") o con la palabra
  //    "rut" y sin guion ("rut 123456785"). Se valida el dígito verificador.
  const rutConGuion = /(?:\brut\s*:?\s*)?(?<![\d.])(\d{1,2}(?:\.\d{3}){2}|\d{7,8})\s*-\s*([\dk])(?![\p{L}\p{N}])/iu.exec(norm);
  const rutSinGuion = rutConGuion ? null : /\brut\s*:?\s*(\d{1,2}(?:\.?\d{3}){2})([\dk])(?![\p{L}\p{N}])/iu.exec(norm);
  const rutMatch = rutConGuion || rutSinGuion;
  if (rutMatch) {
    const cuerpo = rutMatch[1].replace(/\./g, '');
    const dv = rutMatch[2].toUpperCase();
    if (calcularDV(cuerpo) === dv) r.rut = `${cuerpo}-${dv}`;
    else r.rutInvalido = true;
    quitar(rutMatch.index, rutMatch.index + rutMatch[0].length);
  }

  // 4. Banco o institución
  const banco = buscarBanco(norm);
  if (banco) {
    r.banco = banco.nombre;
    quitar(banco.inicio, banco.fin);
  }

  // 5. Número de cuenta (6 a 20 dígitos seguidos). En cuenta RUT sin número se usa el RUT sin DV.
  const numero = /(?<![\d.])\d{6,20}(?![\d.])/.exec(norm);
  if (numero) {
    r.numeroCuenta = numero[0];
    quitar(numero.index, numero.index + numero[0].length);
  } else if (r.tipoCuenta === 'rut' && r.rut) {
    r.numeroCuenta = r.rut.split('-')[0];
  }

  // 6. Alias explícito: alias fan / alias "mi cuenta"
  const alias = /\balias\s*:?\s*(?:"([^"]+)"|(\S+))/d.exec(norm);
  if (alias) {
    const [ini, fin] = alias.indices[1] ?? alias.indices[2];
    r.alias = original.slice(ini, fin).trim();
    quitar(alias.index, alias.index + alias[0].length);
  }

  // 7. Titular: "titular X" / "a nombre de X", o los nombres propios que sobran
  const marcador = /(?:\btitular|\ba\s+nombre\s+de|\bnombre)\s*:?\s*(.+?)\s*$/d.exec(norm);
  let titular = null;
  if (marcador) {
    titular = original.slice(marcador.indices[1][0], marcador.indices[1][1]);
    quitar(marcador.index, marcador.index + marcador[0].length);
  } else {
    titular = original
      .split(/\s+/)
      .map(p => p.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, ''))
      .filter(p => p && !PALABRAS_VACIAS.has(normalizar(p)))
      .join(' ');
  }
  titular = titular.replace(/[()]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 100);
  r.titular = titular ? capitalizarNombre(titular) : null;

  // Alias por defecto: el nombre del banco o institución
  if (!r.alias && r.banco) r.alias = r.banco;

  return r;
}

/** Campos obligatorios que faltan, en el orden en que se piden */
export function camposFaltantes(datos) {
  const faltan = [];
  if (!datos.banco) faltan.push('banco');
  if (!datos.tipoCuenta) faltan.push('tipoCuenta');
  if (!datos.numeroCuenta) faltan.push('numeroCuenta');
  if (!datos.titular) faltan.push('titular');
  if (!datos.rut) faltan.push('rut');
  return faltan;
}

// ---------------------------------------------------------------------------
// Consulta en lenguaje natural
// ---------------------------------------------------------------------------

// Palabras que se descartan al buscar el alias o banco en una consulta
const PALABRAS_CONSULTA = new Set([
  'pasame', 'pasa', 'pasar', 'mandame', 'manda', 'enviame', 'envia', 'dame', 'necesito', 'quiero',
  'muestrame', 'muestra', 'mostrar', 'cual', 'cuales', 'es', 'son', 'datos', 'dato', 'transferencia',
  'transferencias', 'de', 'del', 'la', 'el', 'los', 'las', 'mi', 'mis', 'me', 'cuenta', 'por', 'favor',
  'porfa', 'pf', 'a', 'para', 'lo', 'un', 'una', 'bancarios', 'bancarios', 'banco'
]);

/**
 * Detecta un pedido de datos propios ("pásame los datos de transferencia de la mercado
 * pago", "datos de la FAN", "mis datos del banco de chile"). Si el mensaje trae un monto
 * nunca es una consulta (sigue siendo un gasto). Devuelve { termino } (null si no se
 * nombró ninguna cuenta) o null cuando no es una consulta.
 */
export function detectarConsultaDatos(texto) {
  const original = String(texto ?? '').trim();
  if (!original || original.startsWith('/')) return null;

  const norm = normalizar(original);
  if (!/\bdatos?\b/.test(norm)) return null;
  if (analizarMonto(original)) return null;
  // Un mensaje con números largos (cuenta, RUT) es otra cosa, no un pedido
  if (/\d{4,}/.test(norm)) return null;

  const termino = terminoDeBusqueda(norm);
  return { termino: termino || null };
}

/** Quita las palabras de relleno y deja lo que identifica a la cuenta pedida */
function terminoDeBusqueda(normalizado) {
  return normalizado
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .split(/\s+/)
    .filter(p => p && !PALABRAS_CONSULTA.has(p))
    .join(' ')
    .trim();
}

/** Mismo criterio que la consulta, para /datos <texto> */
export function terminoDesdeTexto(texto) {
  return terminoDeBusqueda(normalizar(String(texto ?? '')));
}

/**
 * Busca registros por alias o banco ignorando tildes, mayúsculas y artículos.
 * Si hay uno cuyo alias coincide exactamente, devuelve solo ese.
 */
export function buscarRegistros(registros, termino) {
  const buscado = terminoDesdeTexto(termino);
  if (!buscado) return [];

  // El texto puede nombrar el banco de otra forma ("banco de chile", "mercadopago")
  const bancoCanonico = buscarBanco(normalizar(termino));
  const bancoNormalizado = bancoCanonico ? normalizar(bancoCanonico.nombre) : null;

  const exactos = registros.filter(r => normalizar(r.alias) === buscado);
  if (exactos.length > 0) return exactos;

  return registros.filter(r => {
    const alias = normalizar(r.alias);
    const banco = normalizar(r.banco);
    return (
      (alias.length >= 2 && (alias.includes(buscado) || buscado.includes(alias))) ||
      (banco.length >= 2 && (banco.includes(buscado) || buscado.includes(banco))) ||
      (bancoNormalizado && banco === bancoNormalizado)
    );
  });
}

/**
 * Datos listos para copiar y reenviar: un campo por línea, texto plano, sin etiquetas.
 * Titular, RUT, banco, tipo de cuenta, número y correo (si hay).
 */
export function textoPlanoDatos(registro) {
  const lineas = [
    registro.nombre_titular,
    formatearRut(registro.rut),
    registro.banco,
    ETIQUETAS_TIPO_TRANSFERENCIA[registro.tipo_cuenta] ?? registro.tipo_cuenta,
    registro.numero_cuenta
  ];
  if (registro.email) lineas.push(registro.email);
  return lineas.join('\n');
}
