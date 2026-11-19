import { interpretarBusqueda, separarReglaYCategoria } from './gestion.js';

const HOY = '2026-11-18';

describe('interpretarBusqueda', () => {
  test('solo texto: sin rango de fechas y conservando tildes', () => {
    expect(interpretarBusqueda('Café Starbucks', HOY)).toEqual({
      texto: 'Café Starbucks', desde: null, hasta: null, etiquetaMes: null
    });
  });

  test('un mes por nombre usa el año más reciente que no sea futuro', () => {
    expect(interpretarBusqueda('noviembre', HOY)).toMatchObject({ texto: null, desde: '2026-11-01', hasta: '2026-11-30' });
    expect(interpretarBusqueda('diciembre', HOY)).toMatchObject({ desde: '2025-12-01', hasta: '2025-12-31' });
  });

  test('texto y mes juntos', () => {
    const r = interpretarBusqueda('uber octubre 2026', HOY);

    expect(r.texto).toBe('uber');
    expect(r.desde).toBe('2026-10-01');
    expect(r.hasta).toBe('2026-10-31');
  });

  test('formatos 2026-11, 11/2026, este mes y mes pasado', () => {
    expect(interpretarBusqueda('2026-02', HOY)).toMatchObject({ desde: '2026-02-01', hasta: '2026-02-28' });
    expect(interpretarBusqueda('11/2026', HOY)).toMatchObject({ desde: '2026-11-01' });
    expect(interpretarBusqueda('este mes', HOY)).toMatchObject({ desde: '2026-11-01' });
    expect(interpretarBusqueda('mes pasado', HOY)).toMatchObject({ desde: '2026-10-01', hasta: '2026-10-31' });
    expect(interpretarBusqueda('mes pasado', '2026-01-10')).toMatchObject({ desde: '2025-12-01' });
  });
});

describe('separarReglaYCategoria', () => {
  const categorias = [
    { id: 1, nombre: 'Transporte' },
    { id: 2, nombre: 'Cuentas y Servicios' },
    { id: 3, nombre: 'Salud' }
  ];

  test('"uber transporte" -> texto uber, categoría Transporte', () => {
    expect(separarReglaYCategoria('uber transporte', categorias)).toEqual({ texto: 'uber', categoria: categorias[0] });
  });

  test('texto de varias palabras y categoría de varias palabras', () => {
    expect(separarReglaYCategoria('pedidos ya cuentas y servicios', categorias)).toEqual({
      texto: 'pedidos ya', categoria: categorias[1]
    });
  });

  test('ignora tildes y mayúsculas', () => {
    expect(separarReglaYCategoria('farmacia SALUD', categorias).categoria).toBe(categorias[2]);
  });

  test('sin categoría reconocible', () => {
    expect(separarReglaYCategoria('uber taxis', categorias)).toEqual({ texto: 'uber taxis', categoria: null });
  });
});
