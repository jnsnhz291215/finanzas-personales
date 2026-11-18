/**
 * Préstamos y deudas: lo que otras personas te deben (movimientos marcados como préstamo)
 * menos los pagos registrados. Lo usan la API (routes/prestamos.js) y el bot.
 */

async function consulta() {
  return (await import('./db.js')).query;
}

/**
 * Resumen por persona: { persona, movimientos, pagos, saldo }. saldo > 0 significa que esa
 * persona te debe; saldo < 0, que le debes tú.
 */
export async function resumenDeudas() {
  const query = await consulta();

  const [movimientos] = await query(`
    SELECT
      persona_prestamo,
      SUM(CASE WHEN tipo = 'cargo' THEN monto ELSE -monto END) as saldo_movimientos
    FROM movimientos
    WHERE es_prestamo = true AND persona_prestamo IS NOT NULL
    GROUP BY persona_prestamo
  `);

  const [pagos] = await query(`
    SELECT
      persona,
      SUM(monto) as total_pagos
    FROM pagos_prestamos
    GROUP BY persona
  `);

  const resumen = {};

  movimientos.forEach(m => {
    resumen[m.persona_prestamo] = {
      persona: m.persona_prestamo,
      movimientos: parseFloat(m.saldo_movimientos),
      pagos: 0,
      saldo: parseFloat(m.saldo_movimientos)
    };
  });

  pagos.forEach(p => {
    if (!resumen[p.persona]) {
      resumen[p.persona] = { persona: p.persona, movimientos: 0, pagos: 0, saldo: 0 };
    }
    resumen[p.persona].pagos = parseFloat(p.total_pagos);
    resumen[p.persona].saldo = resumen[p.persona].movimientos - resumen[p.persona].pagos;
  });

  return Object.values(resumen);
}

/** Registra un pago de una persona; devuelve el pago creado */
export async function registrarPagoDeuda({ persona, monto, fecha, notas }) {
  const query = await consulta();
  const [resultado] = await query(
    'INSERT INTO pagos_prestamos (persona, monto, fecha, notas) VALUES (?, ?, ?, ?)',
    [persona, monto, fecha, notas || null]
  );
  const [pago] = await query('SELECT * FROM pagos_prestamos WHERE id = ?', [resultado.insertId]);
  return pago[0];
}
