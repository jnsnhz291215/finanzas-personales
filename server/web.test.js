import { decidirWeb, esLoopback } from './web.js';

describe('decidirWeb', () => {
  test('por defecto la web está deshabilitada', () => {
    expect(decidirWeb({}).habilitada).toBe(false);
    expect(decidirWeb({ WEB_HABILITADA: 'false' }).habilitada).toBe(false);
    expect(decidirWeb({ WEB_HABILITADA: 'si' }).habilitada).toBe(false);
  });

  test('habilitada escucha en 127.0.0.1 y en PORT (3005 por defecto)', () => {
    const w = decidirWeb({ WEB_HABILITADA: 'true', ADMIN_PASSWORD: 'una-clave-real' });
    expect(w).toEqual({ habilitada: true, host: '127.0.0.1', puerto: 3005, bloqueo: null });
    expect(decidirWeb({ WEB_HABILITADA: 'TRUE', ADMIN_PASSWORD: 'x1', PORT: '4000', HOST: 'localhost' })).toMatchObject({ host: 'localhost', puerto: 4000, bloqueo: null });
  });

  test('sin ADMIN_PASSWORD o con la de ejemplo no arranca', () => {
    expect(decidirWeb({ WEB_HABILITADA: 'true' }).bloqueo).toMatch(/ADMIN_PASSWORD/);
    expect(decidirWeb({ WEB_HABILITADA: 'true', ADMIN_PASSWORD: 'cambiar123' }).bloqueo).toMatch(/ADMIN_PASSWORD/);
    expect(decidirWeb({ WEB_HABILITADA: 'true', ADMIN_PASSWORD: '  ' }).bloqueo).toMatch(/ADMIN_PASSWORD/);
  });

  test('nunca en 0.0.0.0 ni ::', () => {
    expect(decidirWeb({ WEB_HABILITADA: 'true', ADMIN_PASSWORD: 'x1', HOST: '0.0.0.0' }).bloqueo).toMatch(/0\.0\.0\.0/);
    expect(decidirWeb({ WEB_HABILITADA: 'true', ADMIN_PASSWORD: 'x1', HOST: '::' }).bloqueo).toMatch(/HOST/);
  });
});

describe('esLoopback', () => {
  test('solo direcciones de este equipo', () => {
    for (const h of ['127.0.0.1', '127.1.2.3', 'localhost', '::1', '[::1]']) expect(esLoopback(h)).toBe(true);
    for (const h of ['0.0.0.0', '::', '192.168.1.5', '10.0.0.2', '', undefined]) expect(esLoopback(h)).toBe(false);
  });
});
