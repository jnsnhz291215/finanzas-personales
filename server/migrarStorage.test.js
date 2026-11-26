import { planificar, validarPlan, sentenciasDeRutas } from './migrarStorage.js';
import { slugCuenta, carpetaRelativaDeCuenta, nombreDeArchivo } from './storage.js';

const cuenta = { tipo: 'tarjeta_credito', titular: 'Valeska', ultimos4: '8263' };

describe('estructura por cuenta', () => {
  test('la carpeta usa tipo, titular y últimos 4, no el nombre de la cuenta', () => {
    expect(slugCuenta({ ...cuenta, nombre: 'Crédito Valeska ****8263' })).toBe('credito-valeska-8263');
    expect(slugCuenta({ ...cuenta, nombre: 'Otro nombre' })).toBe('credito-valeska-8263');
    expect(carpetaRelativaDeCuenta(cuenta, '2026-08-19')).toBe('cuentas/credito-valeska-8263/2026/08');
    expect(carpetaRelativaDeCuenta(null, '2026-08-19')).toBe('sin-cuenta/2026/08');
  });

  test('nombres de archivo', () => {
    expect(nombreDeArchivo('cartola', '2026-08-14', '.pdf')).toBe('cartola_2026-08.pdf');
    expect(nombreDeArchivo('cartola', '2026-08-14', '.pdf', new Set(['cartola_2026-08.pdf']))).toBe('cartola_2026-08_2.pdf');
    expect(nombreDeArchivo('comprobante', '2026-08-19', '.jpg')).toBe('comprobante_2026-08-19_1.jpg');
    expect(nombreDeArchivo('foto', '2026-08-19', 'jpg', new Set(['foto_2026-08-19_1.jpg']))).toBe('foto_2026-08-19_2.jpg');
  });
});

describe('plan de migración', () => {
  const item = (origen, clase, cuentaDe, fecha, valores = [origen]) => ({ origen, clase, cuenta: cuentaDe, fecha, extension: origen.slice(origen.lastIndexOf('.')), valores });

  test('mueve a la carpeta de la cuenta, sin repetir destinos, y no toca lo que ya está en su lugar', () => {
    const plan = planificar([
      item('cartolas/2026-11/a.pdf', 'cartola', cuenta, '2026-08-14'),
      item('cartolas/2026-11/b.pdf', 'cartola', cuenta, '2026-08-30'),
      item('comprobantes/2026-11/c.jpg', 'comprobante', null, '2026-08-19'),
      item('cuentas/credito-valeska-8263/2026/08/cartola_2026-08.pdf', 'cartola', cuenta, '2026-08-14')
    ]);
    expect(plan.map(p => p.destino)).toEqual([
      'cuentas/credito-valeska-8263/2026/08/cartola_2026-08.pdf',
      'cuentas/credito-valeska-8263/2026/08/cartola_2026-08_2.pdf',
      'sin-cuenta/2026/08/comprobante_2026-08-19_1.jpg'
    ]);
    expect(validarPlan(plan)).toEqual([]);
  });

  test('las sentencias actualizan las rutas de la BD y se pueden invertir', () => {
    const plan = [{ origen: 'cartolas/2026-11/a.pdf', destino: 'cuentas/x/2026/08/cartola_2026-08.pdf', valores: ['cartolas/2026-11/a.pdf'] }];
    expect(sentenciasDeRutas(plan)[0].params).toEqual(['cuentas/x/2026/08/cartola_2026-08.pdf', 'cartolas/2026-11/a.pdf']);
    expect(sentenciasDeRutas(plan, true)[0].params).toEqual(['cartolas/2026-11/a.pdf', 'cuentas/x/2026/08/cartola_2026-08.pdf']);
  });
});
