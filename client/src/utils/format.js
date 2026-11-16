// Formatear montos en CLP con formato chileno
export function formatCLP(monto) {
  if (monto === null || monto === undefined) return '$0';
  
  const numero = typeof monto === 'string' ? parseFloat(monto) : monto;
  
  return new Intl.NumberFormat('es-CL', {
    style: 'currency',
    currency: 'CLP',
    minimumFractionDigits: 0,
    maximumFractionDigits: 0
  }).format(numero);
}

// Formatear fecha en formato chileno
export function formatFecha(fecha) {
  if (!fecha) return '';
  
  const date = new Date(fecha + 'T00:00:00');
  return new Intl.DateTimeFormat('es-CL', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric'
  }).format(date);
}

// Formatear fecha con mes en texto
export function formatFechaLarga(fecha) {
  if (!fecha) return '';
  
  const date = new Date(fecha + 'T00:00:00');
  return new Intl.DateTimeFormat('es-CL', {
    day: 'numeric',
    month: 'long',
    year: 'numeric'
  }).format(date);
}

// Obtener nombre del mes
export function nombreMes(numeroMes) {
  const meses = [
    'Enero', 'Febrero', 'Marzo', 'Abril', 'Mayo', 'Junio',
    'Julio', 'Agosto', 'Septiembre', 'Octubre', 'Noviembre', 'Diciembre'
  ];
  return meses[numeroMes - 1] || '';
}

// Obtener mes y año actual
export function mesAnioActual() {
  const hoy = new Date();
  return {
    mes: hoy.getMonth() + 1,
    anio: hoy.getFullYear()
  };
}

// Convertir fecha a formato YYYY-MM-DD
export function toDateInput(fecha) {
  if (!fecha) return '';
  const date = new Date(fecha);
  return date.toISOString().split('T')[0];
}
