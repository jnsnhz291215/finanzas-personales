import {
  esTitularPropio,
  comprasDeTitular,
  acreedoresDe,
  reconocerCuota,
  evaluarNumeroCuota,
  extraerNumeroCuota,
  aliasDeCargo,
  buscarCompraSimilar,
  montosCalzan,
  parsearSeleccion,
  lineaCargo,
  textoResumenLote
} from './terceros.js';
import { parsearComprobante, extraerMontoComprobante, extraerFechaComprobante, mencionaNombre } from './comprobante.js';

const compra = { alias: 'macbook', alias_cartola: 'valeska', acreedor: 'Valeska Pérez', monto_cuota: 85000, total_cuotas: 12, cuotas_pagadas: 5 };

describe('titular y compras', () => {
  test('sin titular, "yo" o el titular por defecto son propios; otra persona no', () => {
    expect(esTitularPropio(null, 'Juan Sanhueza')).toBe(true);
    expect(esTitularPropio('Yo', 'Juan Sanhueza')).toBe(true);
    expect(esTitularPropio('Juan Sanhueza', 'Juan Sanhueza')).toBe(true);
    expect(esTitularPropio('Valeska', 'Juan Sanhueza')).toBe(false);
  });

  test('encuentra las compras de un titular por nombre parcial', () => {
    expect(comprasDeTitular([compra], 'Valeska')).toHaveLength(1);
    expect(comprasDeTitular([compra], 'Maria')).toHaveLength(0);
    expect(acreedoresDe([compra, { ...compra, acreedor: 'valeska pérez' }])).toEqual(['Valeska Pérez']);
  });
});

describe('reconocer la cuota en la cartola', () => {
  const movs = [
    { descripcion: 'SUPERMERCADO LIDER', monto: 12300, tipo: 'cargo' },
    { descripcion: 'APPLE STORE MACBOOK CUOTA 06/12', monto: 85000, tipo: 'cargo' },
    { descripcion: 'PAGO TARJETA', monto: 85000, tipo: 'abono' }
  ];

  test('por el número de cuota con el total correcto', () => {
    const r = reconocerCuota(movs, compra);
    expect(r).toMatchObject({ indice: 1, numero: 6 });
  });

  test('por descripción y monto aunque no diga el número', () => {
    const r = reconocerCuota([{ descripcion: 'APPLE MACBOOK', monto: 85000, tipo: 'cargo' }], compra);
    expect(r).toMatchObject({ indice: 0, numero: null });
  });

  test('un monto igual solo, sin descripción ni número, no alcanza; un abono nunca', () => {
    expect(reconocerCuota([{ descripcion: 'COMERCIO X', monto: 85000, tipo: 'cargo' }], compra)).toBeNull();
    expect(reconocerCuota([{ descripcion: 'MACBOOK 06/12', monto: 85000, tipo: 'abono' }], compra)).toBeNull();
  });

  test('un "03/12" de otra compra (otro total) no cuenta', () => {
    expect(reconocerCuota([{ descripcion: 'TIENDA 03/06', monto: 20000, tipo: 'cargo' }], compra)).toBeNull();
  });
});

describe('número de cuota en la descripción de un cargo', () => {
  test('lee 06/12, 6/12, C06/12, CUOTA 6 DE 12 y 6 de 12 cuotas', () => {
    for (const t of ['APPLE STORE 06/12', 'compra 6/12', 'C06/12 TIENDA', 'CUOTA 6 DE 12 LIDER', 'tienda cuota 06/12', 'TIENDA 6 de 12 cuotas']) {
      expect(extraerNumeroCuota(t)).toEqual({ actual: 6, total: 12 });
    }
  });

  test('no confunde una fecha ni un 1/1', () => {
    expect(extraerNumeroCuota('pago 05/11 supermercado')).toBeNull();
    expect(extraerNumeroCuota('SUPERMERCADO 12/11/2026')).toBeNull();
    expect(extraerNumeroCuota('FARMACIA 1/1')).toBeNull();
    expect(extraerNumeroCuota('cuota 9 de 3')).toBeNull();
  });

  test('alias de la compra y búsqueda de la que ya existe', () => {
    expect(aliasDeCargo('APPLE STORE MACBOOK CUOTA 06/12')).toBe('apple store macbook');
    const compras = [{ alias: 'tv samsung', total_cuotas: 10, monto_cuota: 45000 }, { alias: 'otra', total_cuotas: 10, monto_cuota: 45000 }];
    expect(buscarCompraSimilar(compras, 'TV SAMSUNG 4/10', 45000, 10).alias).toBe('tv samsung');
    expect(buscarCompraSimilar(compras, 'TV SAMSUNG 4/12', 45000, 12)).toBeNull();
    expect(buscarCompraSimilar(compras, 'TV SAMSUNG 4/10', 50000, 10)).toBeNull();
  });
});

describe('cuándo se avanza el contador', () => {
  test('registra la siguiente, no duplica una ya pagada y avisa si se salta una', () => {
    expect(evaluarNumeroCuota(compra, 6)).toEqual({ accion: 'registrar', numero: 6 });
    expect(evaluarNumeroCuota(compra, null)).toEqual({ accion: 'registrar', numero: 6 });
    expect(evaluarNumeroCuota(compra, 5)).toEqual({ accion: 'duplicada', numero: 5 });
    expect(evaluarNumeroCuota(compra, 8)).toEqual({ accion: 'salto', numero: 8, esperada: 6 });
    expect(evaluarNumeroCuota(compra, 3)).toEqual({ accion: 'menor', numero: 3, esperada: 6 });
  });

  test('los montos calzan con $1 de tolerancia', () => {
    expect(montosCalzan(85000, 85000.5)).toBe(true);
    expect(montosCalzan(85000, 90000)).toBe(false);
  });
});

describe('"el 2 y el 5 son míos"', () => {
  test('lee números, todos y ninguno', () => {
    expect(parsearSeleccion('el 2 y el 5 son míos', 6)).toEqual({ indices: [2, 5] });
    expect(parsearSeleccion('2, 5', 6)).toEqual({ indices: [2, 5] });
    expect(parsearSeleccion('solo el 3', 6)).toEqual({ indices: [3] });
    expect(parsearSeleccion('todos', 6)).toEqual({ todos: true });
    expect(parsearSeleccion('ninguno es mío', 6)).toEqual({ ninguno: true });
  });

  test('un número fuera de la lista es un error y un texto cualquiera no es una selección', () => {
    expect(parsearSeleccion('el 9 es mío', 6).error).toMatch(/No hay un cargo número 9/);
    expect(parsearSeleccion('gracias, lo reviso mañana', 6)).toBeNull();
    expect(parsearSeleccion('el 2 lo pagué con la otra tarjeta', 6)).toBeNull();
  });
});

describe('textos', () => {
  test('línea de un cargo y resumen del lote', () => {
    expect(lineaCargo(3, { fecha: '2026-11-12', descripcion: 'FARMACIA', monto: 8900 })).toBe('3. 12-11-2026 FARMACIA $8.900');
    expect(lineaCargo(4, { fecha: '2026-11-16', descripcion: 'TV SAMSUNG 3/10', monto: 45000 })).toBe('4. 16-11-2026 TV SAMSUNG 3/10 $45.000 (cuota 3/10)');
    const t = textoResumenLote({ titular: 'Valeska', cuota: { estado: 'registrada', numero: 6, total: 12, alias: 'macbook' }, gastos: 2, pago: 'registrado' });
    expect(t).toBe('Cartola de Valeska\nCuota registrada: macbook 6/12\n2 gastos tuyos agregados\nPago a Valeska registrado');
    const conOtras = textoResumenLote({
      titular: 'Valeska', cuota: { estado: 'registrada', numero: 12, total: 12, alias: 'macbook', terminada: true }, gastos: 1, pago: 'registrado',
      otras: [{ alias: 'tv samsung', actual: 3, total: 10, estado: 'nueva', terminada: false }]
    });
    expect(conOtras).toContain('Cuota registrada: macbook 12/12 (compra terminada)');
    expect(conOtras).toContain('Cuotas: tv samsung 3/10 (nueva)');
  });
});

describe('comprobante leído con OCR', () => {
  const texto = 'Comprobante de transferencia\nTransferencia realizada con exito\nMonto transferido: $85.000\nFecha: 24 de noviembre de 2026\nDestinatario: Valeska Perez\nCuenta origen: Banco de Chile ****1234';

  test('monto, fecha y transferencia', () => {
    expect(parsearComprobante(texto, '2026-11-25')).toEqual({ esTransferencia: true, monto: 85000, fecha: '2026-11-24' });
  });

  test('formatos de fecha y fechas futuras', () => {
    expect(extraerFechaComprobante('Fecha 24/11/2026', '2026-11-25')).toBe('2026-11-24');
    expect(extraerFechaComprobante('24-11-26 14:03', '2026-11-25')).toBe('2026-11-24');
    expect(extraerFechaComprobante('el 24 nov 2026', '2026-11-25')).toBe('2026-11-24');
    expect(extraerFechaComprobante('Fecha 30/12/2026', '2026-11-25')).toBeNull();
  });

  test('con varios montos y ninguno rotulado no se adivina', () => {
    expect(extraerMontoComprobante('Saldo $1.500.000\nComisión $0')).toBeNull();
    expect(extraerMontoComprobante('Monto $85.000\nSaldo $1.500.000')).toBe(85000);
  });

  test('menciona a la persona por nombre o apellido, sin tildes', () => {
    expect(mencionaNombre(texto, 'Valeska')).toBe(true);
    expect(mencionaNombre(texto, 'Valeska Pérez')).toBe(true);
    expect(mencionaNombre(texto, 'Camila')).toBe(false);
  });

  test('un texto sin monto o sin palabra de transferencia no es un comprobante', () => {
    expect(parsearComprobante('Foto de un gato', '2026-11-25').esTransferencia).toBe(false);
    expect(parsearComprobante('Compra en tienda $5.000', '2026-11-25').esTransferencia).toBe(false);
  });
});
