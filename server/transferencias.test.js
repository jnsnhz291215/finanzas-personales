import {
  esTransferenciaSaliente,
  extraerDestinatario,
  clavePorNombre,
  esDestinoPropio,
  cruzarCuotas
} from './transferencias.js';

describe('transferencias salientes', () => {
  test('reconoce una transferencia a alguien y saca el nombre sin RUT ni números', () => {
    expect(esTransferenciaSaliente('TRANSFERENCIA A CAMILA PEREZ')).toBe(true);
    expect(esTransferenciaSaliente('Transferencia a Valeska por la cuota del mac')).toBe(true);
    expect(esTransferenciaSaliente('COMPRA SUPERMERCADO')).toBe(false);
    expect(extraerDestinatario('TRANSFERENCIA A CAMILA PEREZ')).toBe('Camila Perez');
    expect(extraerDestinatario('TRANSF. A VALESKA 12.345.678-9')).toBe('Valeska');
    expect(extraerDestinatario('Transferencia a Valeska por la cuota del mac')).toBe('Valeska');
    expect(extraerDestinatario('TEF A JUAN SANHUEZA BANCO CHILE 1234567')).toBe('Juan Sanhueza');
    expect(extraerDestinatario('Transferencia a terceros')).toBeNull();
  });

  test('la clave para recordar no depende de tildes ni mayúsculas', () => {
    expect(clavePorNombre('Camila Pérez')).toBe(clavePorNombre('CAMILA PEREZ'));
  });

  test('una cuenta propia es el propio Juan o una cuenta suya', () => {
    expect(esDestinoPropio('Juan Sanhueza', ['FAN'], 'Juan Sanhueza')).toBe(true);
    expect(esDestinoPropio('Mi cuenta Ahorro', ['Ahorro'], '')).toBe(true);
    expect(esDestinoPropio('Camila', ['FAN'], 'Juan Sanhueza')).toBe(false);
    expect(esDestinoPropio('', ['FAN'], 'Juan Sanhueza')).toBe(false);
  });
});

describe('cruzar el monto con las cuotas del mes', () => {
  const macbook = { alias: 'macbook', monto_cuota: 85000, total_cuotas: 12, cuotas_pagadas: 5 };
  const tv = { alias: 'tv', monto_cuota: 45000, total_cuotas: 10, cuotas_pagadas: 2 };
  const nombres = (r) => r.cuotas?.map(c => `${c.compra.alias}${c.numero}`).join('+');

  test('calza con una cuota', () => {
    const r = cruzarCuotas(85000, [macbook, tv]);
    expect(r.tipo).toBe('exacta');
    expect(nombres(r)).toBe('macbook6');
  });

  test('calza con la suma de varias cuotas', () => {
    const r = cruzarCuotas(130000, [macbook, tv]);
    expect(r.tipo).toBe('suma');
    expect(nombres(r)).toBe('macbook6+tv3');
  });

  test('parcial y sobrante avisan la diferencia', () => {
    expect(cruzarCuotas(100000, [macbook, tv])).toMatchObject({ tipo: 'parcial', diferencia: 30000, total: 130000 });
    expect(cruzarCuotas(200000, [macbook, tv])).toMatchObject({ tipo: 'sobra', diferencia: 70000 });
  });

  test('dos cuotas iguales son ambiguas y una compra terminada no cuenta', () => {
    expect(cruzarCuotas(85000, [macbook, { ...macbook, alias: 'otro' }]).tipo).toBe('ambigua');
    expect(cruzarCuotas(85000, [{ ...macbook, cuotas_pagadas: 12 }]).tipo).toBe('ninguna');
  });
});
