import { sugerirCuenta, detectarCuenta, candidatoDigitos, VENTANA_LOTE_MS, VENTANA_ALBUM_MS } from './cartolasBot.js';

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

describe('detectarCuenta: los dígitos del archivo tienen prioridad sobre el banco', () => {
  const CON_DIGITOS = [
    { id: 1, nombre: 'FAN', banco: 'Banco de Chile', tipo: 'tarjeta_debito', ultimos4: '1234', ultimos4_cuenta: null },
    { id: 2, nombre: 'Falabella débito', banco: 'Falabella', tipo: 'tarjeta_debito', ultimos4: '6958', ultimos4_cuenta: '5678' },
    { id: 3, nombre: 'CMR', banco: 'Falabella', tipo: 'tarjeta_credito', ultimos4: '9999', ultimos4_cuenta: null }
  ];

  test('coinciden los 4 dígitos de la tarjeta: cuenta detectada por dígitos', () => {
    const r = detectarCuenta({ banco: null, ultimos4: [{ digitos: '6958', tipo: 'tarjeta' }] }, CON_DIGITOS);

    expect(r).toMatchObject({ por: 'digitos', digitos: '6958' });
    expect(r.cuenta.id).toBe(2);
  });

  test('coinciden los 4 dígitos del número de cuenta (ultimos4_cuenta)', () => {
    const r = detectarCuenta({ banco: 'Falabella', ultimos4: [{ digitos: '5678', tipo: 'cuenta' }] }, CON_DIGITOS);

    expect(r).toMatchObject({ por: 'digitos', digitos: '5678' });
    expect(r.cuenta.id).toBe(2);
  });

  test('los dígitos ganan al banco: con dos cuentas de Falabella el banco no alcanza, los dígitos sí', () => {
    expect(sugerirCuenta('Falabella', CON_DIGITOS)).toBeNull();
    expect(sugerirCuenta('Falabella', CON_DIGITOS, [{ digitos: '9999', tipo: 'tarjeta' }]).id).toBe(3);
  });

  test('sin coincidencia de dígitos se usa el banco detectado', () => {
    const r = detectarCuenta({ banco: 'Banco de Chile', ultimos4: [{ digitos: '0000', tipo: 'tarjeta' }] }, CON_DIGITOS);

    expect(r).toMatchObject({ por: 'banco', digitos: null });
    expect(r.cuenta.id).toBe(1);
  });

  test('dígitos que calzan con dos cuentas distintas no se adivinan', () => {
    const r = detectarCuenta({
      banco: null,
      ultimos4: [{ digitos: '1234', tipo: 'tarjeta' }, { digitos: '9999', tipo: 'tarjeta' }]
    }, CON_DIGITOS);

    expect(r).toBeNull();
  });

  test('sin dígitos ni banco no hay cuenta', () => {
    expect(detectarCuenta({ banco: null, ultimos4: [] }, CON_DIGITOS)).toBeNull();
  });
});

describe('candidatoDigitos: dígitos nuevos que se pueden guardar en la cuenta elegida', () => {
  const CUENTAS_BASE = [
    { id: 1, nombre: 'FAN', ultimos4: '1234', ultimos4_cuenta: null },
    { id: 2, nombre: 'CMR', ultimos4: null, ultimos4_cuenta: null }
  ];

  test('dígitos que no son de ninguna cuenta se ofrecen para la cuenta elegida', () => {
    expect(candidatoDigitos([{ digitos: '4321', tipo: 'tarjeta' }], CUENTAS_BASE[1], CUENTAS_BASE))
      .toEqual({ digitos: '4321', tipo: 'tarjeta' });
    expect(candidatoDigitos([{ digitos: '4321', tipo: 'cuenta' }], CUENTAS_BASE[1], CUENTAS_BASE))
      .toEqual({ digitos: '4321', tipo: 'cuenta' });
  });

  test('si los dígitos ya son de una cuenta no se pregunta', () => {
    expect(candidatoDigitos([{ digitos: '1234', tipo: 'tarjeta' }], CUENTAS_BASE[1], CUENTAS_BASE)).toBeNull();
  });

  test('no se sobrescribe un dato que la cuenta ya tiene', () => {
    expect(candidatoDigitos([{ digitos: '4321', tipo: 'tarjeta' }], CUENTAS_BASE[0], CUENTAS_BASE)).toBeNull();
  });

  test('sin dígitos en la cartola no hay nada que ofrecer', () => {
    expect(candidatoDigitos([], CUENTAS_BASE[1], CUENTAS_BASE)).toBeNull();
    expect(candidatoDigitos(undefined, CUENTAS_BASE[1], CUENTAS_BASE)).toBeNull();
  });
});

describe('ventanas de la cola', () => {
  test('archivos con menos de 10 segundos entre sí se agrupan; los álbumes cierran antes', () => {
    expect(VENTANA_LOTE_MS).toBe(10000);
    expect(VENTANA_ALBUM_MS).toBeLessThan(VENTANA_LOTE_MS);
  });
});
