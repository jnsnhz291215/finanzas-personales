import { aliasDisponible } from './cuotas.js';

describe('nombre de una compra en cuotas nueva', () => {
  test('si el nombre está libre, se usa tal cual', () => {
    expect(aliasDisponible('Apple', 21749, [{ alias: 'Macbook' }])).toBe('Apple');
  });

  test('si otra compra del mismo acreedor ya se llama así, queda "Apple ($21.749)"', () => {
    expect(aliasDisponible('Apple', 21749, [{ alias: 'Apple' }])).toBe('Apple ($21.749)');
    expect(aliasDisponible('Weplay web', 66957, [{ alias: 'Weplay web' }])).toBe('Weplay web ($66.957)');
  });

  test('si ese nombre también existe, agrega un número', () => {
    expect(aliasDisponible('Apple', 21749, [{ alias: 'Apple' }, { alias: 'Apple ($21.749)' }])).toBe('Apple ($21.749) 2');
  });
});
