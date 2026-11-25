/**
 * Utilidades de fechas para el bot, siempre en hora de Chile (America/Santiago).
 * Las fechas viajan como texto YYYY-MM-DD. La aritmética se hace con componentes
 * en UTC solo para sumar días; nunca se interpreta un 'YYYY-MM-DD' con new Date()
 * para mostrarlo (se corre un día por la zona horaria).
 */

export const ZONA_HORARIA = 'America/Santiago';

function pad(n) {
  return String(n).padStart(2, '0');
}

function aISO(fechaUTC) {
  return `${fechaUTC.getUTCFullYear()}-${pad(fechaUTC.getUTCMonth() + 1)}-${pad(fechaUTC.getUTCDate())}`;
}

function aPartes(iso) {
  const [anio, mes, dia] = iso.split('-').map(Number);
  return { anio, mes, dia };
}

/** Fecha de hoy (YYYY-MM-DD) en America/Santiago */
export function fechaHoySantiago(ahora = new Date()) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: ZONA_HORARIA,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).format(ahora);
}

/** Suma (o resta) días a una fecha YYYY-MM-DD */
export function sumarDias(iso, dias) {
  const { anio, mes, dia } = aPartes(iso);
  return aISO(new Date(Date.UTC(anio, mes - 1, dia + dias)));
}

/** Día de la semana de una fecha YYYY-MM-DD (0 = domingo) */
export function diaSemana(iso) {
  const { anio, mes, dia } = aPartes(iso);
  return new Date(Date.UTC(anio, mes - 1, dia)).getUTCDay();
}

/** Construye YYYY-MM-DD si año/mes/día forman una fecha real; si no, null */
export function construirFecha(anio, mes, dia) {
  const f = new Date(Date.UTC(anio, mes - 1, dia));
  if (f.getUTCFullYear() !== anio || f.getUTCMonth() !== mes - 1 || f.getUTCDate() !== dia) {
    return null;
  }
  return aISO(f);
}

/**
 * Formatea para mostrar (DD-MM-YYYY) un valor de fecha de la BD o del bot.
 * - 'YYYY-MM-DD' (o con hora): se reordena el texto, sin pasar por Date.
 * - Date (por ejemplo MySQL DATE): se leen sus componentes locales.
 */
export function formatearFechaCL(valor) {
  if (valor instanceof Date) {
    return `${pad(valor.getDate())}-${pad(valor.getMonth() + 1)}-${valor.getFullYear()}`;
  }
  const m = String(valor ?? '').match(/^(\d{4})-(\d{2})-(\d{2})/);
  return m ? `${m[3]}-${m[2]}-${m[1]}` : String(valor ?? '');
}
