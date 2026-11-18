/**
 * Plan de ahorro mensual por porcentajes. Lo usan la API (routes/planAhorro.js) y el bot.
 *
 * Fórmulas (ver calcularPlan):
 *   ingreso            = ingreso_base si está definido; si no, ingresos reales del mes (sin traspasos)
 *   metaAhorro         = ingreso * pct_ahorro / 100
 *   presupuestoFijos   = ingreso * pct_fijos / 100        (solo se compara con los fijos reales)
 *   fijosReales        = suma de gastos_fijos activos
 *   presupuestoLibre   = ingreso - metaAhorro - fijosReales   (los fijos reales, no el porcentaje)
 *   gastadoLibre       = gastos del mes (compra y transferencia_terceros) que no son fijos
 *   disponible         = presupuestoLibre - gastadoLibre
 *   disponiblePorDia   = disponible / diasRestantes (hoy incluido); 0 si el disponible es negativo
 *
 * Este módulo no importa la BD al cargarse (se importa de forma diferida dentro de cada
 * función de datos), así que las funciones puras se pueden probar sin base de datos.
 */

import { analizarMonto } from './telegram/parser.js';
import { fechaHoySantiago } from './telegram/fechas.js';
import { sqlExcluirInternos } from './tiposMovimiento.js';

export const TIPOS_GASTO_LIBRE = ['compra', 'transferencia_terceros'];

const PORCENTAJES_POR_DEFECTO = { pct_fijos: 50, pct_libres: 30, pct_ahorro: 20 };

const formatoCLP = new Intl.NumberFormat('es-CL');
const dinero = (n) => `${n < 0 ? '-' : ''}$${formatoCLP.format(Math.abs(Math.round(n)))}`;

function normalizar(texto) {
  return String(texto ?? '').normalize('NFC').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
}

function aNumero(valor) {
  if (valor === null || valor === undefined || valor === '') return NaN;
  return Number(valor);
}

// ---------------------------------------------------------------------------
// Validación
// ---------------------------------------------------------------------------

/** Valida que los tres porcentajes estén entre 0 y 100 y sumen 100 */
export function validarPorcentajes({ pct_fijos: fijos, pct_libres: libres, pct_ahorro: ahorro }) {
  const valores = [fijos, libres, ahorro].map(aNumero);
  if (valores.some(n => !Number.isFinite(n) || n < 0 || n > 100)) {
    return { ok: false, error: 'Los porcentajes deben ser números entre 0 y 100' };
  }
  const suma = valores[0] + valores[1] + valores[2];
  if (Math.abs(suma - 100) > 1e-6) {
    return { ok: false, error: `Los porcentajes deben sumar 100 (suman ${Math.round(suma * 100) / 100})` };
  }
  return { ok: true, valores: { pct_fijos: valores[0], pct_libres: valores[1], pct_ahorro: valores[2] } };
}

/** Valida los datos de un gasto fijo (API y bot) */
export function validarGastoFijo(datos) {
  const nombre = String(datos?.nombre ?? '').trim();
  if (!nombre || nombre.length > 100) return { ok: false, error: 'El nombre es obligatorio (hasta 100 caracteres)' };

  const monto = aNumero(datos?.monto);
  if (!Number.isFinite(monto) || monto <= 0) return { ok: false, error: 'El monto debe ser mayor que 0' };

  let diaPago = null;
  if (datos?.dia_pago !== null && datos?.dia_pago !== undefined && datos?.dia_pago !== '') {
    diaPago = aNumero(datos.dia_pago);
    if (!Number.isInteger(diaPago) || diaPago < 1 || diaPago > 31) {
      return { ok: false, error: 'El día de pago debe estar entre 1 y 31' };
    }
  }

  const entero = (valor) => {
    if (valor === null || valor === undefined || valor === '') return null;
    const n = aNumero(valor);
    return Number.isInteger(n) ? n : NaN;
  };
  const categoriaId = entero(datos?.categoria_id);
  const cuentaId = entero(datos?.cuenta_id);
  if (Number.isNaN(categoriaId) || Number.isNaN(cuentaId)) {
    return { ok: false, error: 'Categoría o cuenta no válidas' };
  }

  return {
    ok: true,
    valores: { nombre, monto: Math.round(monto), dia_pago: diaPago, categoria_id: categoriaId, cuenta_id: cuentaId }
  };
}

// ---------------------------------------------------------------------------
// Fechas del mes (hora de Chile)
// ---------------------------------------------------------------------------

/** Rango del mes de `hoy` (YYYY-MM-DD) y días que quedan, contando hoy */
export function infoMes(hoy) {
  const [anio, mes, dia] = hoy.split('-').map(Number);
  const diasMes = new Date(Date.UTC(anio, mes, 0)).getUTCDate();
  const mm = String(mes).padStart(2, '0');
  return {
    anio,
    mes,
    diaActual: dia,
    diasMes,
    diasRestantes: diasMes - dia + 1,
    inicio: `${anio}-${mm}-01`,
    fin: `${anio}-${mm}-${String(diasMes).padStart(2, '0')}`
  };
}

// ---------------------------------------------------------------------------
// Cálculo
// ---------------------------------------------------------------------------

/**
 * Un movimiento cuenta como gasto fijo si su categoría es la de un gasto fijo activo o si su
 * descripción contiene el nombre de uno (sin tildes ni mayúsculas, nombres de 3+ letras).
 * Limitación: una categoría compartida (p. ej. "Servicios") hace que todo lo de esa categoría
 * cuente como fijo.
 */
export function esGastoFijo(movimiento, gastosFijos) {
  const descripcion = normalizar(movimiento.descripcion);
  return gastosFijos.some(f => {
    const mismaCategoria =
      f.categoria_id != null && movimiento.categoria_id != null &&
      Number(f.categoria_id) === Number(movimiento.categoria_id);
    const nombre = normalizar(f.nombre).trim();
    return mismaCategoria || (nombre.length >= 3 && descripcion.includes(nombre));
  });
}

/**
 * Calcula el resumen del mes. Función pura.
 * @param {object} p
 * @param {{ingreso_base: number|null, pct_fijos: number, pct_libres: number, pct_ahorro: number}} p.plan
 * @param {Array} p.gastosFijos gastos fijos (solo cuentan los activos)
 * @param {number} p.ingresosReales ingresos del mes sin traspasos
 * @param {Array} p.gastos movimientos del mes (compra y transferencia_terceros) con descripcion, monto, categoria_id
 * @param {string} p.hoy YYYY-MM-DD en America/Santiago
 */
export function calcularPlan({ plan, gastosFijos = [], ingresosReales = 0, gastos = [], hoy }) {
  const mes = infoMes(hoy);
  const activos = gastosFijos.filter(f => f.activo === undefined || f.activo === true || Number(f.activo) === 1);

  const base = plan.ingreso_base === null || plan.ingreso_base === undefined || plan.ingreso_base === ''
    ? null
    : Number(plan.ingreso_base);
  const ingreso = base !== null ? base : Number(ingresosReales) || 0;

  const pct = {
    fijos: Number(plan.pct_fijos),
    libres: Number(plan.pct_libres),
    ahorro: Number(plan.pct_ahorro)
  };

  const metaAhorro = ingreso * pct.ahorro / 100;
  const presupuestoFijos = ingreso * pct.fijos / 100;
  const fijosReales = activos.reduce((suma, f) => suma + Number(f.monto), 0);
  const presupuestoLibre = ingreso - metaAhorro - fijosReales;

  let gastadoLibre = 0;
  let gastadoFijo = 0;
  for (const g of gastos) {
    if (esGastoFijo(g, activos)) gastadoFijo += Number(g.monto);
    else gastadoLibre += Number(g.monto);
  }

  const disponible = presupuestoLibre - gastadoLibre;
  const disponiblePorDia = disponible > 0 ? disponible / mes.diasRestantes : 0;
  const pctLibreUsado = presupuestoLibre > 0
    ? Math.round(gastadoLibre / presupuestoLibre * 100)
    : (gastadoLibre > 0 ? 100 : 0);

  // Alertas
  const alertas = [];
  if (ingreso <= 0) {
    alertas.push({ codigo: 'sin_ingresos', nivel: 'info', mensaje: 'No hay ingresos este mes: define un ingreso base en el plan.' });
  }
  if (ingreso > 0 && fijosReales > presupuestoFijos) {
    alertas.push({
      codigo: 'fijos_sobre_porcentaje',
      nivel: 'aviso',
      mensaje: `Tus gastos fijos (${dinero(fijosReales)}) superan el ${pct.fijos}% del ingreso (${dinero(presupuestoFijos)}).`
    });
  }
  if (gastadoLibre > 0 && gastadoLibre > presupuestoLibre) {
    alertas.push({ codigo: 'libre_sobre_100', nivel: 'critica', mensaje: 'Ya gastaste más que tu presupuesto libre del mes.' });
  } else if (presupuestoLibre > 0 && gastadoLibre >= presupuestoLibre * 0.8) {
    alertas.push({
      codigo: 'libre_sobre_80',
      nivel: 'aviso',
      mensaje: `Llevas el ${pctLibreUsado}% de tu presupuesto libre del mes.`
    });
  }
  if (disponible < 0) {
    alertas.push({
      codigo: 'ahorro_en_riesgo',
      nivel: 'critica',
      mensaje: `Tu meta de ahorro está en riesgo: te faltan ${dinero(-disponible)} para cubrir el mes.`
    });
  }

  return {
    mes,
    porcentajes: pct,
    ingreso: Math.round(ingreso),
    ingresoOrigen: base !== null ? 'base' : 'real',
    ingresoBase: base,
    ingresosReales: Math.round(Number(ingresosReales) || 0),
    metaAhorro: Math.round(metaAhorro),
    fijos: {
      presupuesto: Math.round(presupuestoFijos),
      real: Math.round(fijosReales),
      diferencia: Math.round(presupuestoFijos - fijosReales),
      cantidad: activos.length,
      gastadoEsteMes: Math.round(gastadoFijo)
    },
    libre: {
      presupuesto: Math.round(presupuestoLibre),
      referenciaPorcentaje: Math.round(ingreso * pct.libres / 100),
      gastado: Math.round(gastadoLibre),
      porcentajeUsado: pctLibreUsado
    },
    disponible: Math.round(disponible),
    disponiblePorDia: Math.round(disponiblePorDia),
    alertas
  };
}

// ---------------------------------------------------------------------------
// Datos (BD)
// ---------------------------------------------------------------------------

async function consulta() {
  return (await import('./db.js')).query;
}

function normalizarPlan(fila) {
  return {
    ingreso_base: fila.ingreso_base === null || fila.ingreso_base === undefined ? null : Number(fila.ingreso_base),
    pct_fijos: Number(fila.pct_fijos),
    pct_libres: Number(fila.pct_libres),
    pct_ahorro: Number(fila.pct_ahorro),
    actualizado_en: fila.actualizado_en ?? null
  };
}

function normalizarFijo(fila) {
  return { ...fila, monto: Number(fila.monto), activo: Number(fila.activo) === 1 };
}

/** Plan guardado (fila única); si falta, se crea con los valores por defecto */
export async function cargarPlan() {
  const query = await consulta();
  const [filas] = await query(
    'SELECT ingreso_base, pct_fijos, pct_libres, pct_ahorro, actualizado_en FROM plan_ahorro WHERE id = 1'
  );
  if (filas.length > 0) return normalizarPlan(filas[0]);

  await query(
    'INSERT INTO plan_ahorro (id, pct_fijos, pct_libres, pct_ahorro) VALUES (1, ?, ?, ?)',
    [PORCENTAJES_POR_DEFECTO.pct_fijos, PORCENTAJES_POR_DEFECTO.pct_libres, PORCENTAJES_POR_DEFECTO.pct_ahorro]
  );
  return { ingreso_base: null, ...PORCENTAJES_POR_DEFECTO, actualizado_en: null };
}

/** Guarda porcentajes e ingreso base (ya validados con validarPorcentajes) */
export async function guardarPlan({ ingreso_base: ingresoBase, pct_fijos, pct_libres, pct_ahorro }) {
  const query = await consulta();
  await query(
    `UPDATE plan_ahorro
     SET ingreso_base = ?, pct_fijos = ?, pct_libres = ?, pct_ahorro = ?, actualizado_en = CURRENT_TIMESTAMP
     WHERE id = 1`,
    [ingresoBase, pct_fijos, pct_libres, pct_ahorro]
  );
  return cargarPlan();
}

export async function listarGastosFijos({ incluirInactivos = false } = {}) {
  const query = await consulta();
  const [filas] = await query(
    `SELECT f.id, f.nombre, f.monto, f.dia_pago, f.categoria_id, f.cuenta_id, f.activo,
            c.nombre AS categoria_nombre, cu.nombre AS cuenta_nombre
     FROM gastos_fijos f
     LEFT JOIN categorias c ON f.categoria_id = c.id
     LEFT JOIN cuentas cu ON f.cuenta_id = cu.id
     ${incluirInactivos ? '' : 'WHERE f.activo = 1'}
     ORDER BY f.nombre`
  );
  return filas.map(normalizarFijo);
}

export async function crearGastoFijo({ nombre, monto, dia_pago, categoria_id, cuenta_id }) {
  const query = await consulta();
  const [resultado] = await query(
    'INSERT INTO gastos_fijos (nombre, monto, dia_pago, categoria_id, cuenta_id) VALUES (?, ?, ?, ?, ?)',
    [nombre, monto, dia_pago, categoria_id, cuenta_id]
  );
  return resultado.insertId;
}

export async function actualizarGastoFijo(id, { nombre, monto, dia_pago, categoria_id, cuenta_id }, activo = true) {
  const query = await consulta();
  await query(
    `UPDATE gastos_fijos
     SET nombre = ?, monto = ?, dia_pago = ?, categoria_id = ?, cuenta_id = ?, activo = ?, actualizado_en = CURRENT_TIMESTAMP
     WHERE id = ?`,
    [nombre, monto, dia_pago, categoria_id, cuenta_id, activo ? 1 : 0, id]
  );
}

/** Soft delete: activo = 0, no se borra la fila */
export async function desactivarGastoFijo(id) {
  const query = await consulta();
  const [resultado] = await query(
    'UPDATE gastos_fijos SET activo = 0, actualizado_en = CURRENT_TIMESTAMP WHERE id = ?',
    [id]
  );
  return resultado.affectedRows > 0;
}

/** Plan, gastos fijos y resumen calculado del mes de `hoy` (por defecto, hoy en Chile) */
export async function obtenerPlan(hoy = fechaHoySantiago()) {
  const query = await consulta();
  const { inicio, fin } = infoMes(hoy);

  const [plan, gastosFijos] = await Promise.all([cargarPlan(), listarGastosFijos()]);

  const [ingresos] = await query(
    `SELECT COALESCE(SUM(monto), 0) AS total FROM movimientos
     WHERE tipo = 'abono' AND ${sqlExcluirInternos()} AND fecha BETWEEN ? AND ?`,
    [inicio, fin]
  );
  const [gastos] = await query(
    `SELECT descripcion, monto, categoria_id FROM movimientos
     WHERE tipo = 'cargo'
       AND tipo_movimiento IN (${TIPOS_GASTO_LIBRE.map(t => `'${t}'`).join(', ')})
       AND fecha BETWEEN ? AND ?`,
    [inicio, fin]
  );

  const resumen = calcularPlan({
    plan,
    gastosFijos,
    ingresosReales: Number(ingresos[0].total) || 0,
    gastos,
    hoy
  });

  return { plan, gastosFijos, resumen };
}

// ---------------------------------------------------------------------------
// Texto libre (bot): /fijo y consultas sin comando
// ---------------------------------------------------------------------------

/**
 * Interpreta "arriendo 350 mil el 5" (con o sin /fijo delante): nombre, monto y día de pago.
 * Reutiliza el parser de montos. monto es null si no hay un monto reconocible.
 */
export function parsearFijo(texto) {
  const limpio = String(texto ?? '').replace(/^\s*\/\w+(?:@\w+)?\s*/, '').trim();
  const analisis = analizarMonto(limpio);
  if (!analisis) return { nombre: null, monto: null, diaPago: null };

  let resto = `${limpio.slice(0, analisis.inicio)} ${limpio.slice(analisis.fin)}`;

  let diaPago = null;
  const dia = /\b(?:el|dia|día|los)\s+(\d{1,2})\b/i.exec(resto);
  if (dia) {
    const numero = parseInt(dia[1], 10);
    if (numero >= 1 && numero <= 31) diaPago = numero;
    resto = resto.replace(dia[0], ' ');
  }

  const nombre = resto
    .replace(/\$+/g, ' ')
    .replace(/\b(?:mensuales?|al mes|cada mes)\b/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  return {
    nombre: nombre ? nombre[0].toUpperCase() + nombre.slice(1) : null,
    monto: analisis.monto,
    diaPago
  };
}

/**
 * Detecta "cuánto puedo gastar", "cuánto me queda", "cuánto debería ahorrar" sin comando.
 * Solo si el mensaje no trae ningún número (nunca un monto).
 */
export function detectarConsultaPlan(texto) {
  const original = String(texto ?? '').trim();
  if (!original || original.startsWith('/') || /\d/.test(original) || analizarMonto(original)) return false;

  return /\bcuanto\s+(?:puedo\s+gastar|me\s+queda|deberia\s+ahorrar|debo\s+ahorrar|tengo\s+que\s+ahorrar|tengo\s+para\s+gastar)\b/
    .test(normalizar(original));
}
