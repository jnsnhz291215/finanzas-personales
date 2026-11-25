// Tipos de movimiento: etiqueta, icono Font Awesome y color de la paleta actual.
// Compartido por Movimientos y Dashboard para que ambos se vean igual.
export const TIPOS_MOVIMIENTO = [
  { value: 'compra', label: 'Compra', icon: 'fa-cart-shopping', color: 'text-gray-600' },
  { value: 'pago_tarjeta', label: 'Pago de tarjeta', icon: 'fa-credit-card', color: 'text-blue-600' },
  { value: 'transferencia_propia', label: 'Transferencia entre mis cuentas', icon: 'fa-right-left', color: 'text-blue-600' },
  { value: 'transferencia_terceros', label: 'Transferencia a terceros', icon: 'fa-paper-plane', color: 'text-purple-600' },
  { value: 'ingreso', label: 'Ingreso', icon: 'fa-arrow-down', color: 'text-green-600' },
  { value: 'otro', label: 'Otro', icon: 'fa-ellipsis', color: 'text-gray-600' }
];

// Solo mueven dinero entre cuentas propias: no son gasto ni ingreso
export const TIPOS_CON_DESTINO = ['pago_tarjeta', 'transferencia_propia'];

// Movimientos antiguos o importados pueden venir sin tipo_movimiento (o abonos como "compra")
export const tipoEfectivo = (mov) => {
  if (mov.tipo === 'abono' && (!mov.tipo_movimiento || mov.tipo_movimiento === 'compra')) return 'ingreso';
  return mov.tipo_movimiento || 'compra';
};

export const infoTipo = (valor) => TIPOS_MOVIMIENTO.find(t => t.value === valor) || TIPOS_MOVIMIENTO[0];

// Color y signo del monto: los internos van en azul y sin signo; transferencia_terceros
// cuenta como gasto (cargo) y el resto según cargo/abono
export const estiloMonto = (mov) => {
  if (TIPOS_CON_DESTINO.includes(tipoEfectivo(mov))) return { clase: 'text-blue-600', signo: '' };
  return mov.tipo === 'cargo'
    ? { clase: 'text-red-600', signo: '-' }
    : { clase: 'text-green-600', signo: '+' };
};
