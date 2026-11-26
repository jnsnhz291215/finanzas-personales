import {
  parsearAltaCuotas,
  detectarAltaCuotas,
  parsearPagoCuota,
  validarPagoCuota,
  buscarCompras,
  detectarConsultaCuotas,
  lineasListaCuotas,
  partirEnMensajes,
  proximaFechaPago,
  resumenCompra,
  calzarConCartola
} from './cuotas.js';

const MAC = {
  id: 1, alias: 'mac', alias_cartola: 'valeska', acreedor: 'tía',
  monto_cuota: 85000, total_cuotas: 12, cuotas_pagadas: 6, dia_pago: 5, terminada: false
};
const CELULAR = {
  id: 2, alias: 'celular', alias_cartola: null, acreedor: 'tía',
  monto_cuota: 20000, total_cuotas: 6, cuotas_pagadas: 0, dia_pago: null, terminada: false
};

describe('parsearAltaCuotas', () => {
  test('"/cuotas nueva mac 12 cuotas de 85 mil tía, pagadas 6"', () => {
    expect(parsearAltaCuotas('/cuotas nueva mac 12 cuotas de 85 mil tía, pagadas 6')).toEqual({
      alias: 'mac', acreedor: 'tía', totalCuotas: 12, montoCuota: 85000, montoTotal: null,
      cuotasPagadas: 6, diaPago: null, aliasCartola: null
    });
  });

  test('"compré el mac en 12 cuotas de 85 mil con la tarjeta de la tía"', () => {
    const r = parsearAltaCuotas('compré el mac en 12 cuotas de 85 mil con la tarjeta de la tía');

    expect(r.alias).toBe('mac');
    expect(r.acreedor).toBe('tía');
    expect(r.totalCuotas).toBe(12);
    expect(r.montoCuota).toBe(85000);
    expect(r.cuotasPagadas).toBeNull();
  });

  test('detecta el alta en texto libre solo si compra y trae "N cuotas"', () => {
    expect(detectarAltaCuotas('compré el mac en 12 cuotas de 85 mil con la tarjeta de la tía')).toBe(true);
    expect(detectarAltaCuotas('pagué cuota mac 7/12')).toBe(false);
    expect(detectarAltaCuotas('compré pan')).toBe(false);
    expect(detectarAltaCuotas('/cuotas nueva mac 12 cuotas de 85 mil tía')).toBe(false);
  });

  test('lo que falta queda en null para que el bot lo pregunte', () => {
    const r = parsearAltaCuotas('/cuotas nueva mac tía');

    expect(r.alias).toBe('mac');
    expect(r.acreedor).toBe('tía');
    expect(r.totalCuotas).toBeNull();
    expect(r.montoCuota).toBeNull();
  });

  test('día de pago, total y alias de la cartola opcionales', () => {
    const r = parsearAltaCuotas('/cuotas nueva mac 12 cuotas de 85 mil tía total 1.020.000 día 5 cartola valeska');

    expect(r.montoTotal).toBe(1020000);
    expect(r.diaPago).toBe(5);
    expect(r.aliasCartola).toBe('valeska');
    expect(r.alias).toBe('mac');
    expect(r.acreedor).toBe('tía');
  });
});

describe('alias de varias palabras', () => {
  test('entre comillas', () => {
    const r = parsearAltaCuotas('/cuotas nueva "macbook pro" 12 cuotas de 85 mil tía');

    expect(r.alias).toBe('macbook pro');
    expect(r.acreedor).toBe('tía');
    expect(r.totalCuotas).toBe(12);
    expect(r.montoCuota).toBe(85000);
  });

  test('con comillas tipográficas y en el alta en texto libre', () => {
    const r = parsearAltaCuotas('compré el “macbook pro” en 12 cuotas de 85 mil con la tarjeta de la tía');

    expect(r.alias).toBe('macbook pro');
    expect(r.acreedor).toBe('tía');
  });

  test('separado con guion', () => {
    const r = parsearAltaCuotas('/cuotas nueva macbook-pro 12 cuotas de 85 mil tía');

    expect(r.alias).toBe('macbook-pro');
    expect(r.acreedor).toBe('tía');
  });

  test('el pago calza con el alias tanto si se escribe con guion como con espacio', () => {
    const compras = [{ id: 1, alias: 'macbook-pro', acreedor: 'tía' }, { id: 2, alias: 'macbook pro', acreedor: 'tía' }];

    expect(buscarCompras(compras, parsearPagoCuota('pagué cuota macbook pro 3/12').palabras).map(c => c.id)).toEqual([1, 2]);
    expect(buscarCompras(compras, parsearPagoCuota('pagué cuota macbook-pro 3/12').palabras).map(c => c.id)).toEqual([1, 2]);
    expect(buscarCompras(compras, parsearPagoCuota('pagué la cuota del "macbook pro"').palabras).map(c => c.id)).toEqual([1, 2]);
  });
});

describe('parsearPagoCuota', () => {
  test('"pagué cuota tía mac 6/12"', () => {
    expect(parsearPagoCuota('pagué cuota tía mac 6/12')).toEqual({ numero: 6, total: 12, monto: null, palabras: ['tia', 'mac'] });
  });

  test('"pague cuota mac 7/12"', () => {
    expect(parsearPagoCuota('pague cuota mac 7/12')).toEqual({ numero: 7, total: 12, monto: null, palabras: ['mac'] });
  });

  test('"pagué la cuota del mac" sin número ni monto', () => {
    expect(parsearPagoCuota('pagué la cuota del mac')).toEqual({ numero: null, total: null, monto: null, palabras: ['mac'] });
  });

  test('con monto', () => {
    expect(parsearPagoCuota('pagué la cuota del mac de 85 mil')).toMatchObject({ monto: 85000, palabras: ['mac'] });
  });

  test('un gasto normal no es un pago de cuota', () => {
    expect(parsearPagoCuota('pagué 5 mil en uber')).toBeNull();
    expect(parsearPagoCuota('pagué la tarjeta')).toBeNull();
  });
});

describe('validarPagoCuota', () => {
  test('sin número asume la siguiente', () => {
    expect(validarPagoCuota(MAC, {})).toEqual({ numero: 7, errores: [], avisos: [] });
  });

  test('la siguiente esperada no genera avisos', () => {
    expect(validarPagoCuota(MAC, { numero: 7, total: 12 }).avisos).toEqual([]);
  });

  test('N mayor que M es un error', () => {
    const r = validarPagoCuota(MAC, { numero: 13, total: 12 });

    expect(r.errores).toHaveLength(1);
    expect(r.errores[0]).toContain('supera el total');
  });

  test('avisa si no es la siguiente esperada o si ya estaba pagada', () => {
    expect(validarPagoCuota(MAC, { numero: 9, total: 12 }).avisos[0]).toContain('siguiente cuota esperada es la 7');
    expect(validarPagoCuota(MAC, { numero: 6, total: 12 }).avisos[0]).toContain('ya estaba pagada');
  });

  test('un total que no coincide con la compra es un error', () => {
    expect(validarPagoCuota(MAC, { numero: 7, total: 10 }).errores[0]).toContain('no coincide');
  });

  test('una compra terminada no admite más pagos', () => {
    expect(validarPagoCuota({ ...MAC, terminada: true, cuotas_pagadas: 12 }, {}).errores.length).toBeGreaterThan(0);
  });
});

describe('buscarCompras', () => {
  const compras = [MAC, CELULAR];

  test('por alias o por persona, sin tildes ni mayúsculas', () => {
    expect(buscarCompras(compras, ['mac']).map(c => c.id)).toEqual([1]);
    expect(buscarCompras(compras, ['tia']).map(c => c.id)).toEqual([1, 2]);
    expect(buscarCompras(compras, ['tia', 'mac']).map(c => c.id)).toEqual([1]);
    expect(buscarCompras(compras, ['inexistente'])).toEqual([]);
  });

  test('sin palabras devuelve todas', () => {
    expect(buscarCompras(compras, [])).toHaveLength(2);
  });
});

describe('detectarConsultaCuotas', () => {
  test('"cuánto le debo a mi tía"', () => {
    expect(detectarConsultaCuotas('cuánto le debo a mi tía')).toEqual({ tipo: 'acreedor', termino: 'tia' });
  });

  test('"cuántas cuotas me quedan del mac"', () => {
    expect(detectarConsultaCuotas('cuántas cuotas me quedan del mac')).toEqual({ tipo: 'compra', termino: 'mac' });
  });

  test('nunca si el mensaje trae un monto o un número', () => {
    expect(detectarConsultaCuotas('cuánto le debo a mi tía si pago 85 mil')).toBeNull();
    expect(detectarConsultaCuotas('pagué 5 mil en uber')).toBeNull();
  });
});

describe('resumen y fechas', () => {
  test('lo que falta de una compra', () => {
    const r = resumenCompra(MAC, '2026-11-18');

    expect(r).toMatchObject({ pagadas: 6, total: 12, restantes: 6, montoPendiente: 510000, proximaCuota: 7 });
    expect(r.proximaFecha).toBe('2026-12-05');
  });

  test('próxima fecha de pago: este mes si aún no pasó, si no el siguiente', () => {
    expect(proximaFechaPago(25, '2026-11-18')).toBe('2026-11-25');
    expect(proximaFechaPago(5, '2026-11-18')).toBe('2026-12-05');
    expect(proximaFechaPago(31, '2026-02-10')).toBe('2026-02-28');
    expect(proximaFechaPago(5, '2026-12-18')).toBe('2027-01-05');
    expect(proximaFechaPago(null, '2026-11-18')).toBeNull();
  });
});

describe('calzarConCartola', () => {
  test('"transferencia a Valeska" calza con el alias de la cartola', () => {
    expect(calzarConCartola('Transferencia a Valeska', [MAC, CELULAR]).map(c => c.id)).toEqual([1]);
    expect(calzarConCartola('Transferencia a Pedro', [MAC, CELULAR])).toEqual([]);
  });
});

describe('lista completa de cuotas', () => {
  const d = (n) => `$${n}`;
  const compras = [
    { id: 1, alias: 'macbook', acreedor: 'Valeska', monto_total: null, monto_cuota: 100, total_cuotas: 12, cuotas_pagadas: 6, terminada: false },
    { id: 2, alias: 'tele', acreedor: 'Valeska', monto_total: null, monto_cuota: 50, total_cuotas: 6, cuotas_pagadas: 6, terminada: true }
  ];

  test('activas primero, terminadas después, con totales por titular y general', () => {
    const lineas = lineasListaCuotas(compras, new Map(), d);
    expect(lineas[1]).toBe('Macbook 6/12 · cuota $100 · pagado $600 · se debe $600 · quedan 6 cuotas');
    expect(lineas[2]).toBe('Tele 6/6 · pagado $300 · terminada');
    expect(lineas[3]).toBe('Total pagado $900 · se debe $600');
    expect(lineas[lineas.length - 1]).toContain('Total general');
  });

  test('pagado es el mayor entre la suma real y cuotas pagadas x cuota', () => {
    expect(lineasListaCuotas(compras, new Map([[1, 700]]), d)[1]).toContain('pagado $700');
    expect(lineasListaCuotas(compras, new Map([[1, 550]]), d)[1]).toContain('pagado $600');
  });

  test('parte los mensajes sin cortar líneas', () => {
    expect(partirEnMensajes(['a'.repeat(3000), 'b'.repeat(600)])).toHaveLength(2);
  });

  test('frases con regla local', () => {
    expect(detectarConsultaCuotas('cuotas')).toEqual({ tipo: 'lista', termino: null });
    expect(detectarConsultaCuotas('cuánto debo del mac')).toEqual({ tipo: 'compra', termino: 'mac' });
  });
});
