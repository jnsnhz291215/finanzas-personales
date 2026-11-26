import { botonCerrar, conCerrar, CALLBACK_CERRAR, nombresDistinguibles } from './cerrar.js';

const dinero = (n) => `$${Number(n).toLocaleString('es-CL')}`;

describe('botón Cerrar común', () => {
  test('agrega la fila Cerrar al final con un único callback', () => {
    const filas = conCerrar([[{ text: 'A', callback_data: 'a' }]]);
    expect(filas).toHaveLength(2);
    expect(filas[1]).toEqual(botonCerrar());
    expect(filas[1][0].callback_data).toBe(CALLBACK_CERRAR);
  });
});

describe('nombres de los botones de /cuotas', () => {
  test('compras con el mismo nombre se distinguen por el valor de la cuota', () => {
    const compras = [
      { id: 1, alias: 'Apple', monto_cuota: 202332 },
      { id: 2, alias: 'Apple', monto_cuota: 21749 },
      { id: 3, alias: 'Weplay web', monto_cuota: 13915 }
    ];
    expect(nombresDistinguibles(compras, dinero)).toEqual(['Apple ($202.332)', 'Apple ($21.749)', 'Weplay web']);
  });

  test('si el nombre ya trae el valor no se repite, y si aun así coincide se agrega el número', () => {
    expect(nombresDistinguibles([
      { id: 1, alias: 'Apple', monto_cuota: 100 }, { id: 2, alias: 'Apple ($21.749)', monto_cuota: 21749 }, { id: 3, alias: 'Apple', monto_cuota: 100 }
    ], dinero)).toEqual(['Apple ($100) #1', 'Apple ($21.749)', 'Apple ($100) #3']);
  });
});
