import {
  calcularPlan,
  validarPorcentajes,
  validarGastoFijo,
  infoMes,
  esGastoFijo,
  listaPalabrasClave,
  TIPOS_GASTO_LIBRE,
  parsearFijo,
  parsearGastoFijoNatural,
  detectarConsultaPlan
} from './planAhorro.js';

const PLAN = { ingreso_base: null, pct_fijos: 50, pct_libres: 30, pct_ahorro: 20 };

const FIJOS = [
  { id: 1, nombre: 'Arriendo', monto: 350000, dia_pago: 5, categoria_id: 5, activo: true },
  { id: 2, nombre: 'Internet', monto: 20000, dia_pago: 10, categoria_id: null, activo: true }
];

describe('infoMes', () => {
  test('cuenta los días que quedan del mes, hoy incluido', () => {
    const m = infoMes('2026-11-18');

    expect(m.diasMes).toBe(30);
    expect(m.diasRestantes).toBe(13);
    expect(m.inicio).toBe('2026-11-01');
    expect(m.fin).toBe('2026-11-30');
  });

  test('el último día queda 1 y febrero bisiesto tiene 29 días', () => {
    expect(infoMes('2026-11-30').diasRestantes).toBe(1);
    expect(infoMes('2028-02-15').diasMes).toBe(29);
  });
});

describe('esGastoFijo', () => {
  test('cuenta como fijo por categoría o por nombre en la descripción', () => {
    expect(esGastoFijo({ descripcion: 'Transferencia propietario', categoria_id: 5 }, FIJOS)).toBe(true);
    expect(esGastoFijo({ descripcion: 'INTERNET Movistar', categoria_id: null }, FIJOS)).toBe(true);
    expect(esGastoFijo({ descripcion: 'Jumbo', categoria_id: 1 }, FIJOS)).toBe(false);
  });

  test('también calza por palabras clave', () => {
    const fijos = [{ nombre: 'Celular', monto: 20000, categoria_id: null, palabras_clave: 'Movistar, entel ,WOM', activo: true }];

    expect(esGastoFijo({ descripcion: 'Pago MOVISTAR octubre' }, fijos)).toBe(true);
    expect(esGastoFijo({ descripcion: 'recarga wom' }, fijos)).toBe(true);
    expect(esGastoFijo({ descripcion: 'Jumbo' }, fijos)).toBe(false);
  });

  test('ignora tildes y mayúsculas', () => {
    const fijos = [{ nombre: 'Educación', monto: 1000, categoria_id: null, activo: true }];
    expect(esGastoFijo({ descripcion: 'pago educacion marzo' }, fijos)).toBe(true);
  });
});

describe('gasto libre', () => {
  test('cuentan compra, transferencia a terceros y "otro" (con sentido cargo)', () => {
    expect(TIPOS_GASTO_LIBRE).toEqual(['compra', 'transferencia_terceros', 'otro']);
  });
});

describe('listaPalabrasClave', () => {
  test('separa por comas, quita vacíos y repetidos', () => {
    expect(listaPalabrasClave(' Movistar, entel ,, MOVISTAR , wom')).toEqual(['Movistar', 'entel', 'wom']);
    expect(listaPalabrasClave('')).toEqual([]);
    expect(listaPalabrasClave(null)).toEqual([]);
  });
});

describe('calcularPlan: un mes de ejemplo', () => {
  const gastos = [
    { descripcion: 'Pago arriendo noviembre', monto: 350000, categoria_id: 5 },
    { descripcion: 'Internet Movistar', monto: 20000, categoria_id: null },
    { descripcion: 'Jumbo', monto: 80000, categoria_id: 1 },
    { descripcion: 'Uber', monto: 20000, categoria_id: 2 }
  ];

  const r = calcularPlan({ plan: PLAN, gastosFijos: FIJOS, ingresosReales: 1000000, gastos, hoy: '2026-11-18' });

  test('ingreso, meta de ahorro y presupuestos', () => {
    expect(r.ingreso).toBe(1000000);
    expect(r.ingresoOrigen).toBe('real');
    expect(r.metaAhorro).toBe(200000);
    expect(r.fijos.presupuesto).toBe(500000);
    expect(r.fijos.real).toBe(370000);
    expect(r.libre.presupuesto).toBe(430000); // 1.000.000 - 200.000 - 370.000 (fijos reales)
  });

  test('separa lo fijo de lo libre en los gastos del mes', () => {
    expect(r.fijos.gastadoEsteMes).toBe(370000);
    expect(r.libre.gastado).toBe(100000);
    expect(r.libre.porcentajeUsado).toBe(23);
  });

  test('disponible y disponible por día', () => {
    expect(r.disponible).toBe(330000);
    expect(r.mes.diasRestantes).toBe(13);
    expect(r.disponiblePorDia).toBe(25385); // 330.000 / 13
  });

  test('sin alertas cuando todo va bien', () => {
    expect(r.alertas).toEqual([]);
  });

  test('el ingreso base, si está definido, reemplaza a los ingresos reales', () => {
    const conBase = calcularPlan({
      plan: { ...PLAN, ingreso_base: 1500000 },
      gastosFijos: FIJOS,
      ingresosReales: 1000000,
      gastos,
      hoy: '2026-11-18'
    });

    expect(conBase.ingreso).toBe(1500000);
    expect(conBase.ingresoOrigen).toBe('base');
    expect(conBase.metaAhorro).toBe(300000);
  });

  test('los gastos fijos inactivos no cuentan', () => {
    const conInactivo = calcularPlan({
      plan: PLAN,
      gastosFijos: [...FIJOS, { id: 3, nombre: 'Gimnasio', monto: 30000, activo: false }],
      ingresosReales: 1000000,
      gastos: [],
      hoy: '2026-11-18'
    });

    expect(conInactivo.fijos.real).toBe(370000);
    expect(conInactivo.fijos.cantidad).toBe(2);
  });
});

describe('calcularPlan: sin ingresos', () => {
  const r = calcularPlan({
    plan: PLAN,
    gastosFijos: [FIJOS[0]],
    ingresosReales: 0,
    gastos: [],
    hoy: '2026-11-18'
  });

  test('no hay meta ni disponible por día', () => {
    expect(r.ingreso).toBe(0);
    expect(r.metaAhorro).toBe(0);
    expect(r.disponible).toBe(-350000);
    expect(r.disponiblePorDia).toBe(0);
  });

  test('sugiere definir el ingreso base cuando no hay base ni ingresos reales', () => {
    const alerta = r.alertas.find(a => a.codigo === 'sin_ingresos');

    expect(alerta.mensaje).toContain('ingreso base');
    expect(alerta.mensaje).toContain('Define');
  });

  test('con ingreso base definido no se sugiere definirlo de nuevo', () => {
    const conBase = calcularPlan({
      plan: { ...PLAN, ingreso_base: 800000 },
      gastosFijos: [FIJOS[0]],
      ingresosReales: 0,
      gastos: [],
      hoy: '2026-11-18'
    });

    expect(conBase.alertas.map(a => a.codigo)).not.toContain('sin_ingresos');
    expect(conBase.ingreso).toBe(800000);
  });

  test('avisa que faltan ingresos y que el ahorro está en riesgo', () => {
    const codigos = r.alertas.map(a => a.codigo);

    expect(codigos).toContain('sin_ingresos');
    expect(codigos).toContain('ahorro_en_riesgo');
    // Sin gastos libres no hay "gasto libre sobre el 100%"
    expect(codigos).not.toContain('libre_sobre_100');
  });
});

describe('validarPorcentajes', () => {
  test('acepta porcentajes que suman 100', () => {
    expect(validarPorcentajes({ pct_fijos: 50, pct_libres: 30, pct_ahorro: 20 }).ok).toBe(true);
    expect(validarPorcentajes({ pct_fijos: '40', pct_libres: '40', pct_ahorro: '20' }).ok).toBe(true);
    expect(validarPorcentajes({ pct_fijos: 33.3, pct_libres: 33.3, pct_ahorro: 33.4 }).ok).toBe(true);
  });

  test('rechaza porcentajes que no suman 100', () => {
    const r = validarPorcentajes({ pct_fijos: 50, pct_libres: 30, pct_ahorro: 30 });

    expect(r.ok).toBe(false);
    expect(r.error).toContain('sumar 100');
    expect(r.error).toContain('110');
  });

  test('rechaza valores faltantes, negativos o fuera de rango', () => {
    expect(validarPorcentajes({ pct_fijos: 50, pct_libres: 50 }).ok).toBe(false);
    expect(validarPorcentajes({ pct_fijos: -10, pct_libres: 60, pct_ahorro: 50 }).ok).toBe(false);
    expect(validarPorcentajes({ pct_fijos: 120, pct_libres: -10, pct_ahorro: -10 }).ok).toBe(false);
  });
});

describe('calcularPlan: gasto libre excedido', () => {
  test('sobre el 100% del presupuesto libre y ahorro en riesgo', () => {
    const r = calcularPlan({
      plan: PLAN,
      gastosFijos: FIJOS,
      ingresosReales: 1000000,
      gastos: [{ descripcion: 'Compras varias', monto: 450000, categoria_id: 1 }],
      hoy: '2026-11-18'
    });

    expect(r.libre.presupuesto).toBe(430000);
    expect(r.libre.gastado).toBe(450000);
    expect(r.libre.porcentajeUsado).toBe(105);
    expect(r.disponible).toBe(-20000);
    expect(r.disponiblePorDia).toBe(0);

    const codigos = r.alertas.map(a => a.codigo);
    expect(codigos).toContain('libre_sobre_100');
    expect(codigos).toContain('ahorro_en_riesgo');
    expect(codigos).not.toContain('libre_sobre_80');
  });

  test('entre el 80% y el 100% solo avisa del 80%', () => {
    const r = calcularPlan({
      plan: PLAN,
      gastosFijos: FIJOS,
      ingresosReales: 1000000,
      gastos: [{ descripcion: 'Compras varias', monto: 360000, categoria_id: 1 }],
      hoy: '2026-11-18'
    });

    const codigos = r.alertas.map(a => a.codigo);
    expect(codigos).toContain('libre_sobre_80');
    expect(codigos).not.toContain('libre_sobre_100');
    expect(codigos).not.toContain('ahorro_en_riesgo');
  });

  test('avisa cuando los fijos superan su porcentaje', () => {
    const r = calcularPlan({
      plan: PLAN,
      gastosFijos: [{ nombre: 'Arriendo', monto: 600000, categoria_id: null, activo: true }],
      ingresosReales: 1000000,
      gastos: [],
      hoy: '2026-11-18'
    });

    expect(r.alertas.map(a => a.codigo)).toContain('fijos_sobre_porcentaje');
  });
});

describe('calcularPlan: compras en cuotas', () => {
  const cuotas = [{ id: 1, alias: 'mac', monto_cuota: 85000 }];

  test('las cuotas en curso cuentan como gasto fijo del mes', () => {
    const r = calcularPlan({ plan: PLAN, gastosFijos: FIJOS, cuotas, ingresosReales: 1000000, gastos: [], hoy: '2026-11-18' });

    expect(r.fijos.real).toBe(455000); // 350.000 + 20.000 + 85.000
    expect(r.fijos.cuotas).toEqual({ cantidad: 1, monto: 85000 });
    expect(r.libre.presupuesto).toBe(345000);
  });

  test('no se duplican si ya existe un gasto fijo con ese nombre', () => {
    const fijos = [...FIJOS, { id: 9, nombre: 'Mac', monto: 85000, categoria_id: null, activo: true }];
    const r = calcularPlan({ plan: PLAN, gastosFijos: fijos, cuotas, ingresosReales: 1000000, gastos: [], hoy: '2026-11-18' });

    expect(r.fijos.real).toBe(455000);
    expect(r.fijos.cuotas.cantidad).toBe(0);
  });

  test('el pago de una cuota (ligado a su compra) cuenta como fijo y no como gasto libre', () => {
    const gastos = [
      { descripcion: 'Cuota 7/12 mac (tía)', monto: 85000, categoria_id: null, compra_cuota_id: 1 },
      { descripcion: 'Transferencia a Pedro', monto: 20000, categoria_id: null, compra_cuota_id: null }
    ];
    const r = calcularPlan({ plan: PLAN, gastosFijos: FIJOS, cuotas, ingresosReales: 1000000, gastos, hoy: '2026-11-18' });

    expect(r.fijos.gastadoEsteMes).toBe(85000);
    expect(r.libre.gastado).toBe(20000);
  });
});

describe('validarGastoFijo', () => {
  test('acepta un gasto fijo válido', () => {
    const r = validarGastoFijo({ nombre: ' Arriendo ', monto: 350000, dia_pago: 5, categoria_id: null });

    expect(r.ok).toBe(true);
    expect(r.valores).toEqual({
      nombre: 'Arriendo', monto: 350000, dia_pago: 5, categoria_id: null, cuenta_id: null, palabras_clave: null
    });
  });

  test('normaliza las palabras clave', () => {
    const r = validarGastoFijo({ nombre: 'Celular', monto: 20000, palabras_clave: ' movistar,, entel , Movistar' });

    expect(r.ok).toBe(true);
    expect(r.valores.palabras_clave).toBe('movistar, entel');
  });

  test('rechaza datos inválidos', () => {
    expect(validarGastoFijo({ nombre: '', monto: 1000 }).ok).toBe(false);
    expect(validarGastoFijo({ nombre: 'Luz', monto: 0 }).ok).toBe(false);
    expect(validarGastoFijo({ nombre: 'Luz', monto: 1000, dia_pago: 40 }).ok).toBe(false);
  });
});

describe('parsearFijo', () => {
  test('"arriendo 350 mil el 5"', () => {
    expect(parsearFijo('/fijo arriendo 350 mil el 5')).toEqual({
      nombre: 'Arriendo', monto: 350000, diaPago: 5, palabrasClave: null
    });
  });

  test('montos con puntos y sin día de pago', () => {
    expect(parsearFijo('internet 25.990')).toEqual({ nombre: 'Internet', monto: 25990, diaPago: null, palabrasClave: null });
  });

  test('con palabras clave opcionales', () => {
    expect(parsearFijo('/fijo celular 20 mil el 10 palabras movistar, entel')).toEqual({
      nombre: 'Celular', monto: 20000, diaPago: 10, palabrasClave: 'movistar, entel'
    });
    expect(parsearFijo('celular 20 mil palabras clave: movistar')).toMatchObject({ nombre: 'Celular', palabrasClave: 'movistar' });
  });

  test('sin monto reconocible', () => {
    expect(parsearFijo('/fijo arriendo').monto).toBeNull();
  });
});

describe('detectarConsultaPlan', () => {
  test('detecta las frases sin comando', () => {
    expect(detectarConsultaPlan('cuánto puedo gastar')).toBe(true);
    expect(detectarConsultaPlan('Cuánto me queda este mes?')).toBe(true);
    expect(detectarConsultaPlan('cuánto debería ahorrar')).toBe(true);
  });

  test('nunca si el mensaje trae un monto o un número', () => {
    expect(detectarConsultaPlan('cuánto me queda si gasto 5 mil')).toBe(false);
    expect(detectarConsultaPlan('pagué 5 mil en uber')).toBe(false);
    expect(detectarConsultaPlan('/plan')).toBe(false);
  });
});

describe('gasto fijo en lenguaje natural', () => {
  test('"Gasto fijo: 24 mil en telefonía, lo pago a Vivian"', () => {
    expect(parsearGastoFijoNatural('Gasto fijo: 24 mil en telefonía, lo pago a Vivian')).toEqual({
      nombre: 'Telefonía', monto: 24000, diaPago: null, destinatario: 'Vivian', palabrasClave: null
    });
  });

  test('"fijo 15.990 netflix" y "gasto fijo 24k internet"', () => {
    expect(parsearGastoFijoNatural('fijo 15.990 netflix')).toMatchObject({ nombre: 'Netflix', monto: 15990, destinatario: null });
    // La misma forma que /fijo: destinatario con "a" y día con "el", y palabras clave al final
    expect(parsearGastoFijoNatural('fijo 24000 telefonía a Vivian el 5')).toEqual({
      nombre: 'Telefonía', monto: 24000, diaPago: 5, destinatario: 'Vivian', palabrasClave: null
    });
    expect(parsearGastoFijoNatural('fijo celular 20 mil el 10 palabras movistar, entel')).toMatchObject({
      nombre: 'Celular', monto: 20000, diaPago: 10, destinatario: null, palabrasClave: 'movistar, entel'
    });
    expect(parsearGastoFijoNatural('gasto fijo 24k internet')).toMatchObject({ nombre: 'Internet', monto: 24000 });
  });

  test('con verbo, destinatario con "Don" y día del mes', () => {
    expect(parsearGastoFijoNatural('agrega gasto fijo de 350 mil arriendo, se lo pago a Don Pedro el 5 de cada mes')).toEqual({
      nombre: 'Arriendo', monto: 350000, diaPago: 5, destinatario: 'Don Pedro', palabrasClave: null
    });
  });

  test('"pago fijo 24000 telefonía a Vivian"', () => {
    expect(parsearGastoFijoNatural('pago fijo 24000 telefonía a Vivian')).toMatchObject({ nombre: 'Telefonía', monto: 24000, destinatario: 'Vivian' });
  });

  test('si falta el monto o la descripción lo deja en null para preguntarlo', () => {
    expect(parsearGastoFijoNatural('gasto fijo luz')).toMatchObject({ nombre: 'Luz', monto: null });
    expect(parsearGastoFijoNatural('fijo 24 mil')).toMatchObject({ nombre: null, monto: 24000 });
    expect(parsearGastoFijoNatural('fijo')).toMatchObject({ nombre: null, monto: null });
  });

  test('no se confunde con consultas ni con gastos', () => {
    expect(parsearGastoFijoNatural('mis gastos fijos')).toBeNull();
    expect(parsearGastoFijoNatural('cuánto tengo en gastos fijos')).toBeNull();
    expect(parsearGastoFijoNatural('almuerzo 5500')).toBeNull();
    expect(parsearGastoFijoNatural('/fijos')).toBeNull();
  });
});

describe('destinatario del gasto fijo y pago marcado', () => {
  test('el destinatario se valida solo si viene y no admite números de cuenta', () => {
    expect(validarGastoFijo({ nombre: 'Telefonía', monto: 24000, destinatario: 'Vivian', destinatario_id: 3 }).valores)
      .toMatchObject({ destinatario: 'Vivian', destinatario_id: 3 });
    expect(validarGastoFijo({ nombre: 'Telefonía', monto: 24000 }).valores).not.toHaveProperty('destinatario');
    expect(validarGastoFijo({ nombre: 'Telefonía', monto: 24000, destinatario: 'Vivian 12345678' }).ok).toBe(false);
  });

  test('una transferencia marcada como pago de un gasto fijo cuenta como fija, no como libre', () => {
    const fijos = [{ id: 1, nombre: 'Telefonía', monto: 24000, activo: true }];
    expect(esGastoFijo({ descripcion: 'TRANSFERENCIA A VIVIAN', monto: 25000, gasto_fijo_id: 1 }, fijos)).toBe(true);
    expect(esGastoFijo({ descripcion: 'TRANSFERENCIA A VIVIAN', monto: 25000, gasto_fijo_id: null }, fijos)).toBe(false);
  });
});
