/**
 * Deudas con abonos libres: lo que TÚ le debes a una persona (por ejemplo a tu mamá) y pagas en abonos de cualquier monto, sin cuotas fijas.
 *
 *   deudas(id, acreedor, descripcion, alias, monto_total, fecha_inicio, activa)
 *   abonos(id, deuda_id, movimiento_id, monto, fecha, archivo)
 *
 * No existía algo equivalente: deudas.js / pagos_prestamos manejan lo que otros te deben a ti (préstamos), y compras_cuotas las compras con
 * cuotas fijas. Esto es la dirección contraria y con abonos libres.
 *
 * Regla: la transferencia es el gasto (un movimiento normal) y el abono solo la vincula a la deuda (movimiento_id). Nada aquí crea ni cambia
 * movimientos, así que /plan y los gastos no cuentan dos veces.
 */

async function consulta() {
  return (await import('./db.js')).query;
}

const sinTildes = (t) => String(t ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();

// Sinónimos de personas cercanas: "mamá", "mi mamá", "mama", "madre" son la misma persona
const SINONIMOS = [
  { nombre: 'Mamá', patron: /^(?:mi\s+)?(?:mama|mami|madre|vieja)$/ },
  { nombre: 'Papá', patron: /^(?:mi\s+)?(?:papa|papi|padre|viejo)$/ },
  { nombre: 'Hermano', patron: /^(?:mi\s+)?hermano$/ },
  { nombre: 'Hermana', patron: /^(?:mi\s+)?hermana$/ },
  { nombre: 'Tía', patron: /^(?:mi\s+)?tia$/ },
  { nombre: 'Tío', patron: /^(?:mi\s+)?tio$/ },
  { nombre: 'Abuela', patron: /^(?:mi\s+)?(?:abuela|abuelita)$/ },
  { nombre: 'Abuelo', patron: /^(?:mi\s+)?(?:abuelo|abuelito)$/ }
];

/** "mi mamá" -> "Mamá"; otro nombre -> con mayúscula inicial en cada palabra, sin el "mi" */
export function nombreDePersona(texto) {
  const limpio = String(texto ?? '').replace(/\s+/g, ' ').replace(/[.,;:!?]+$/g, '').trim();
  const clave = sinTildes(limpio);
  const sin = SINONIMOS.find(s => s.patron.test(clave));
  if (sin) return sin.nombre;
  const sinMi = limpio.replace(/^mi\s+/i, '');
  return sinMi.split(' ').map(p => (p ? p[0].toUpperCase() + p.slice(1) : p)).join(' ');
}

function normalizarFila(f) {
  return { ...f, id: Number(f.id), monto_total: Number(f.monto_total), activa: Number(f.activa) === 1 };
}

/** Deudas con lo abonado, lo pendiente y el último abono: [{ id, acreedor, descripcion, alias, monto_total, abonado, pendiente, ultimoAbono, activa }] */
export async function listarDeudas({ incluirCerradas = false } = {}) {
  const query = await consulta();
  const [filas] = await query(
    `SELECT d.id, d.acreedor, d.descripcion, d.alias, d.monto_total, d.fecha_inicio, d.activa,
            COALESCE((SELECT SUM(a.monto) FROM abonos a WHERE a.deuda_id = d.id), 0) AS abonado,
            (SELECT MAX(a.fecha) FROM abonos a WHERE a.deuda_id = d.id) AS ultimo_abono
     FROM deudas d ${incluirCerradas ? '' : 'WHERE d.activa = 1'} ORDER BY d.acreedor, d.id`
  );
  return filas.map(f => {
    const d = normalizarFila(f);
    const abonado = Number(f.abonado) || 0;
    return { ...d, abonado, pendiente: Math.max(0, d.monto_total - abonado), ultimoAbono: f.ultimo_abono ? String(f.ultimo_abono).slice(0, 10) : null };
  });
}

export async function obtenerDeuda(id) {
  return (await listarDeudas({ incluirCerradas: true })).find(d => d.id === Number(id)) ?? null;
}

/** La deuda activa de una persona (por su nombre o alias); null si no hay. Con varias, la primera. */
export async function buscarDeudaDePersona(persona) {
  const buscada = sinTildes(nombreDePersona(persona));
  const deudas = await listarDeudas();
  return deudas.find(d => sinTildes(d.acreedor) === buscada || String(d.alias ?? '').split(',').some(a => sinTildes(nombreDePersona(a)) === buscada)) ?? null;
}

export async function crearDeuda({ acreedor, montoTotal, descripcion = null, fecha = null }) {
  const nombre = nombreDePersona(acreedor);
  const total = Math.round(Number(montoTotal));
  if (!nombre || nombre.length > 100) return { ok: false, error: 'Falta la persona a quien se le debe' };
  if (!Number.isFinite(total) || total <= 0) return { ok: false, error: 'El monto de la deuda debe ser mayor que 0' };
  const query = await consulta();
  const [r] = await query(
    'INSERT INTO deudas (acreedor, descripcion, monto_total, fecha_inicio) VALUES (?, ?, ?, ?)',
    [nombre, descripcion, total, fecha]
  );
  return { ok: true, id: Number(r.insertId), acreedor: nombre };
}

/**
 * Registra un abono ligado al movimiento de la transferencia (si ya se registró). No crea ningún movimiento: la transferencia es el gasto.
 * Un mismo movimiento no se abona dos veces.
 */
export async function registrarAbono({ deudaId, movimientoId = null, monto, fecha, archivo = null }) {
  const valor = Math.round(Number(monto));
  if (!Number.isFinite(valor) || valor <= 0) return { ok: false, error: 'El abono debe ser mayor que 0' };
  const query = await consulta();
  if (movimientoId) {
    const [previos] = await query('SELECT id FROM abonos WHERE movimiento_id = ?', [movimientoId]);
    if (previos.length > 0) return { ok: false, error: 'Esa transferencia ya está abonada a una deuda' };
  }
  const [r] = await query(
    'INSERT INTO abonos (deuda_id, movimiento_id, monto, fecha, archivo) VALUES (?, ?, ?, ?, ?)',
    [deudaId, movimientoId, valor, fecha, archivo]
  );
  return { ok: true, id: Number(r.insertId) };
}

export async function listarAbonos(deudaId) {
  const query = await consulta();
  const [filas] = await query('SELECT id, movimiento_id, monto, fecha, archivo FROM abonos WHERE deuda_id = ? ORDER BY fecha DESC, id DESC', [deudaId]);
  return filas.map(a => ({ ...a, id: Number(a.id), monto: Number(a.monto), fecha: String(a.fecha).slice(0, 10), conArchivo: Boolean(a.archivo) }));
}

/** Cambia el nombre con que se muestra la deuda (descripcion) */
export async function renombrarDeuda(id, nombre) {
  const query = await consulta();
  const [r] = await query('UPDATE deudas SET descripcion = ? WHERE id = ?', [String(nombre ?? '').replace(/\s+/g, ' ').trim().slice(0, 200) || null, id]);
  return Number(r.affectedRows ?? 0) > 0;
}

/** Otro nombre con que llamas a la persona ("Mamá Rosa"); se guardan varios separados por coma */
export async function agregarAliasDeuda(id, alias) {
  const deuda = await obtenerDeuda(id);
  if (!deuda) return false;
  const lista = [...new Set([...String(deuda.alias ?? '').split(','), nombreDePersona(alias)].map(a => a.trim()).filter(Boolean))];
  const query = await consulta();
  const [r] = await query('UPDATE deudas SET alias = ? WHERE id = ?', [lista.join(',').slice(0, 200), id]);
  return Number(r.affectedRows ?? 0) > 0;
}

/** Cierra la deuda (activa = 0): deja de aparecer en /deudas, los abonos se conservan */
export async function cerrarDeuda(id) {
  const query = await consulta();
  const [r] = await query('UPDATE deudas SET activa = 0 WHERE id = ? AND activa = 1', [id]);
  return Number(r.affectedRows ?? 0) > 0;
}

/**
 * Transferencias a terceros que todavía no se abonaron a ninguna deuda, del monto dado y de los últimos días (para ligar un abono a una
 * transferencia que ya está registrada, por ejemplo la que vino de la cartola, en vez de duplicarla).
 */
export async function transferenciasSinAbonar({ monto, persona, dias = 30, hoy }) {
  const query = await consulta();
  const [filas] = await query(
    `SELECT m.id, m.fecha, m.descripcion, m.monto FROM movimientos m
     WHERE m.tipo_movimiento = 'transferencia_terceros' AND m.tipo = 'cargo' AND ABS(m.monto - ?) < 1
       AND m.fecha >= ? AND NOT EXISTS (SELECT 1 FROM abonos a WHERE a.movimiento_id = m.id)
     ORDER BY m.fecha DESC, m.id DESC LIMIT 10`,
    [monto, restarDias(hoy, dias)]
  );
  const buscada = sinTildes(persona);
  return filas
    .filter(f => !persona || sinTildes(f.descripcion).includes(buscada))
    .map(f => ({ id: Number(f.id), fecha: String(f.fecha).slice(0, 10), descripcion: f.descripcion, monto: Number(f.monto) }));
}

function restarDias(fecha, dias) {
  const d = new Date(`${String(fecha).slice(0, 10)}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() - dias);
  return d.toISOString().slice(0, 10);
}
