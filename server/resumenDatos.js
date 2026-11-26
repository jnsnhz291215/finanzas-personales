/**
 * Lo que la app tiene registrado, para la vista de /cuentas: cuentas con sus vínculos (tarjeta y
 * número de cuenta, titular), cuotas activas, categorías en uso y totales de movimientos.
 *
 * Privacidad: solo se devuelven los 4 últimos dígitos. Si en cuentas.numero_cuenta quedó un número
 * completo guardado, NO se devuelve (solo la marca `numeroCompleto`) para que la vista avise.
 *
 * La BD se importa de forma diferida para poder probar las funciones puras sin base de datos.
 */

import { listarCompras, resumenMensualPorTitular } from './cuotas.js';
import { fechaHoySantiago } from './telegram/fechas.js';
import { guardarDigitosCuenta } from './gestion.js';

async function consulta() {
  return (await import('./db.js')).query;
}

/** Cantidad de dígitos de un texto (para detectar números completos guardados) */
export function cantidadDigitos(texto) {
  return String(texto ?? '').replace(/\D/g, '').length;
}

/** Fila de cuentas -> objeto seguro: sin numero_cuenta y con las marcas de lo que hay que avisar */
export function cuentaSegura(fila) {
  const t = (v) => (v === null || v === undefined || String(v).trim() === '' ? null : String(v).trim());
  const tarjeta = t(fila.ultimos4);
  const cuenta = t(fila.ultimos4_cuenta);
  return {
    id: Number(fila.id),
    nombre: String(fila.nombre),
    banco: t(fila.banco),
    tipo: fila.tipo,
    titular: t(fila.titular),
    activa: Number(fila.activa) === 1,
    // Solo se aceptan exactamente 4 dígitos; cualquier otra cosa no se muestra
    ultimos4: tarjeta && /^\d{4}$/.test(tarjeta) ? tarjeta : null,
    ultimos4_cuenta: cuenta && /^\d{4}$/.test(cuenta) ? cuenta : null,
    digitosInvalidos: Boolean((tarjeta && !/^\d{4}$/.test(tarjeta)) || (cuenta && !/^\d{4}$/.test(cuenta))),
    numeroCompleto: cantidadDigitos(fila.numero_cuenta) > 4
  };
}

/** Todo lo que se muestra en /cuentas */
export async function cargarResumen() {
  const query = await consulta();

  const [filas] = await query(
    'SELECT id, nombre, banco, tipo, ultimos4, ultimos4_cuenta, titular, activa, numero_cuenta FROM cuentas ORDER BY activa DESC, nombre'
  );
  const [movs] = await query('SELECT cuenta_id, COUNT(*) AS n FROM movimientos GROUP BY cuenta_id');
  const [cartolas] = await query('SELECT cuenta_id, COUNT(*) AS n FROM archivos_importados GROUP BY cuenta_id');
  const contar = (lista) => new Map(lista.map(f => [Number(f.cuenta_id), Number(f.n)]));
  const porMov = contar(movs);
  const porCartola = contar(cartolas);

  const cuentas = filas.map(f => {
    const c = cuentaSegura(f);
    return { ...c, movimientos: porMov.get(c.id) ?? 0, cartolas: porCartola.get(c.id) ?? 0 };
  });

  const [cats] = await query(
    'SELECT DISTINCT c.nombre FROM movimientos m JOIN categorias c ON c.id = m.categoria_id ORDER BY c.nombre'
  );
  const [tot] = await query('SELECT COUNT(*) AS n, MIN(fecha) AS primero, MAX(fecha) AS ultimo FROM movimientos');

  return {
    cuentas,
    cuotas: await listarCompras(),
    titularesMes: await resumenMensualPorTitular(fechaHoySantiago()),
    categorias: cats.map(c => c.nombre),
    totales: {
      movimientos: Number(tot[0]?.n ?? 0),
      primero: tot[0]?.primero ? String(tot[0].primero).slice(0, 10) : null,
      ultimo: tot[0]?.ultimo ? String(tot[0].ultimo).slice(0, 10) : null
    }
  };
}

/** Cambia el titular de una cuenta activa. true si la cuenta existía. */
export async function fijarTitular(cuentaId, titular) {
  const query = await consulta();
  const [r] = await query(
    'UPDATE cuentas SET titular = ?, actualizado_en = CURRENT_TIMESTAMP WHERE id = ? AND activa = 1',
    [String(titular).slice(0, 150), cuentaId]
  );
  return r.affectedRows > 0;
}

/** Guarda los 4 últimos dígitos de la tarjeta ('tarjeta') o de la cuenta ('cuenta') de una cuenta */
export async function fijarDigitos(cuentaId, tipo, digitos) {
  return guardarDigitosCuenta(cuentaId, tipo, digitos);
}
