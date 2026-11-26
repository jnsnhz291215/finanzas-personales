import { planificarReparacion, sentenciasDeReparacion } from './repararFechas.js';

const datos = () => ({
  archivos: [
    { id: 1, hash_archivo: 'h1', ruta_archivo: 'r1', periodo_desde: '2602-09-02', periodo_hasta: '2617-09-17' },
    { id: 2, hash_archivo: 'h2', ruta_archivo: 'r2', periodo_desde: '2026-01-01', periodo_hasta: '2026-01-31' }
  ],
  movimientos: [
    { id: 10, fecha: '2617-09-17', importado_de: 'r1' },
    { id: 11, fecha: '2026-09-17', importado_de: 'r1' },
    { id: 12, fecha: '2619-05-08', importado_de: null }
  ],
  cargos: [
    { id: 20, hash_archivo: 'h1', fecha: '2026-09-02' },
    { id: 21, hash_archivo: 'h1', fecha: '2602-09-02' }
  ],
  compras: [{ id: 30, fecha_inicio: '2619-05-08' }, { id: 31, fecha_inicio: '2026-05-08' }]
});

describe('reparación de fechas con año inválido', () => {
  test('recalcula el período con las fechas válidas y corrige lo que viene de esa cartola', () => {
    const plan = planificarReparacion(datos(), 2026);
    expect(plan.archivosAReparar).toEqual([{ id: 1, desde: '2026-09-02', hasta: '2026-09-02' }]);
    expect(plan.movimientosAReparar).toEqual([{ id: 10, fecha: '2026-09-17' }]);
    expect(plan.movimientosSinCorregir).toBe(1);
    expect(plan.cargosAReparar).toEqual([{ id: 21, fecha: '2026-09-02' }]);
    expect(plan.comprasAReparar).toEqual([{ id: 30 }]);
    expect(sentenciasDeReparacion(plan)).toHaveLength(4);
  });

  test('es idempotente: con todas las fechas válidas no hay nada que hacer', () => {
    const sano = {
      archivos: [{ id: 1, hash_archivo: 'h1', ruta_archivo: 'r1', periodo_desde: '2026-09-02', periodo_hasta: '2026-09-17' }],
      movimientos: [], cargos: [], compras: []
    };
    expect(sentenciasDeReparacion(planificarReparacion(sano, 2026))).toHaveLength(0);
  });
});
