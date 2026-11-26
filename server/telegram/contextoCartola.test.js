import { leerContextoCartola, contextoUtil, cruzarContextoConCuentas } from './contextoCartola.js';
import { separarDuplicados, claveMovimiento } from '../cartolas.js';
import { candidatoVinculo, describirContexto } from './cartolasBot.js';

const cuentas = [
  { id: 1, nombre: 'Crédito Valeska ****8263', tipo: 'tarjeta_credito', ultimos4: '8263', ultimos4_cuenta: '5555', titular: 'Valeska Sanhueza' },
  { id: 2, nombre: 'Débito Juan ****1111', tipo: 'tarjeta_debito', ultimos4: '1111', ultimos4_cuenta: null, titular: null }
];

describe('leerContextoCartola', () => {
  test('"son de la tarjeta 8263" trae los dígitos', () => {
    const c = leerContextoCartola('son de la tarjeta 8263');
    expect(c.esCartola).toBe(true);
    expect(c.digitos).toBe('8263');
  });

  test('"cartola de la 8263"', () => {
    expect(leerContextoCartola('cartola de la 8263')).toMatchObject({ esCartola: true, digitos: '8263', mencionaCartola: true });
  });

  test('"es de la crédito de Valeska" trae tipo y titular', () => {
    expect(leerContextoCartola('es de la crédito de Valeska')).toMatchObject({ esCartola: true, tipo: 'credito', titular: 'Valeska', digitos: null });
  });

  test('un número largo se reduce a sus 4 últimos dígitos', () => {
    const c = leerContextoCartola('cartola de la tarjeta 4513 1234 5678 8263');
    expect(c.digitos).toBe('8263');
    expect(c.numeroLargo).toBe(true);
  });

  test('un gasto cualquiera no es una cartola', () => {
    expect(leerContextoCartola('almuerzo 5500 débito').esCartola).toBe(false);
    expect(leerContextoCartola('/cuentas').esCartola).toBe(false);
  });

  test('contextoUtil pide dígitos, tipo o titular', () => {
    expect(contextoUtil(leerContextoCartola('cartola de la 8263'))).toBe(true);
    expect(contextoUtil(leerContextoCartola('mira la cartola'))).toBe(false);
  });
});

describe('cruzarContextoConCuentas', () => {
  test('coincide cuando la cartola trae los mismos dígitos', () => {
    const r = cruzarContextoConCuentas(leerContextoCartola('cartola de la 8263'), cuentas, ['8263']);
    expect(r.estado).toBe('coincide');
    expect(r.cuenta.id).toBe(1);
  });

  test('se confía en el texto si la cartola no trae dígitos', () => {
    expect(cruzarContextoConCuentas(leerContextoCartola('cartola de la 8263'), cuentas, []).estado).toBe('segun_texto');
  });

  test('no coincide si el archivo trae otros dígitos', () => {
    const r = cruzarContextoConCuentas(leerContextoCartola('cartola de la 8263'), cuentas, ['1111']);
    expect(r.estado).toBe('no_coincide');
    expect(r.otraCuenta.id).toBe(2);
  });

  test('sin cuenta con esos dígitos', () => {
    expect(cruzarContextoConCuentas(leerContextoCartola('cartola de la 9999'), cuentas, []).estado).toBe('sin_cuenta');
  });

  test('sin dígitos se usa tipo y titular si hay una sola cuenta', () => {
    const r = cruzarContextoConCuentas(leerContextoCartola('es de la crédito de Valeska'), cuentas, []);
    expect(r.estado).toBe('segun_texto');
    expect(r.cuenta.id).toBe(1);
  });
});

describe('vínculo de cuenta', () => {
  test('ofrece actualizar si la cartola trae otra cuenta distinta de la vinculada', () => {
    expect(candidatoVinculo([{ digitos: '7777', tipo: 'cuenta' }], cuentas[0], cuentas)).toEqual({ digitos: '7777', tipo: 'cuenta', reemplaza: '5555' });
  });

  test('no ofrece nada si es la misma o si es de otra cuenta', () => {
    expect(candidatoVinculo([{ digitos: '5555', tipo: 'cuenta' }], cuentas[0], cuentas)).toBeNull();
    expect(candidatoVinculo([{ digitos: '1111', tipo: 'cuenta' }], cuentas[0], cuentas)).toBeNull();
  });

  test('describirContexto', () => {
    expect(describirContexto(leerContextoCartola('es de la crédito 8263 de Valeska'))).toBe('crédito ****8263 de Valeska');
  });
});

describe('cartolas que se traslapan', () => {
  const mov = (fecha, descripcion, monto) => ({ fecha, descripcion, monto, tipo: 'cargo' });

  test('descarta los movimientos que ya estaban y cuenta cuántos', () => {
    const existentes = [mov('2026-05-02', 'Mercado Libre 06/12', 20000)];
    const { nuevos, duplicados } = separarDuplicados([mov('2026-05-02', 'MERCADO LIBRE  06/12', 20000), mov('2026-05-03', 'Uber', 5000)], existentes);
    expect(duplicados).toBe(1);
    expect(nuevos).toHaveLength(1);
  });

  test('dos compras iguales en la cartola siguen siendo dos si no había ninguna', () => {
    const { nuevos, duplicados } = separarDuplicados([mov('2026-05-02', 'Café', 2000), mov('2026-05-02', 'Café', 2000)], []);
    expect(nuevos).toHaveLength(2);
    expect(duplicados).toBe(0);
  });

  test('si ya había una de las dos, entra solo la otra', () => {
    const { nuevos } = separarDuplicados([mov('2026-05-02', 'Café', 2000), mov('2026-05-02', 'Café', 2000)], [mov('2026-05-02', 'Café', 2000)]);
    expect(nuevos).toHaveLength(1);
  });

  test('cuotas distintas del mismo comercio no se confunden', () => {
    expect(claveMovimiento(mov('2026-05-02', 'Tienda 06/12', 1000))).not.toBe(claveMovimiento(mov('2026-05-02', 'Tienda 07/12', 1000)));
  });
});
