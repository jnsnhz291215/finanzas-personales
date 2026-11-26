/**
 * Botón "Cerrar" común: toda lista con botones de acción lo lleva al final. Un solo callback (`cerrar_x`) que solo quita el teclado del
 * mensaje; el texto queda como está (lo atiende procesarCallback en bot.js).
 */

export const CALLBACK_CERRAR = 'cerrar_x';

/** La fila con el botón Cerrar (para agregar al final de un teclado) */
export const botonCerrar = () => [{ text: 'Cerrar', callback_data: CALLBACK_CERRAR }];

/** Agrega la fila Cerrar al final de las filas de un teclado */
export const conCerrar = (filas = []) => [...filas, botonCerrar()];

/**
 * Texto de los botones de compras en cuotas: si dos compras activas se llaman igual, se distinguen con el valor de la cuota
 * ("Desactivar Apple ($21.749)") y, si también coincide, con su número. `etiqueta(c)` es el nombre base; `dinero` formatea el monto.
 */
export function nombresDistinguibles(compras, dinero) {
  const clave = (t) => String(t).trim().toLowerCase();
  const repetidos = new Map();
  for (const c of compras) repetidos.set(clave(c.alias), (repetidos.get(clave(c.alias)) ?? 0) + 1);

  const base = compras.map(c => {
    if ((repetidos.get(clave(c.alias)) ?? 0) < 2) return c.alias;
    // Si el nombre ya trae el valor de la cuota (los que crea la cartola, "Apple ($21.749)"), no se repite
    return String(c.alias).includes('$') ? c.alias : `${c.alias} (${dinero(c.monto_cuota)})`;
  });
  const vistos = new Map();
  for (const n of base) vistos.set(clave(n), (vistos.get(clave(n)) ?? 0) + 1);
  return compras.map((c, i) => ((vistos.get(clave(base[i])) ?? 0) > 1 ? `${base[i]} #${c.id}` : base[i]));
}
