/**
 * Una sola fuente de verdad de los comandos del bot. De aquí salen:
 *  - /help, /ayuda y /start (la lista completa, por sección, y unos ejemplos de frases);
 *  - el aviso de "comando que no existe" (COMANDOS_CONOCIDOS);
 *  - el menú "/" de Telegram (COMANDOS_MENU: los marcados con `menu`).
 *
 * Para no olvidar ninguno: cada comando que se registre con bot.onText o con comando() en cualquier manejador debe
 * estar aquí (comandos.test.js revisa el código fuente y falla si falta alguno o si sobra uno que ya no existe).
 */

export const SECCIONES = ['General', 'Finanzas', 'Cuotas y fijos', 'Cuentas y datos', 'Categorías y reglas', 'Sistema'];

/**
 * nombre: sin la barra; alias: otros nombres que hacen lo mismo; uso: argumentos opcionales para mostrar;
 * ejemplo (OBLIGATORIO, comandos.test.js falla si falta): un uso real y claro, que empieza con el comando ("/estadocuenta 8263"); en un
 * comando sin argumentos es solo el comando ("/cuotas");
 * menu: posición en el menú "/" de Telegram (1 a 6; sin menu no aparece), con menuDescripcion, la de ese menú.
 */
export const COMANDOS = [
  // General
  { seccion: 'General', nombre: 'start', ejemplo: '/start', descripcion: 'Saludo y esta lista de comandos' },
  { seccion: 'General', nombre: 'help', alias: ['ayuda'], ejemplo: '/help', descripcion: 'Esta lista de comandos y ejemplos', menu: 1, menuDescripcion: 'Qué puedo hacer y ejemplos' },
  { seccion: 'General', nombre: 'miid', ejemplo: '/miid', descripcion: 'Ver tu chat ID (para autorizarlo en el servidor)' },
  { seccion: 'General', nombre: 'status', ejemplo: '/status', descripcion: 'Estado de la app: servidor, base de datos, Gemini, Telegram y más', menu: 5, menuDescripcion: 'Estado de la app' },

  // Finanzas
  { seccion: 'Finanzas', nombre: 'resumen', ejemplo: '/resumen', descripcion: 'Resumen del mes: ingresos, gastos y saldo' },
  { seccion: 'Finanzas', nombre: 'ultimos', ejemplo: '/ultimos', descripcion: 'Últimos movimientos, con botones para editar o borrar' },
  { seccion: 'Finanzas', nombre: 'buscar', uso: '<texto o mes>', ejemplo: '/buscar uber octubre', descripcion: 'Buscar movimientos' },
  { seccion: 'Finanzas', nombre: 'gastos', ejemplo: '/gastos', descripcion: 'Gastos del mes por categoría y uso de tus tarjetas de crédito' },
  { seccion: 'Finanzas', nombre: 'plan', uso: '[config | ingreso <monto> | 50 30 20]', ejemplo: '/plan ingreso 1500000', descripcion: 'Plan de ahorro del mes: cuánto puedes gastar', menu: 2, menuDescripcion: 'Mi plan de ahorro del mes' },
  { seccion: 'Finanzas', nombre: 'deudas', ejemplo: '/deudas', descripcion: 'Quién te debe y cuánto' },
  { seccion: 'Finanzas', nombre: 'pago', uso: '<persona> <monto>', ejemplo: '/pago Pedro 20 mil', descripcion: 'Registrar el pago de una deuda' },

  // Cuotas y fijos
  { seccion: 'Cuotas y fijos', nombre: 'cuotas', uso: '[nueva ... | cartola ...]', ejemplo: '/cuotas', descripcion: 'Todas tus compras en cuotas (activas y terminadas) por titular', menu: 4, menuDescripcion: 'Mis compras en cuotas' },
  { seccion: 'Cuotas y fijos', nombre: 'fijo', uso: '<nombre> <monto> [el <día>]', ejemplo: '/fijo arriendo 350 mil el 5', descripcion: 'Agregar un gasto fijo' },
  { seccion: 'Cuotas y fijos', nombre: 'fijos', ejemplo: '/fijos', descripcion: 'Ver tus gastos fijos, editarlos o desactivarlos' },

  // Cuentas y datos
  { seccion: 'Cuentas y datos', nombre: 'cuentas', alias: ['datosguardados'], ejemplo: '/cuentas', descripcion: 'Tus cuentas con vínculos, titulares, cuotas y totales', menu: 3, menuDescripcion: 'Mis cuentas, vínculos y datos guardados' },
  { seccion: 'Cuentas y datos', nombre: 'estadocuenta', alias: ['cartolas', 'historial'], uso: '[últimos 4 dígitos o titular]', ejemplo: '/estadocuenta 8263', descripcion: 'Revisar tus estados de cuenta guardados por año y mes, y descargar la cartola' },
  { seccion: 'Cuentas y datos', nombre: 'resetcuenta', alias: ['limpiarcuenta'], uso: '[últimos 4 dígitos] [mes 1 | enero 2026 | mes 1 a 3]', ejemplo: '/resetcuenta 8263 mes 1', descripcion: 'Borrar las importaciones (o todo) de una cuenta, o solo de un mes o rango, con respaldo y Deshacer' },
  { seccion: 'Cuentas y datos', nombre: 'savecard', alias: ['nuevacuenta'], uso: '<descripción>', ejemplo: '/savecard tarjeta débito FAN banco de chile terminada en 1234', descripcion: 'Crear una cuenta o tarjeta (con los últimos 4 dígitos)' },
  { seccion: 'Cuentas y datos', nombre: 'editarcuenta', alias: ['editartarjeta'], uso: '[últimos 4 dígitos]', ejemplo: '/editarcuenta 8263', descripcion: 'Editar una cuenta o tarjeta: nombre, tipo, banco, titular, dígitos, vínculo y predeterminada' },
  { seccion: 'Cuentas y datos', nombre: 'borrarcuenta', uso: '[número]', ejemplo: '/borrarcuenta 2', descripcion: 'Desactivar una cuenta (sus movimientos se conservan)' },
  { seccion: 'Cuentas y datos', nombre: 'savetrans', ejemplo: '/savetrans', descripcion: 'Guardar tus datos de transferencia (para que te depositen)' },
  { seccion: 'Cuentas y datos', nombre: 'misdatos', ejemplo: '/misdatos', descripcion: 'Ver tus datos de transferencia guardados' },
  { seccion: 'Cuentas y datos', nombre: 'datos', uso: '<alias o banco>', ejemplo: '/datos fan', descripcion: 'Pedir los datos de transferencia de una de tus cuentas' },
  { seccion: 'Cuentas y datos', nombre: 'borrardatos', uso: '[número]', ejemplo: '/borrardatos 1', descripcion: 'Desactivar datos de transferencia' },

  // Categorías y reglas
  { seccion: 'Categorías y reglas', nombre: 'categorias', ejemplo: '/categorias', descripcion: 'Ver las categorías' },
  { seccion: 'Categorías y reglas', nombre: 'categoria', uso: 'nueva <nombre>', ejemplo: '/categoria nueva Mascotas', descripcion: 'Crear una categoría' },
  { seccion: 'Categorías y reglas', nombre: 'regla', uso: '<texto> <categoría>', ejemplo: '/regla uber transporte', descripcion: 'Categorizar solo lo que contenga ese texto (sin argumentos: lista las reglas)' },

  // Sistema
  { seccion: 'Sistema', nombre: 'update', ejemplo: '/update', descripcion: 'Actualizar la app y reiniciarla (solo en el servidor)', menu: 6, menuDescripcion: 'Actualizar y reiniciar la app' },
  { seccion: 'Sistema', nombre: 'reboot', ejemplo: '/reboot', descripcion: 'Reiniciar la app (solo en el servidor)' },
  { seccion: 'Sistema', nombre: 'reset', ejemplo: '/reset', descripcion: 'Empezar de cero: respaldo, doble confirmación y opción de restaurar' }
];

/** Todos los nombres y alias (sin la barra) que el bot atiende */
export const COMANDOS_CONOCIDOS = new Set(COMANDOS.flatMap(c => [c.nombre, ...(c.alias ?? [])]));

/** El menú "/" de Telegram (setMyCommands): solo los marcados con `menu`, en el orden de la lista */
export const COMANDOS_MENU = COMANDOS.filter(c => c.menu).sort((a, b) => a.menu - b.menu)
  .map(c => ({ command: c.nombre, description: c.menuDescripcion ?? c.descripcion }));

/** Unos pocos ejemplos de frases naturales (lo principal de /help son los comandos de arriba) */
export const EJEMPLOS = [
  { titulo: 'Anotar un gasto', frase: 'almuerzo 5500 débito' },
  { titulo: 'Corregirlo (responde a su mensaje)', frase: 'eran 4690, o «elimina esto»' },
  { titulo: 'Guardar una tarjeta', frase: 'guarda la tarjeta crédito 8263 es de Valeska' },
  { titulo: 'Gasto fijo', frase: 'gasto fijo: 24 mil en telefonía, lo pago a Vivian' },
  { titulo: 'Revisar estados de cuenta', frase: 'estado de cuenta de la 8263, o «historial de la tarjeta de Valeska»' },
  { titulo: 'Cartolas (en el mismo mensaje o justo antes)', frase: 'son de la tarjeta 8263, o «cartola de la crédito de Valeska»' }
];

const LIMITE_MENSAJE = 3500;

/** "/cuentas (o /datosguardados) <uso> - descripción" */
export function lineaComando(c, esc = (t) => t) {
  const alias = (c.alias ?? []).map(a => `/${a}`).join(' o ');
  return `/${c.nombre}${alias ? ` (o ${alias})` : ''}${c.uso ? ` ${esc(c.uso)}` : ''} - ${esc(c.descripcion)}`;
}

/** La línea del comando y debajo "Ej: ..." (así se muestra en /help) */
export function entradaComando(c, esc = (t) => t) {
  return `${lineaComando(c, esc)}\nEj: ${esc(c.ejemplo)}`;
}

/**
 * La ayuda completa lista para enviar: la lista de todos los comandos por sección y, al final, los ejemplos. Si no cabe en un
 * mensaje de Telegram, se parte en varios (siempre entre líneas, nunca a la mitad de una).
 * `esc` escapa el texto para HTML; `saludo` es una primera línea opcional (para /start).
 */
export function mensajesAyuda(esc = (t) => t, { saludo = null } = {}) {
  // Cada bloque es un grupo de entradas que no se debe cortar a la mitad; una sección grande se parte entre entradas, nunca dentro de una
  const bloques = [];
  if (saludo) bloques.push([`${saludo}\n`]);
  bloques.push(['<b>Comandos</b> (también puedes escribirme como hablas)']);
  for (const seccion of SECCIONES) {
    const entradas = COMANDOS.filter(c => c.seccion === seccion).map(c => entradaComando(c, esc));
    if (entradas.length === 0) continue;
    bloques.push([`<b>${esc(seccion)}</b>`, ...entradas]);
  }
  bloques.push(['<b>Ejemplos de frases</b>', ...EJEMPLOS.map(e => `• ${esc(e.titulo)}: ${esc(e.frase)}`)]);

  const mensajes = [];
  let actual = '';
  const cerrar = () => {
    if (actual.trim()) mensajes.push(actual.trimEnd());
    actual = '';
  };
  for (const bloque of bloques) {
    const texto = `${bloque.join('\n')}\n`;
    if (actual && actual.length + texto.length + 1 > LIMITE_MENSAJE) cerrar();
    if (texto.length <= LIMITE_MENSAJE) {
      actual += `${texto}\n`;
      continue;
    }
    // Una sección que sola no cabe: se reparte por entradas, repitiendo su título en cada mensaje
    const [titulo, ...entradas] = bloque;
    let parcial = `${titulo}\n`;
    for (const entrada of entradas) {
      if (parcial.length + entrada.length + 1 > LIMITE_MENSAJE) {
        actual += parcial;
        cerrar();
        parcial = `${titulo} (cont.)\n`;
      }
      parcial += `${entrada}\n`;
    }
    actual += `${parcial}\n`;
  }
  cerrar();
  return mensajes;
}
