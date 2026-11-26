import {
  esTransferenciaSaliente,
  extraerDestinatario,
  clavePorNombre,
  esDestinoPropio,
  cruzarCuotas,
  cruzarConAnteriores,
  repartirMonto,
  fijoQueCalza
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

describe('varias compras, varias transferencias', () => {
  const macbook = { alias: 'macbook', monto_cuota: 85000, total_cuotas: 12, cuotas_pagadas: 5 };
  const tv = { alias: 'tv', monto_cuota: 45000, total_cuotas: 10, cuotas_pagadas: 2 };
  const celular = { alias: 'celular', monto_cuota: 30000, total_cuotas: 6, cuotas_pagadas: 1 };

  test('el monto de todas las cuotas calza como suma de todas', () => {
    const r = cruzarCuotas(160000, [macbook, tv, celular]);
    expect(r.tipo).toBe('suma');
    expect(r.cuotas).toHaveLength(3);
  });

  test('dos transferencias de 65.000 del mes juntas pagan 130.000', () => {
    expect(cruzarCuotas(65000, [macbook, tv]).tipo).toBe('parcial');
    const junto = cruzarConAnteriores(65000, [{ id: 1, fecha: '2026-11-20', monto: 65000 }], [macbook, tv]);
    expect(junto.total).toBe(130000);
    expect(junto.cruce.tipo).toBe('suma');
    expect(junto.movimientos).toHaveLength(1);
  });

  test('sin transferencias anteriores, o si juntas tampoco calzan, no hay grupo', () => {
    expect(cruzarConAnteriores(65000, [], [macbook, tv])).toBeNull();
    expect(cruzarConAnteriores(65000, [{ id: 1, fecha: '2026-11-20', monto: 1000 }], [macbook, tv])).toBeNull();
  });

  test('al repartir entre las cuotas marcadas, la última queda con la diferencia', () => {
    const [a, b] = [{ compra: macbook, numero: 6, monto: 85000 }, { compra: tv, numero: 3, monto: 45000 }];
    expect(repartirMonto([a, b], 100000).map(c => c.montoAplicado)).toEqual([85000, 15000]);
    expect(repartirMonto([a, b], 150000).map(c => c.montoAplicado)).toEqual([85000, 65000]);
    expect(repartirMonto([a], 60000).map(c => c.montoAplicado)).toEqual([60000]);
  });
});

describe('pago de un gasto fijo', () => {
  const fijos = [
    { id: 1, nombre: 'Telefonía', monto: 24000, destinatario: 'Vivian', activo: true },
    { id: 2, nombre: 'Arriendo', monto: 350000, destinatario: 'Don Pedro', activo: true },
    { id: 3, nombre: 'Luz', monto: 30000, destinatario: null, activo: true }
  ];

  test('calza por destinatario y monto dentro del 10 %', () => {
    expect(fijoQueCalza('Vivian', 25000, fijos)?.id).toBe(1);
    expect(fijoQueCalza('Vivian', 26400, fijos)?.id).toBe(1);
    expect(fijoQueCalza('Vivian', 27000, fijos)).toBeNull();
    expect(fijoQueCalza('Pedro', 350000, fijos)?.id).toBe(2);
  });

  test('sin destinatario, otro destinatario o gasto inactivo no calza', () => {
    expect(fijoQueCalza('Camila', 24000, fijos)).toBeNull();
    expect(fijoQueCalza('Vivian', 24000, [{ ...fijos[0], activo: false }])).toBeNull();
    expect(fijoQueCalza('', 24000, fijos)).toBeNull();
  });
});
