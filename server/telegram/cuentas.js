/**
 * Alta de cuentas desde texto libre (/savecard): tipo, banco, alias, últimos 4 dígitos,
 * titular y, en crédito, cupo y día de pago.
 *
 * Seguridad: nunca se conserva un número de tarjeta/cuenta completo. Solo se aceptan los
 * últimos 4 dígitos; si el texto trae un número de 13 a 19 dígitos se descarta y se avisa.
 */

import { analizarMonto } from './parser.js';

// Tipos que entiende el parser, con su etiqueta y el tipo con que se guarda en la tabla cuentas
export const TIPOS_CUENTA = ['debito', 'credito', 'efectivo', 'cuenta_corriente', 'cuenta_vista', 'ahorro'];

export const ETIQUETAS_TIPO_CUENTA = {
  debito: 'Tarjeta de débito',
  credito: 'Tarjeta de crédito',
  efectivo: 'Efectivo',
  cuenta_corriente: 'Cuenta corriente',
  cuenta_vista: 'Cuenta vista',
  ahorro: 'Cuenta de ahorro'
};

// Etiqueta del tipo tal como se guarda en la tabla cuentas
export const ETIQUETAS_TIPO_DB = {
  tarjeta_debito: 'Tarjeta de débito',
  tarjeta_credito: 'Tarjeta de crédito',
  cuenta_corriente: 'Cuenta corriente',
  cuenta_vista: 'Cuenta vista',
  cuenta_ahorro: 'Cuenta de ahorro',
  efectivo: 'Efectivo'
};

// Tipo con que se guarda cada uno en la tabla cuentas
export const TIPO_DB = {
  debito: 'tarjeta_debito',
  credito: 'tarjeta_credito',
  efectivo: 'efectivo',
  cuenta_corriente: 'cuenta_corriente',
  cuenta_vista: 'cuenta_vista',
  ahorro: 'cuenta_ahorro'
};

/**
 * Bancos e instituciones reconocidos. `terminos` van sin tildes y en minúsculas; se acepta
 * un prefijo opcional "banco" / "banco de". Reutilizada por los datos de transferencia.
 */
export const BANCOS = [
  { nombre: 'Banco de Chile', terminos: ['banco de chile', 'banco chile', 'bancochile'] },
  { nombre: 'BancoEstado', terminos: ['bancoestado', 'banco estado', 'banco del estado'] },
  { nombre: 'Santander', terminos: ['santander'] },
  { nombre: 'BCI', terminos: ['bci'] },
  { nombre: 'Falabella', terminos: ['falabella'] },
  { nombre: 'Scotiabank', terminos: ['scotiabank', 'scotia'] },
  { nombre: 'Itaú', terminos: ['itau'] },
  { nombre: 'BICE', terminos: ['bice'] },
  { nombre: 'Security', terminos: ['security'] },
  { nombre: 'Ripley', terminos: ['ripley'] },
  // Instituciones no bancarias (billeteras y prepago), usadas sobre todo en datos de transferencia
  { nombre: 'Mercado Pago', terminos: ['mercado pago', 'mercadopago'] },
  { nombre: 'Tenpo', terminos: ['tenpo'] },
  { nombre: 'MACH', terminos: ['mach'] },
  { nombre: 'Coopeuch', terminos: ['coopeuch'] },
  { nombre: 'Prepago Los Héroes', terminos: ['prepago los heroes', 'los heroes'] }
];

export function normalizar(texto) {
  return String(texto).normalize('NFC').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
}

function escaparRegex(texto) {
  return texto.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Busca un banco en un texto ya normalizado. Devuelve { nombre, inicio, fin } con la
 * primera aparición (incluido el prefijo "banco"), o null.
 */
export function buscarBanco(textoNormalizado) {
  let mejor = null;
  for (const banco of BANCOS) {
    const terminos = [...banco.terminos].sort((a, b) => b.length - a.length).map(escaparRegex);
    const regex = new RegExp(
      `(?<![\\p{L}\\p{N}])(?:banco\\s+(?:de\\s+)?)?(?:${terminos.join('|')})(?![\\p{L}\\p{N}])`,
      'u'
    );
    const m = regex.exec(textoNormalizado);
    if (m && (!mejor || m.index < mejor.inicio)) {
      mejor = { nombre: banco.nombre, inicio: m.index, fin: m.index + m[0].length };
    }
  }
  return mejor;
}

/** Nombre del banco de la lista que coincide con el texto (sin tildes ni mayúsculas), o null */
export function bancoPorNombre(texto) {
  if (typeof texto !== 'string') return null;
  const buscado = normalizar(texto.trim());
  return BANCOS.find(b => normalizar(b.nombre) === buscado)?.nombre ?? null;
}

/**
 * Enmascara números largos antes de enviar texto a un servicio externo: los números de
 * 13 a 19 dígitos (con espacios o guiones) y cualquier racha de 5 o más dígitos.
 */
export function enmascararDigitos(texto) {
  return String(texto)
    .replace(/\d(?:[ -]?\d){12,18}/g, '[número]')
    .replace(/\d{5,}/g, '[número]');
}

/** Nombre por defecto cuando no queda alias: tipo + banco */
export function nombrePorDefecto(tipo, banco) {
  const base = ETIQUETAS_TIPO_CUENTA[tipo] ?? 'Cuenta';
  return banco ? `${base} ${banco}` : base;
}

export function capitalizarNombre(texto) {
  const limpio = texto.replace(/\s+/g, ' ').trim();
  // Solo se reescribe si viene todo en minúsculas (o todo en mayúsculas)
  if (limpio !== limpio.toLowerCase() && limpio !== limpio.toUpperCase()) return limpio;
  return limpio
    .toLowerCase()
    .split(' ')
    .map(p => (p ? p[0].toUpperCase() + p.slice(1) : p))
    .join(' ');
}

// Patrones de tipo (sobre texto sin tildes). Se elige el que aparece primero en el mensaje.
const PATRONES_TIPO = [
  ['credito', /(?:tarjeta\s+(?:de\s+)?)?credito/],
  ['debito', /(?:tarjeta\s+(?:de\s+)?)?debito/],
  ['efectivo', /efectivo/],
  ['ahorro', /(?:cuenta\s+(?:de\s+)?)?ahorro/],
  ['cuenta_corriente', /(?:cuenta\s+)?corriente|cta\.?\s*cte\.?/],
  ['cuenta_vista', /cuenta\s+rut|(?:cuenta\s+)?vista/]
];

// Palabras sueltas que no forman parte del alias
const PALABRAS_VACIAS = new Set([
  'tarjeta', 'cuenta', 'cta', 'mi', 'mia', 'mio', 'mis', 'a', 'en',
  'con', 'y', 'para', 'es', 'un', 'una', 'banco', 'nombre', 'tipo', 'titular'
]);

// Preposiciones y artículos que se recortan solo si quedan al borde del alias
const PALABRAS_BORDE = new Set(['de', 'del', 'la', 'el', 'los', 'las']);

// Valores que significan "soy yo" en el titular
const TITULAR_PROPIO = new Set(['yo', 'mio', 'mia', 'propia', 'propio', 'yo mismo', 'yo misma']);

/**
 * Titular cuando dice "yo / mío / propia": TITULAR_POR_DEFECTO del entorno, o "Yo" si
 * está vacía. Se lee al llamar para respetar el entorno ya cargado.
 */
function titularPorDefecto() {
  return (process.env.TITULAR_POR_DEFECTO || '').trim() || 'Yo';
}

/** Valor de un marcador de titular: "yo" -> titular por defecto; si no, el nombre capitalizado */
function valorTitular(valor) {
  return TITULAR_PROPIO.has(normalizar(valor).trim()) ? titularPorDefecto() : capitalizarNombre(valor);
}

/**
 * Interpreta el texto de /savecard (con o sin el comando delante).
 * @returns {{
 *   tipo: string|null, banco: string|null, nombre: string|null, ultimos4: string|null,
 *   ultimos4Cuenta: string|null, titular: string|null, cupo: number|null, diaPago: number|null,
 *   numeroCompletoRechazado: boolean
 * }}
 */
export function parsearCuenta(texto) {
  let original = String(texto ?? '').normalize('NFC').replace(/^\s*\/\w+(?:@\w+)?\s*/, '');
  let norm = normalizar(original);
  if (norm.length !== original.length) norm = original.toLowerCase();

  // Se "borra" un tramo con espacios en ambas copias para conservar los índices
  const quitar = (inicio, fin) => {
    const blanco = ' '.repeat(fin - inicio);
    original = original.slice(0, inicio) + blanco + original.slice(fin);
    norm = norm.slice(0, inicio) + blanco + norm.slice(fin);
  };

  const resultado = {
    tipo: null,
    banco: null,
    nombre: null,
    ultimos4: null,
    ultimos4Cuenta: null,
    titular: null,
    cupo: null,
    diaPago: null,
    numeroCompletoRechazado: false
  };

  // 1. Número de 13 a 19 dígitos: se descarta (no se guarda ni se repite)
  const largo = /\d(?:[ -]?\d){12,18}/.exec(norm);
  if (largo) {
    resultado.numeroCompletoRechazado = true;
    quitar(largo.index, largo.index + largo[0].length);
  }

  // 2a. Últimos 4 del NÚMERO DE CUENTA: "cuenta terminada en 1234", "cuenta corriente final 1234".
  //     Solo se quita lo que sigue a "cuenta ..." para que el tipo (corriente, vista...) se siga detectando.
  const cuentaTerminada = /\b(cuenta(?:\s+(?:corriente|vista|rut|de\s+ahorro))?\s+)((?:termina(?:d[ao]s?)?|final)\s+(?:en\s+)?(\d{4})(?!\d))/.exec(norm);
  if (cuentaTerminada) {
    resultado.ultimos4Cuenta = cuentaTerminada[3];
    const inicio = cuentaTerminada.index + cuentaTerminada[1].length;
    quitar(inicio, inicio + cuentaTerminada[2].length);
  }

  // 2b. Últimos 4 de la TARJETA: "terminada en 1234", "termina en 1234", "final 1234", "**** 1234"
  const ult = /(?:termina(?:d[ao]s?)?|final)\s+(?:en\s+)?(\d{4})(?!\d)|\*{2,}\s*(\d{4})(?!\d)/.exec(norm);
  if (ult) {
    resultado.ultimos4 = ult[1] ?? ult[2];
    quitar(ult.index, ult.index + ult[0].length);
  }

  // 3. Titular con marcador: "a nombre mio (juan sanhueza)", "a nombre de X", "titular X",
  //    "titular: X". Si el valor es yo / mio / mia / propia se usa el titular por defecto.
  const mio = /\ba\s+nombre\s+mi[oa]\b\s*(?:\(([^)]*)\))?/d.exec(norm);
  if (mio) {
    const nombre = mio[1] && mio.indices[1] ? original.slice(mio.indices[1][0], mio.indices[1][1]).trim() : '';
    resultado.titular = nombre ? capitalizarNombre(nombre) : titularPorDefecto();
    quitar(mio.index, mio.index + mio[0].length);
  } else {
    const marcador = /(?:\btitular\s*:?|\ba\s+nombre\s+del?)\s*(.+?)(?=\s+(?:cupo|paga|pago|vence|banco|termina|final)\b|\s*$)/d.exec(norm);
    if (marcador) {
      const valor = original
        .slice(marcador.indices[1][0], marcador.indices[1][1])
        .replace(/[()]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
      if (valor) resultado.titular = valorTitular(valor);
      quitar(marcador.index, marcador.index + marcador[0].length);
    }
  }

  // 4. Día de pago: "paga el 24", "pago el 24", "vence el 24", "día de pago 24"
  const dia = /\b(?:paga|pago|vence|vencimiento|dia\s+de\s+pago|dia\s+pago)(?:\s+el)?(?:\s+dia)?\s+(\d{1,2})\b/.exec(norm);
  if (dia) {
    const numero = parseInt(dia[1], 10);
    if (numero >= 1 && numero <= 31) resultado.diaPago = numero;
    quitar(dia.index, dia.index + dia[0].length);
  }

  // 5. Cupo: "cupo 110 mil", "cupo de 1.500.000" (reutiliza el parser de montos)
  const cupo = /\bcupo\s*(?:total\s+)?(?:de\s+|:\s*)?/.exec(norm);
  if (cupo) {
    const finCupo = cupo.index + cupo[0].length;
    const monto = analizarMonto(original.slice(finCupo));
    if (monto && monto.inicio <= 1) {
      resultado.cupo = monto.monto;
      quitar(cupo.index, finCupo + monto.fin);
    }
  }

  // 6. Tipo: el patrón que aparece primero
  let mejorTipo = null;
  for (const [tipo, regex] of PATRONES_TIPO) {
    const m = regex.exec(norm);
    if (m && (!mejorTipo || m.index < mejorTipo.inicio)) {
      mejorTipo = { tipo, inicio: m.index, fin: m.index + m[0].length, esCuentaRut: /cuenta\s+rut/.test(m[0]) };
    }
  }
  let esCuentaRut = false;
  if (mejorTipo) {
    resultado.tipo = mejorTipo.tipo;
    esCuentaRut = mejorTipo.esCuentaRut;
    quitar(mejorTipo.inicio, mejorTipo.fin);
  }

  // 7. Banco (la tarjeta CMR es de Falabella y la cuenta RUT de BancoEstado)
  const banco = buscarBanco(norm);
  if (banco) {
    resultado.banco = banco.nombre;
    quitar(banco.inicio, banco.fin);
  } else if (/(?<![\p{L}\p{N}])cmr(?![\p{L}\p{N}])/u.test(norm)) {
    resultado.banco = 'Falabella';
    if (!resultado.tipo) resultado.tipo = 'credito';
  } else if (esCuentaRut) {
    resultado.banco = 'BancoEstado';
  }

  // 8. Titular sin marcador: "... de Juan Sanhueza" al final. Debe ser un nombre propio con
  //    mayúscula inicial y minúsculas ("de FAN", en mayúsculas, es un alias, no un titular).
  if (!resultado.titular) {
    const de = /(?<![\p{L}\p{N}])de\s+(\p{Lu}\p{Ll}+(?:\s+\p{Lu}\p{Ll}+){0,3})\s*$/du.exec(original);
    if (de) {
      resultado.titular = capitalizarNombre(de[1]);
      quitar(de.index, de.index + de[0].length);
    }
  }

  // 9. Alias: lo que queda, sin palabras vacías ni signos sueltos; "de", "del", "la" y "el"
  //    sueltos se recortan solo en los bordes
  const palabras = original
    .split(/\s+/)
    .map(p => p.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, ''))
    .filter(p => p && !PALABRAS_VACIAS.has(normalizar(p)));
  while (palabras.length && PALABRAS_BORDE.has(normalizar(palabras[0]))) palabras.shift();
  while (palabras.length && PALABRAS_BORDE.has(normalizar(palabras[palabras.length - 1]))) palabras.pop();
  const alias = palabras.join(' ').slice(0, 100);

  resultado.nombre = alias || (resultado.tipo ? nombrePorDefecto(resultado.tipo, resultado.banco) : null);

  return resultado;
}
