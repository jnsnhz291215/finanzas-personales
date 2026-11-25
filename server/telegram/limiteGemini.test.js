import { crearLimitador, LIMITE_POR_HORA } from './limiteGemini.js';

describe('crearLimitador', () => {
  test('el límite por defecto es de 30 llamadas por hora', () => {
    expect(LIMITE_POR_HORA).toBe(30);
  });

  test('permite hasta el límite y luego rechaza', () => {
    const limitador = crearLimitador({ limite: 3 });

    expect(limitador.consumir(1)).toBe(true);
    expect(limitador.consumir(1)).toBe(true);
    expect(limitador.consumir(1)).toBe(true);
    expect(limitador.consumir(1)).toBe(false);
    expect(limitador.restantes(1)).toBe(0);
  });

  test('cada chat tiene su propio contador', () => {
    const limitador = crearLimitador({ limite: 1 });

    expect(limitador.consumir(1)).toBe(true);
    expect(limitador.consumir(1)).toBe(false);
    expect(limitador.consumir(2)).toBe(true);
  });

  test('la ventana es deslizante: pasada una hora vuelve a permitir', () => {
    let ahora = 1000000;
    const limitador = crearLimitador({ limite: 2, ahora: () => ahora });

    limitador.consumir(1);
    ahora += 30 * 60 * 1000;
    limitador.consumir(1);
    expect(limitador.consumir(1)).toBe(false);

    // Pasan 31 minutos más: la primera llamada ya salió de la ventana
    ahora += 31 * 60 * 1000;
    expect(limitador.restantes(1)).toBe(1);
    expect(limitador.consumir(1)).toBe(true);
    expect(limitador.consumir(1)).toBe(false);
  });

  test('una llamada rechazada no se cuenta', () => {
    const limitador = crearLimitador({ limite: 1 });

    limitador.consumir(1);
    limitador.consumir(1);
    limitador.consumir(1);
    expect(limitador.restantes(1)).toBe(0);
  });
});
