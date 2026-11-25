import { sugerirCuenta, VENTANA_LOTE_MS, VENTANA_ALBUM_MS } from './cartolasBot.js';

const CUENTAS = [
  { id: 1, nombre: 'FAN', banco: 'Banco de Chile', tipo: 'tarjeta_debito' },
  { id: 2, nombre: 'CMR', banco: 'Falabella', tipo: 'tarjeta_credito' },
  { id: 3, nombre: 'Efectivo', banco: null, tipo: 'efectivo' }
];

describe('sugerirCuenta', () => {
  test('sugiere la cuenta del banco detectado', () => {
    expect(sugerirCuenta('Falabella', CUENTAS).id).toBe(2);
    expect(sugerirCuenta('Banco Falabella', CUENTAS).id).toBe(2);
    expect(sugerirCuenta('Banco de Chile', CUENTAS).id).toBe(1);
  });

  test('sin banco o sin cuenta que calce no sugiere nada', () => {
    expect(sugerirCuenta(null, CUENTAS)).toBeNull();
    expect(sugerirCuenta('Santander', CUENTAS)).toBeNull();
  });

  test('con dos cuentas del mismo banco no adivina', () => {
    const dos = [...CUENTAS, { id: 4, nombre: 'Débito Falabella', banco: 'Falabella', tipo: 'tarjeta_debito' }];

    expect(sugerirCuenta('Falabella', dos)).toBeNull();
  });
});

describe('ventanas de la cola', () => {
  test('archivos con menos de 10 segundos entre sí se agrupan; los álbumes cierran antes', () => {
    expect(VENTANA_LOTE_MS).toBe(10000);
    expect(VENTANA_ALBUM_MS).toBeLessThan(VENTANA_LOTE_MS);
  });
});
