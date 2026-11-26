/**
 * Editar una cuenta o tarjeta ya guardada, un campo a la vez: nombre, tipo, banco, titular, últimos 4 dígitos de la tarjeta,
 * últimos 4 del número de cuenta vinculada y si es la predeterminada. Aquí está la validación (funciones puras) y los datos;
 * los botones y las frases están en editarCuentaBot.js y vistaCuentasBot.js.
 *
 * Privacidad: solo se aceptan exactamente 4 dígitos; un número más largo se rechaza y nunca se guarda ni se repite.
 * La BD se importa de forma diferida para poder probar la validación sin base de datos.
 */

import {
  TIPO_DB,
  ETIQUETAS_TIPO_DB,
  esNombreSoloDigitos,
  capitalizarNombre,
  valorTitular,
  buscarBanco,
  normalizar
} from './telegram/cuentas.js';

async function consulta() {
  return (await import('./db.js')).query;
}

export const TIPOS_DB = Object.values(TIPO_DB);

/** Campos que se pueden editar: columna de la tabla, etiqueta para mostrar y código corto para los botones */
export const CAMPOS = {
  nombre: { columna: 'nombre', etiqueta: 'Nombre', codigo: 'n' },
  tipo: { columna: 'tipo', etiqueta: 'Tipo', codigo: 't' },
  banco: { columna: 'banco', etiqueta: 'Banco', codigo: 'b' },
  titular: { columna: 'titular', etiqueta: 'Titular', codigo: 'm' },
  ultimos4: { columna: 'ultimos4', etiqueta: 'Últimos 4 dígitos', codigo: 'd' },
  cuenta: { columna: 'ultimos4_cuenta', etiqueta: 'Cuenta vinculada', codigo: 'v' },
  predeterminada: { columna: 'predeterminada', etiqueta: 'Predeterminada', codigo: 'p' }
};

export const CAMPO_POR_CODIGO = Object.fromEntries(Object.entries(CAMPOS).map(([campo, c]) => [c.codigo, campo]));

const VACIAR = /^(?:quitar|quita|borrar|borra|ninguno|ninguna|sin|vacio|vacío)$/i;

/** "nombre · tipo · ****1234 · titular" (cada cuenta en la lista de /editarcuenta) */
export function etiquetaCuenta(c) {
  const digitos = c.ultimos4 || c.ultimos4_cuenta;
  return [
    c.nombre,
    ETIQUETAS_TIPO_DB[c.tipo] ?? c.tipo,
    digitos ? `****${digitos}` : 'sin dígitos',
    c.titular || 'sin titular'
  ].join(' · ');
}

/** Los 4 dígitos de un texto: { digitos } o { error } si no son exactamente 4 */
export function leerCuatroDigitos(texto) {
  const limpio = String(texto ?? '').trim().replace(/[\s.-]/g, '').replace(/^\*+/, '');
  if (/^\d{4}$/.test(limpio)) return { digitos: limpio };
  if (/^\d{5,}$/.test(limpio)) return { error: 'Solo necesito los 4 últimos dígitos, nunca el número completo.', largo: true };
  return { error: 'Escribe exactamente 4 dígitos (por ejemplo 8263).' };
}

/**
 * Valida el nuevo valor de un campo. `cuenta` es la que se edita; `otras`, las demás cuentas activas (para que no queden dos
 * con los mismos 4 dígitos y el mismo tipo). Devuelve { ok: true, valor, texto } (texto: cómo mostrar el valor nuevo) o
 * { ok: false, error, largo? }.
 */
export function validarEdicion(cuenta, campo, entrada, otras = []) {
  const otrasActivas = otras.filter(o => Number(o.id) !== Number(cuenta.id) && (o.activa === undefined || o.activa === true || Number(o.activa) === 1));
  const texto = typeof entrada === 'string' ? entrada.trim() : entrada;

  switch (campo) {
    case 'nombre': {
      const nombre = String(texto ?? '').replace(/\s+/g, ' ').trim();
      if (!nombre) return { ok: false, error: 'El nombre no puede quedar vacío.' };
      if (esNombreSoloDigitos(nombre)) return { ok: false, error: 'El nombre no puede ser solo números (eso es el número de la tarjeta). Prueba con algo como «Crédito Valeska».' };
      if (nombre.length > 100) return { ok: false, error: 'El nombre es muy largo (máximo 100 caracteres).' };
      return { ok: true, valor: nombre, texto: nombre };
    }

    case 'tipo': {
      const tipo = TIPOS_DB.includes(texto) ? texto : TIPO_DB[texto];
      if (!tipo) return { ok: false, error: 'Ese tipo no existe.' };
      // Al cambiar el tipo no pueden quedar dos cuentas con los mismos 4 dígitos y el mismo tipo
      for (const col of ['ultimos4', 'ultimos4_cuenta']) {
        if (cuenta[col] && otrasActivas.some(o => o.tipo === tipo && o[col] === cuenta[col])) {
          return { ok: false, error: `Ya hay otra cuenta de tipo «${ETIQUETAS_TIPO_DB[tipo]}» con los dígitos ${cuenta[col]}.` };
        }
      }
      return { ok: true, valor: tipo, texto: ETIQUETAS_TIPO_DB[tipo] };
    }

    case 'banco': {
      const t = String(texto ?? '').trim();
      if (VACIAR.test(t)) return { ok: true, valor: null, texto: 'sin banco' };
      if (!t || t.length > 60) return { ok: false, error: 'Escribe el nombre del banco (por ejemplo Banco de Chile).' };
      const banco = buscarBanco(normalizar(t));
      const nombre = banco ? banco.nombre : capitalizarNombre(t.replace(/^banco\s+(?:de\s+)?/i, 'Banco ').slice(0, 60));
      return { ok: true, valor: nombre, texto: nombre };
    }

    case 'titular': {
      const t = String(texto ?? '').trim();
      if (VACIAR.test(t)) return { ok: true, valor: null, texto: 'sin titular' };
      if (!t || /\d/.test(t) || t.length > 150) return { ok: false, error: 'Escribe el nombre del titular, sin números (o «yo» para ti).' };
      const titular = valorTitular(t);
      return { ok: true, valor: titular, texto: titular };
    }

    case 'ultimos4':
    case 'cuenta': {
      const columna = CAMPOS[campo].columna;
      const t = String(texto ?? '').trim();
      if (campo === 'cuenta' && VACIAR.test(t)) return { ok: true, valor: null, texto: 'sin cuenta vinculada' };
      const d = leerCuatroDigitos(t);
      if (d.error) return { ok: false, error: d.error, largo: d.largo };
      const repetida = otrasActivas.find(o => o.tipo === cuenta.tipo && o[columna] === d.digitos);
      if (repetida) {
        return { ok: false, error: `Ya existe «${repetida.nombre}» con esos 4 dígitos y el mismo tipo (${ETIQUETAS_TIPO_DB[cuenta.tipo] ?? cuenta.tipo}).` };
      }
      return { ok: true, valor: d.digitos, texto: `****${d.digitos}` };
    }

    case 'predeterminada': {
      const si = entrada === true || entrada === 1 || entrada === '1' || /^(?:si|sí|true)$/i.test(String(entrada));
      return { ok: true, valor: si, texto: si ? 'sí' : 'no' };
    }

    default:
      return { ok: false, error: 'Ese campo no se puede editar.' };
  }
}

/** Valor actual de un campo, para mostrar (antes → después) */
export function valorActual(cuenta, campo) {
  switch (campo) {
    case 'nombre': return cuenta.nombre;
    case 'tipo': return ETIQUETAS_TIPO_DB[cuenta.tipo] ?? cuenta.tipo;
    case 'banco': return cuenta.banco || 'sin banco';
    case 'titular': return cuenta.titular || 'sin titular';
    case 'ultimos4': return cuenta.ultimos4 ? `****${cuenta.ultimos4}` : 'sin dígitos';
    case 'cuenta': return cuenta.ultimos4_cuenta ? `****${cuenta.ultimos4_cuenta}` : 'sin cuenta vinculada';
    case 'predeterminada': return Number(cuenta.predeterminada) === 1 ? 'sí' : 'no';
    default: return '';
  }
}

// ---------------------------------------------------------------------------
// Datos
// ---------------------------------------------------------------------------

const COLUMNAS = 'id, nombre, tipo, banco, titular, ultimos4, ultimos4_cuenta, activa, predeterminada';

/** Cuentas activas con lo necesario para editar y para validar duplicados */
export async function cuentasEditables() {
  const query = await consulta();
  const [filas] = await query(`SELECT ${COLUMNAS} FROM cuentas WHERE activa = 1 ORDER BY nombre`);
  return filas.map(f => ({ ...f, id: Number(f.id), activa: Number(f.activa) === 1, predeterminada: Number(f.predeterminada) === 1 ? 1 : 0 }));
}

export async function obtenerCuentaEditable(id) {
  return (await cuentasEditables()).find(c => c.id === Number(id)) ?? null;
}

/** Cuentas activas que tienen esos 4 dígitos (de la tarjeta o de la cuenta vinculada) */
export async function cuentasPorDigitos(digitos) {
  return (await cuentasEditables()).filter(c => c.ultimos4 === digitos || c.ultimos4_cuenta === digitos);
}

/**
 * Guarda un campo (ya validado con validarEdicion). Como máximo una cuenta es la predeterminada: al marcar una, las demás
 * dejan de serlo. true si la cuenta existía y estaba activa.
 */
export async function aplicarEdicion(cuentaId, campo, valor) {
  const info = CAMPOS[campo];
  if (!info) return false;
  const query = await consulta();

  if (campo === 'predeterminada') {
    if (valor) await query('UPDATE cuentas SET predeterminada = 0 WHERE predeterminada <> 0');
    const [r] = await query('UPDATE cuentas SET predeterminada = ? WHERE id = ? AND activa = 1', [valor ? 1 : 0, cuentaId]);
    return r.affectedRows > 0;
  }

  const [r] = await query(
    `UPDATE cuentas SET ${info.columna} = ?, actualizado_en = CURRENT_TIMESTAMP WHERE id = ? AND activa = 1`,
    [valor, cuentaId]
  );
  return r.affectedRows > 0;
}
