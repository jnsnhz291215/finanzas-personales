import { parsearRenombrar, parsearAgrupar, buscarPorReferencia, montoCalza } from './cuotasGestion.js';
import { interpretarDeuda, opcionesDeudaNueva } from './deudasTexto.js';
import { lineasListaCuotas, nombreConReal } from './cuotas.js';

describe('renombrar una compra en cuotas', () => {
  test('frase con verbo, forma corta y comando', () => {
    expect(parsearRenombrar('renombra la cuota Apple de 21.749 a AppleCare')).toMatchObject({ ref: { nombre: 'apple', monto: 21749 }, nuevo: 'AppleCare' });
    expect(parsearRenombrar('la de apple de 202 mil es el Mac')).toMatchObject({ ref: { nombre: 'apple', monto: 202000 }, nuevo: 'Mac' });
    expect(parsearRenombrar('/renombrarcuota Apple 21.749 a AppleCare')).toMatchObject({ ref: { nombre: 'apple', monto: 21749 }, nuevo: 'AppleCare', esComando: true });
  });

  test('la referencia distingue dos compras del mismo comercio por el valor de la cuota', () => {
    const compras = [
      { id: 1, alias: 'apple', monto_cuota: 202332 },
      { id: 2, alias: 'apple', monto_cuota: 21749 },
      { id: 3, alias: 'weplay web', monto_cuota: 13915 }
    ];
    expect(buscarPorReferencia(compras, { nombre: 'apple', monto: 21749 }).map(c => c.id)).toEqual([2]);
    expect(buscarPorReferencia(compras, { nombre: 'apple', monto: 202000 }).map(c => c.id)).toEqual([1]);
    expect(buscarPorReferencia(compras, { nombre: 'apple', monto: null }).map(c => c.id)).toEqual([1, 2]);
    expect(montoCalza(202332, 202000)).toBe(true);
    expect(montoCalza(202332, 150000)).toBe(false);
  });

  test('muestra el nombre mostrado y, entre paréntesis, el real', () => {
    expect(nombreConReal({ alias: 'apple', nombre_mostrar: 'Mac' })).toBe('Mac (Apple)');
    expect(nombreConReal({ alias: 'apple', nombre_mostrar: null })).toBe('Apple');
  });
});

describe('agrupar compras en cuotas', () => {
  test('frases y comando', () => {
    expect(parsearAgrupar('junta Apple 202.332 y Apple 21.749 como Mac')).toMatchObject({ tipo: 'agrupar', grupo: 'Mac', refs: [{ nombre: 'apple', monto: 202332 }, { nombre: 'apple', monto: 21749 }] });
    expect(parsearAgrupar('el AppleCare es parte del Mac')).toMatchObject({ tipo: 'parte', ref: { nombre: 'applecare' }, grupo: 'Mac' });
    expect(parsearAgrupar('/agruparcuotas desagrupar Mac')).toEqual({ tipo: 'desagrupar', nombre: 'Mac' });
  });

  test('/cuotas muestra el grupo con su total y debajo cada compra con su avance', () => {
    const dinero = (n) => `$${Number(n).toLocaleString('es-CL')}`;
    const compras = [
      { id: 1, alias: 'apple', nombre_mostrar: 'Mac', acreedor: 'Valeska', monto_cuota: 202332, total_cuotas: 12, cuotas_pagadas: 7, grupo_id: 5 },
      { id: 2, alias: 'applecare', acreedor: 'Valeska', monto_cuota: 21749, total_cuotas: 12, cuotas_pagadas: 7, grupo_id: 5 }
    ];
    const texto = lineasListaCuotas(compras, new Map(), dinero, (t) => t, [{ id: 5, nombre: 'mac', acreedor: 'Valeska' }]).join('\n');
    expect(texto).toContain('Mac · cuota $224.081');
    expect(texto).toContain('Mac (Apple) 7/12 $202.332');
    expect(texto).toContain('Applecare 7/12 $21.749');
  });
});

describe('deudas con abonos libres', () => {
  test('crear, abono y transferencia con lo que queda', () => {
    expect(interpretarDeuda('le debo 300 mil a mi mamá')).toEqual({ tipo: 'crear', persona: 'Mamá', total: 300000 });
    expect(interpretarDeuda('abono 20 mil a la deuda de mi mamá')).toMatchObject({ tipo: 'abono', persona: 'Mamá', monto: 20000, esTransferencia: false });
    expect(interpretarDeuda('le transferí 50 mil a mi mamá de una cuota, son 50 de 300.000 que me quedan'))
      .toMatchObject({ tipo: 'abono', persona: 'Mamá', monto: 50000, antes: 300000, esTransferencia: true });
    expect(interpretarDeuda('le transferí 50 mil a mi mamá, me quedan 300 mil')).toMatchObject({ monto: 50000, despues: 300000 });
  });

  test('una transferencia normal no es un abono', () => {
    expect(interpretarDeuda('le transferí 50 mil a Pedro por el asado')).toBeNull();
  });

  test('opciones al crear la deuda desde un abono', () => {
    expect(opcionesDeudaNueva({ monto: 50000, antes: 300000 })).toEqual([
      { id: 'a', total: 300000, abonar: true, pendiente: 250000 },
      { id: 'b', total: 250000, abonar: false, pendiente: 250000 }
    ]);
    expect(opcionesDeudaNueva({ monto: 50000, despues: 300000 })).toEqual([
      { id: 'a', total: 350000, abonar: true, pendiente: 300000 },
      { id: 'b', total: 300000, abonar: false, pendiente: 300000 }
    ]);
  });
});
