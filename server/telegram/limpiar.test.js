import { elegirMensajes } from './mensajesChat.js';
import { esPeticionConservar } from './limpiarBot.js';

const borrables = [60, 59, 58, 57, 56, 55, 54, 53].map(id => ({ message_id: id, origen: 'bot' }));

describe('qué mensajes borra /limpiar', () => {
  test('sin conservar borra todos los que se pueden y también la orden y su pregunta', () => {
    const r = elegirMensajes(borrables, { conservar: 0, excluir: [61, 62] });
    expect(r.borrar).toEqual([62, 61, 60, 59, 58, 57, 56, 55, 54, 53]);
    expect(r.conservados).toEqual([]);
  });

  test('"todo menos lo último" deja los 5 más recientes sin contar la orden ni su pregunta', () => {
    const r = elegirMensajes(borrables, { conservar: 5, excluir: [61, 62] });
    expect(r.conservados).toEqual([60, 59, 58, 57, 56]);
    expect(r.borrar).toEqual([62, 61, 55, 54, 53]);
  });

  test('reconoce la petición de conservar los últimos', () => {
    expect(esPeticionConservar('todo menos lo último')).toBe(true);
    expect(esPeticionConservar('Todo menos lo ultimo')).toBe(true);
    expect(esPeticionConservar('todo')).toBe(false);
  });
});
