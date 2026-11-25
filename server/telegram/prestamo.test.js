import { detectarPrestamo } from './prestamo.js';

describe('detectarPrestamo', () => {
  test('"le pagué 15 mil a Christian con la CMR, me lo devuelve"', () => {
    expect(detectarPrestamo('le pagué 15 mil a Christian con la CMR, me lo devuelve'))
      .toEqual({ esPrestamo: true, persona: 'Christian' });
  });

  test('"le presté 20 mil a Pedro Soto"', () => {
    expect(detectarPrestamo('le presté 20 mil a Pedro Soto')).toEqual({ esPrestamo: true, persona: 'Pedro Soto' });
  });

  test('"Pedro me debe 20 mil"', () => {
    expect(detectarPrestamo('Pedro me debe 20 mil')).toEqual({ esPrestamo: true, persona: 'Pedro' });
  });

  test('un préstamo sin nombre propio deja la persona sin indicar', () => {
    expect(detectarPrestamo('pagué 15 mil en la farmacia, me lo devuelve')).toEqual({ esPrestamo: true, persona: null });
  });

  test('un gasto normal no es préstamo', () => {
    expect(detectarPrestamo('pagué 5 mil en uber')).toEqual({ esPrestamo: false, persona: null });
    expect(detectarPrestamo('pagué 5 mil a Jumbo')).toEqual({ esPrestamo: false, persona: null });
  });
});
