import { interpretarResetCuenta, rangoDePeriodo, etiquetaPeriodo, recalcularCuotas, sentenciasBorrar, sentenciasInsertar } from './resetCuenta.js';

describe('interpretarResetCuenta', () => {
  test('dígitos, con y sin período', () => {
    expect(interpretarResetCuenta('8263')).toMatchObject({ digitos: '8263', periodo: null });
    expect(interpretarResetCuenta('8263 mes 1')).toMatchObject({ digitos: '8263', periodo: { mesDesde: 1, mesHasta: 1, anio: null } });
    expect(interpretarResetCuenta('8263 mes 1 2026')).toMatchObject({ digitos: '8263', periodo: { anio: 2026 } });
  });

  test('nombre de mes, con año y rango', () => {
    expect(interpretarResetCuenta('enero 2026')).toMatchObject({ periodo: { mesDesde: 1, mesHasta: 1, anio: 2026 } });
    expect(interpretarResetCuenta('mes 1 a 3')).toMatchObject({ periodo: { mesDesde: 1, mesHasta: 3 } });
    expect(interpretarResetCuenta('8263 enero a marzo')).toMatchObject({ digitos: '8263', periodo: { mesDesde: 1, mesHasta: 3 } });
  });

  test('frases', () => {
    expect(interpretarResetCuenta('resetea la cuenta 8263')).toMatchObject({ verbo: 'resetea', digitos: '8263' });
    expect(interpretarResetCuenta('borra enero de la 8263')).toMatchObject({ verbo: 'borra', digitos: '8263', periodo: { mesDesde: 1 } });
  });

  test('"borra" sin período no es de esto (sería desactivar una cuenta)', () => {
    expect(interpretarResetCuenta('borra la cuenta 8263')).toBeNull();
  });

  test('un período inválido da error', () => {
    expect(interpretarResetCuenta('8263 mes 13').error).toBeTruthy();
    expect(interpretarResetCuenta('8263 mes 5 a 2').error).toBeTruthy();
  });
});

describe('período y cuotas', () => {
  test('rango y etiqueta', () => {
    expect(rangoDePeriodo({ mesDesde: 1, mesHasta: 3 }, 2026)).toMatchObject({ desde: '2026-01-01', hasta: '2026-03-31', mesDesde: '2026-01', mesHasta: '2026-03' });
    expect(rangoDePeriodo(null, 2026)).toBeNull();
    expect(etiquetaPeriodo({ mesDesde: 1, mesHasta: 1 }, 2026)).toBe('enero 2026');
    expect(etiquetaPeriodo(null, 2026)).toBe('toda la cuenta');
  });

  test('si se borran pagos de una compra, su contador baja en esa cantidad y nunca queda negativo', () => {
    const compras = [{ id: 1, alias: 'Mac', cuotas_pagadas: 7, total_cuotas: 12, terminada: 0 }, { id: 2, alias: 'TV', cuotas_pagadas: 1, total_cuotas: 6, terminada: 0 }];
    const r = recalcularCuotas(compras, new Map([[1, 2], [2, 5]]));
    expect(r.find(c => c.id === 1)).toMatchObject({ antes: 7, despues: 5 });
    expect(r.find(c => c.id === 2)).toMatchObject({ despues: 0 });
  });

  test('las sentencias de borrar e insertar arman los marcadores', () => {
    expect(sentenciasBorrar('movimientos', [1, 2])[0]).toEqual({ sql: 'DELETE FROM movimientos WHERE id IN (?,?)', params: [1, 2] });
    expect(sentenciasInsertar('movimientos', [{ id: 1, monto: 5 }])[0]).toEqual({ sql: 'INSERT INTO movimientos (id, monto) VALUES (?, ?)', params: [1, 5] });
    expect(sentenciasBorrar('movimientos', [])).toEqual([]);
  });
});
