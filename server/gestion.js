/**
 * Gestión de movimientos, categorías y reglas de autocategorización para el bot
 * (lo que antes solo se hacía en la web). La BD se importa de forma diferida para que
 * las funciones puras se puedan probar sin base de datos.
 */

import { resolverTipos, requiereDestino, sqlExcluirInternos } from './tiposMovimiento.js';

async function consulta() {
  return (await import('./db.js')).query;
}

function normalizar(texto) {
  return String(texto ?? '').normalize('NFC').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
}

// ---------------------------------------------------------------------------
// Búsqueda de movimientos
// ---------------------------------------------------------------------------

const MESES = {
  enero: 1, febrero: 2, marzo: 3, abril: 4, mayo: 5, junio: 6, julio: 7,
  agosto: 8, septiembre: 9, setiembre: 9, octubre: 10, noviembre: 11, diciembre: 12
};

function rangoMes(anio, mes) {
  const dias = new Date(Date.UTC(anio, mes, 0)).getUTCDate();
  const mm = String(mes).padStart(2, '0');
  return { desde: `${anio}-${mm}-01`, hasta: `${anio}-${mm}-${String(dias).padStart(2, '0')}` };
}

/**
 * Interpreta "uber", "noviembre", "uber noviembre 2026", "2026-11", "11/2026", "este mes" o
 * "mes pasado". Devuelve { texto, desde, hasta, etiquetaMes }: texto es lo que sobra para
 * buscar en la descripción; desde/hasta (YYYY-MM-DD) solo si se nombró un mes.
 * `hoy` es la fecha de hoy en Chile (YYYY-MM-DD).
 */
export function interpretarBusqueda(consultaTexto, hoy) {
  // original conserva tildes y mayúsculas (para buscar en la descripción); norm es la misma
  // cadena sin tildes (mismo largo) para reconocer meses y años. Lo reconocido se borra de ambas.
  let original = String(consultaTexto ?? '').normalize('NFC').trim();
  let norm = normalizar(original);
  if (norm.length !== original.length) norm = original.toLowerCase();

  const quitar = (m) => {
    const blanco = ' '.repeat(m[0].length);
    original = original.slice(0, m.index) + blanco + original.slice(m.index + m[0].length);
    norm = norm.slice(0, m.index) + blanco + norm.slice(m.index + m[0].length);
  };

  const [anioHoy, mesHoy] = hoy.split('-').map(Number);
  let anio = null;
  let mes = null;
  let m;

  if ((m = /\b(20\d{2})-(\d{1,2})\b/.exec(norm))) {
    anio = Number(m[1]);
    mes = Number(m[2]);
    quitar(m);
  } else if ((m = /\b(\d{1,2})[/-](20\d{2})\b/.exec(norm))) {
    mes = Number(m[1]);
    anio = Number(m[2]);
    quitar(m);
  } else if ((m = /\bmes\s+pasado\b/.exec(norm))) {
    mes = mesHoy === 1 ? 12 : mesHoy - 1;
    anio = mesHoy === 1 ? anioHoy - 1 : anioHoy;
    quitar(m);
  } else if ((m = /\b(?:este\s+mes|mes\s+actual)\b/.exec(norm))) {
    mes = mesHoy;
    anio = anioHoy;
    quitar(m);
  } else {
    for (const [nombre, numero] of Object.entries(MESES)) {
      const encontrado = new RegExp(`\\b${nombre}\\b`).exec(norm);
      if (encontrado) {
        mes = numero;
        quitar(encontrado);
        break;
      }
    }
    if (mes !== null) {
      const año = /\b(20\d{2})\b/.exec(norm);
      if (año) {
        anio = Number(año[1]);
        quitar(año);
      } else {
        // Sin año: el más reciente que no quede en el futuro
        anio = mes > mesHoy ? anioHoy - 1 : anioHoy;
      }
    }
  }

  const texto = original.replace(/\s+/g, ' ').trim();
  if (mes === null || mes < 1 || mes > 12) {
    return { texto: texto || null, desde: null, hasta: null, etiquetaMes: null };
  }
  return { texto: texto || null, ...rangoMes(anio, mes), etiquetaMes: `${String(mes).padStart(2, '0')}-${anio}` };
}

const SELECT_MOVIMIENTO = `
  SELECT m.id, m.fecha, m.descripcion, m.monto, m.tipo, m.tipo_movimiento,
         m.cuenta_id, m.cuenta_destino_id, m.categoria_id, m.es_prestamo, m.persona_prestamo,
         c.nombre AS cuenta_nombre, cd.nombre AS cuenta_destino_nombre, cat.nombre AS categoria_nombre
  FROM movimientos m
  LEFT JOIN cuentas c ON m.cuenta_id = c.id
  LEFT JOIN cuentas cd ON m.cuenta_destino_id = cd.id
  LEFT JOIN categorias cat ON m.categoria_id = cat.id`;

/** Cuentas activas con banco y tipo (para sugerir en qué cuenta importar una cartola) */
export async function listarCuentasConBanco() {
  const query = await consulta();
  const [filas] = await query(
    'SELECT id, nombre, banco, tipo, ultimos4, ultimos4_cuenta FROM cuentas WHERE activa = 1 ORDER BY nombre'
  );
  return filas;
}

/**
 * Guarda los últimos 4 dígitos de una tarjeta ('tarjeta' -> ultimos4) o de una cuenta
 * ('cuenta' -> ultimos4_cuenta) para reconocer la cuenta la próxima vez que llegue una cartola.
 * Solo acepta exactamente 4 dígitos. Devuelve true si guardó.
 */
export async function guardarDigitosCuenta(cuentaId, tipo, digitos) {
  const columna = tipo === 'cuenta' ? 'ultimos4_cuenta' : tipo === 'tarjeta' ? 'ultimos4' : null;
  if (!columna || !/^\d{4}$/.test(String(digitos))) return false;

  const query = await consulta();
  const [resultado] = await query(
    `UPDATE cuentas SET ${columna} = ?, actualizado_en = CURRENT_TIMESTAMP WHERE id = ? AND activa = 1`,
    [String(digitos), cuentaId]
  );
  return resultado.affectedRows > 0;
}

/** Cuentas activas (id y nombre) para elegir una en un botón */
export async function listarCuentasActivas() {
  const query = await consulta();
  const [filas] = await query('SELECT id, nombre FROM cuentas WHERE activa = 1 ORDER BY nombre');
  return filas;
}

export async function ultimosMovimientos(limite = 10) {
  const query = await consulta();
  const [filas] = await query(`${SELECT_MOVIMIENTO} ORDER BY m.fecha DESC, m.creado_en DESC LIMIT ?`, [limite]);
  return filas;
}

/**
 * Movimientos que calzan con la búsqueda (texto en la descripción y/o rango de fechas).
 * El texto se compara en JS sin tildes ni mayúsculas, porque LIKE de SQLite solo ignora
 * mayúsculas ASCII: se leen los 5.000 movimientos más recientes del rango y se filtra aquí.
 */
export async function buscarMovimientos({ texto, desde, hasta }, limite = 15) {
  const query = await consulta();
  const condiciones = [];
  const params = [];
  if (desde && hasta) {
    condiciones.push('m.fecha BETWEEN ? AND ?');
    params.push(desde, hasta);
  }
  const donde = condiciones.length > 0 ? `WHERE ${condiciones.join(' AND ')}` : '';
  const [filas] = await query(
    `${SELECT_MOVIMIENTO} ${donde} ORDER BY m.fecha DESC, m.creado_en DESC LIMIT ?`,
    [...params, texto ? 5000 : limite]
  );
  if (!texto) return filas;

  const buscado = normalizar(texto);
  return filas.filter(f => normalizar(f.descripcion).includes(buscado)).slice(0, limite);
}

export async function obtenerMovimiento(id) {
  const query = await consulta();
  const [filas] = await query(`${SELECT_MOVIMIENTO} WHERE m.id = ?`, [id]);
  return filas[0] ?? null;
}

/**
 * Actualiza campos de un movimiento. Si cambia tipo_movimiento, el sentido (cargo/abono) se
 * recalcula y la cuenta destino se limpia cuando el tipo ya no la usa. Devuelve un error de
 * texto si el cambio no es válido (por ejemplo, un pago de tarjeta sin cuenta destino).
 */
export async function actualizarMovimiento(id, cambios) {
  const query = await consulta();
  const actual = await obtenerMovimiento(id);
  if (!actual) return { ok: false, error: 'El movimiento ya no existe' };

  const nuevo = {
    monto: actual.monto,
    fecha: actual.fecha,
    categoria_id: actual.categoria_id,
    cuenta_id: actual.cuenta_id,
    cuenta_destino_id: actual.cuenta_destino_id,
    tipo: actual.tipo,
    tipo_movimiento: actual.tipo_movimiento,
    es_prestamo: actual.es_prestamo,
    persona_prestamo: actual.persona_prestamo,
    ...cambios
  };

  if (cambios.tipo_movimiento !== undefined) {
    const tipos = resolverTipos({ tipo: actual.tipo, tipo_movimiento: cambios.tipo_movimiento });
    nuevo.tipo = tipos.tipo;
    nuevo.tipo_movimiento = tipos.tipo_movimiento;
  }
  if (!requiereDestino(nuevo.tipo_movimiento)) {
    nuevo.cuenta_destino_id = null;
  } else if (!nuevo.cuenta_destino_id) {
    return { ok: false, error: 'Este tipo necesita una cuenta destino' };
  } else if (Number(nuevo.cuenta_destino_id) === Number(nuevo.cuenta_id)) {
    return { ok: false, error: 'La cuenta destino debe ser distinta de la cuenta origen' };
  }

  const monto = Number(nuevo.monto);
  if (!Number.isFinite(monto) || monto <= 0) return { ok: false, error: 'El monto debe ser mayor que 0' };

  // La fecha solo cambia si se pidió; debe ser YYYY-MM-DD
  let fecha = null;
  if (cambios.fecha !== undefined) {
    fecha = String(cambios.fecha).slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(fecha) || Number.isNaN(Date.parse(`${fecha}T00:00:00Z`))) {
      return { ok: false, error: 'La fecha no es válida' };
    }
  }

  // Un préstamo necesita la persona; sin préstamo no se guarda persona
  const esPrestamo = Number(nuevo.es_prestamo) === 1 || nuevo.es_prestamo === true;
  const persona = esPrestamo ? String(nuevo.persona_prestamo ?? '').trim() : '';
  if (esPrestamo && !persona) return { ok: false, error: 'Indica la persona del préstamo' };

  await query(
    `UPDATE movimientos
     SET monto = ?, categoria_id = ?, cuenta_id = ?, cuenta_destino_id = ?, tipo = ?, tipo_movimiento = ?,
         es_prestamo = ?, persona_prestamo = ?, fecha = COALESCE(?, fecha)
     WHERE id = ?`,
    [
      monto, nuevo.categoria_id ?? null, nuevo.cuenta_id, nuevo.cuenta_destino_id ?? null,
      nuevo.tipo, nuevo.tipo_movimiento, esPrestamo ? 1 : 0, persona || null, fecha, id
    ]
  );
  return { ok: true, movimiento: await obtenerMovimiento(id) };
}

/** Elimina un movimiento (igual que la web; el bot pide confirmación antes) */
export async function borrarMovimiento(id) {
  const query = await consulta();
  const [resultado] = await query('DELETE FROM movimientos WHERE id = ?', [id]);
  return resultado.affectedRows > 0;
}

// ---------------------------------------------------------------------------
// Gastos del mes y uso de cupo (mismos criterios que el dashboard)
// ---------------------------------------------------------------------------

/**
 * Gastos del mes de `hoy` por categoría (cargos sin pagos de tarjeta ni transferencias
 * propias) y uso de cupo de cada tarjeta de crédito activa: cargos del mes menos los pagos
 * recibidos, sin bajar de 0. Devuelve { anio, mes, total, categorias, tarjetas }.
 */
export async function gastosDelMes(hoy) {
  const [anio, mes] = hoy.split('-').map(Number);
  const { desde, hasta } = rangoMes(anio, mes);
  const query = await consulta();
  const interno = sqlExcluirInternos('m.');

  const [filas] = await query(
    `SELECT cat.nombre AS categoria, SUM(m.monto) AS total
     FROM movimientos m
     LEFT JOIN categorias cat ON m.categoria_id = cat.id
     WHERE m.tipo = 'cargo' AND ${interno} AND m.fecha BETWEEN ? AND ?
     GROUP BY cat.id, cat.nombre
     ORDER BY total DESC`,
    [desde, hasta]
  );
  const categorias = filas.map(f => ({ categoria: f.categoria ?? 'Sin categoría', total: Number(f.total) }));
  const total = categorias.reduce((suma, c) => suma + c.total, 0);

  const [cuentas] = await query(
    "SELECT id, nombre, cupo_total FROM cuentas WHERE tipo = 'tarjeta_credito' AND activa = 1 ORDER BY nombre"
  );
  const tarjetas = [];
  for (const t of cuentas) {
    const [uso] = await query(
      `SELECT COALESCE(SUM(m.monto), 0) AS total FROM movimientos m
       WHERE m.cuenta_id = ? AND m.tipo = 'cargo' AND ${interno} AND m.fecha BETWEEN ? AND ?`,
      [t.id, desde, hasta]
    );
    const [pagos] = await query(
      `SELECT COALESCE(SUM(m.monto), 0) AS total FROM movimientos m
       WHERE m.cuenta_destino_id = ? AND m.tipo_movimiento = 'pago_tarjeta' AND m.fecha BETWEEN ? AND ?`,
      [t.id, desde, hasta]
    );
    const usado = Math.max(0, Number(uso[0].total) - Number(pagos[0].total));
    const cupo = t.cupo_total === null || t.cupo_total === undefined ? null : Number(t.cupo_total);
    tarjetas.push({
      nombre: t.nombre,
      usado,
      cupo,
      disponible: cupo === null ? null : cupo - usado,
      porcentaje: cupo ? Math.round(usado / cupo * 100) : null
    });
  }

  return { anio, mes, total, categorias, tarjetas };
}

// ---------------------------------------------------------------------------
// Categorías y reglas de autocategorización
// ---------------------------------------------------------------------------

export async function listarCategorias() {
  const query = await consulta();
  const [filas] = await query('SELECT id, nombre FROM categorias ORDER BY nombre');
  return filas;
}

/** Crea una categoría (mismos valores por defecto que la web). Devuelve { ok, categoria|error } */
export async function crearCategoria(nombre) {
  const limpio = String(nombre ?? '').replace(/\s+/g, ' ').trim();
  if (!limpio || limpio.length > 100) return { ok: false, error: 'El nombre es obligatorio (hasta 100 caracteres)' };

  const existentes = await listarCategorias();
  const repetida = existentes.find(c => normalizar(c.nombre) === normalizar(limpio));
  if (repetida) return { ok: false, error: `Ya existe la categoría ${repetida.nombre}`, existente: repetida };

  const query = await consulta();
  const [resultado] = await query(
    'INSERT INTO categorias (nombre, color, icono) VALUES (?, ?, ?)',
    [limpio, '#6B7280', 'fa-folder']
  );
  return { ok: true, categoria: { id: resultado.insertId, nombre: limpio } };
}

/**
 * Separa "uber transporte" en texto y categoría: la categoría es lo que queda al final y
 * coincide con una existente (sin tildes ni mayúsculas, o prefijo único del nombre).
 * Devuelve { texto, categoria } (categoria null si no hay coincidencia).
 */
export function separarReglaYCategoria(argumento, categorias) {
  const palabras = String(argumento ?? '').trim().split(/\s+/).filter(Boolean);
  for (let largo = Math.min(4, palabras.length - 1); largo >= 1; largo--) {
    const candidata = normalizar(palabras.slice(-largo).join(' '));
    const exacta = categorias.filter(c => normalizar(c.nombre) === candidata);
    const porPrefijo = categorias.filter(c => normalizar(c.nombre).startsWith(candidata));
    const elegida = exacta.length === 1 ? exacta[0] : (exacta.length === 0 && porPrefijo.length === 1 ? porPrefijo[0] : null);
    if (elegida) {
      return { texto: palabras.slice(0, -largo).join(' '), categoria: elegida };
    }
  }
  return { texto: palabras.join(' '), categoria: null };
}

export async function listarReglas() {
  const query = await consulta();
  const [filas] = await query(`
    SELECT r.id, r.texto_buscar, r.categoria_id, c.nombre AS categoria_nombre
    FROM reglas_categoria r
    JOIN categorias c ON r.categoria_id = c.id
    WHERE r.activa = 1
    ORDER BY r.creado_en DESC`);
  return filas;
}

/** Crea una regla (misma tabla que usa la web y las cartolas). Devuelve { ok, id|error } */
export async function crearRegla(texto, categoriaId) {
  const buscado = String(texto ?? '').replace(/\s+/g, ' ').trim().toLowerCase();
  if (!buscado || buscado.length > 255) return { ok: false, error: 'El texto de la regla es obligatorio' };

  const reglas = await listarReglas();
  const repetida = reglas.find(r => normalizar(r.texto_buscar) === normalizar(buscado));
  if (repetida) {
    return { ok: false, error: `Ya existe una regla para "${repetida.texto_buscar}" (${repetida.categoria_nombre})` };
  }

  const query = await consulta();
  const [resultado] = await query(
    'INSERT INTO reglas_categoria (texto_buscar, categoria_id) VALUES (?, ?)',
    [buscado, categoriaId]
  );
  return { ok: true, id: resultado.insertId };
}

export async function borrarRegla(id) {
  const query = await consulta();
  const [resultado] = await query('DELETE FROM reglas_categoria WHERE id = ?', [id]);
  return resultado.affectedRows > 0;
}

/**
 * Categoría según las reglas activas: la primera regla cuyo texto aparece en el mensaje
 * (misma comparación que la autocategorización de movimientos y cartolas: contiene, en
 * minúsculas). Devuelve { id, nombre } o null.
 */
export async function categoriaPorReglas(texto) {
  const buscado = String(texto ?? '').toLowerCase();
  if (!buscado) return null;
  const reglas = await listarReglas();
  const regla = reglas.find(r => buscado.includes(String(r.texto_buscar).toLowerCase()));
  return regla ? { id: regla.categoria_id, nombre: regla.categoria_nombre } : null;
}
