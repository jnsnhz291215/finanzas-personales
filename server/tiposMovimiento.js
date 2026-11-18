/**
 * Tipos de movimiento (clasificación) compartidos por la API y el bot.
 *
 * `tipo` (cargo/abono) sigue siendo el sentido del dinero en la cuenta origen.
 * `tipo_movimiento` dice qué es: pago_tarjeta y transferencia_propia solo mueven
 * dinero entre cuentas propias (no son gasto ni ingreso).
 */

export const TIPOS_MOVIMIENTO = [
  'compra',
  'pago_tarjeta',
  'transferencia_propia',
  'transferencia_terceros',
  'ingreso',
  'otro'
];

// Requieren cuenta_destino_id
export const TIPOS_CON_DESTINO = ['pago_tarjeta', 'transferencia_propia'];

// No cuentan como gasto ni como ingreso en totales y resúmenes
export const TIPOS_SIN_TOTALES = ['pago_tarjeta', 'transferencia_propia'];

export const ETIQUETAS_TIPO = {
  compra: 'Compra',
  pago_tarjeta: 'Pago de tarjeta',
  transferencia_propia: 'Transferencia entre mis cuentas',
  transferencia_terceros: 'Transferencia a terceros',
  ingreso: 'Ingreso',
  otro: 'Otro'
};

/**
 * Fragmento SQL para excluir movimientos internos de gastos/ingresos.
 * @param {string} alias alias de la tabla movimientos (con punto), p. ej. 'm.'
 */
export function sqlExcluirInternos(alias = '') {
  return `${alias}tipo_movimiento NOT IN (${TIPOS_SIN_TOTALES.map(t => `'${t}'`).join(', ')})`;
}

export function requiereDestino(tipoMovimiento) {
  return TIPOS_CON_DESTINO.includes(tipoMovimiento);
}

/**
 * Resuelve tipo_movimiento y el sentido (cargo/abono) a partir de lo recibido.
 * - Sin tipo_movimiento válido: abono -> ingreso, cualquier otro -> compra.
 * - ingreso siempre es abono; compra, pagos y transferencias siempre son cargo.
 * - otro respeta el sentido indicado (por defecto cargo).
 */
export function resolverTipos({ tipo, tipo_movimiento: tipoMovimiento }) {
  const tm = TIPOS_MOVIMIENTO.includes(tipoMovimiento)
    ? tipoMovimiento
    : (tipo === 'abono' ? 'ingreso' : 'compra');

  let sentido = 'cargo';
  if (tm === 'ingreso') sentido = 'abono';
  else if (tm === 'otro' && tipo === 'abono') sentido = 'abono';

  return { tipo_movimiento: tm, tipo: sentido };
}
