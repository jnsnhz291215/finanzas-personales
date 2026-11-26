import { describirError, clasificarError, sanear } from './errores.js';

const sinLog = { registrar: false };

describe('describirError', () => {
  test('un corte de red al descargar dice qué archivo y pide reenviarlo', () => {
    const err = new TypeError('fetch failed');
    err.cause = Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' });
    const r = describirError(err, 'descargar', 'Estado_Cuenta (09-2026).pdf', sinLog);
    expect(r.plano).toBe('No pude descargar Estado_Cuenta (09-2026).pdf desde Telegram: se cortó la conexión. Reenvíalo.');
    expect(r.tipo).toBe('red');
  });

  test('un timeout se distingue de un corte de red', () => {
    const err = Object.assign(new Error('x'), { name: 'TimeoutError' });
    expect(clasificarError(err).tipo).toBe('timeout');
    expect(clasificarError(Object.assign(new Error('connect'), { code: 'ETIMEDOUT' })).tipo).toBe('timeout');
  });

  test('un duplicado al crear una compra dice que ya existe una con ese nombre', () => {
    const err = Object.assign(new Error('Duplicate entry'), { code: 'ER_DUP_ENTRY' });
    expect(describirError(err, 'crear_compra', '«Apple» ($21.749)', sinLog).plano).toBe('No pude crear «Apple» ($21.749): ya existe una compra igual.');
    expect(clasificarError(Object.assign(new Error('x'), { code: 'SQLITE_CONSTRAINT_UNIQUE' })).tipo).toBe('duplicado');
  });

  test('errores de PDF, formato y cuenta', () => {
    expect(clasificarError(Object.assign(new Error('Invalid PDF structure'), { name: 'InvalidPDFException' })).tipo).toBe('pdf');
    expect(clasificarError(Object.assign(new Error('x'), { codigoApp: 'FORMATO_NO_RECONOCIDO' })).tipo).toBe('formato');
    expect(clasificarError(Object.assign(new Error('x'), { codigoApp: 'CUENTA_NO_ENCONTRADA' })).tipo).toBe('cuenta');
  });

  test('un error desconocido muestra el paso y el mensaje técnico corto, sin rutas ni números largos', () => {
    const err = new Error('falló en /Users/juan/storage/cuentas/x.pdf con la tarjeta 4111 1111 1111 8263');
    const r = describirError(err, 'guardar_bd', 'la cartola', sinLog);
    expect(r.plano).toContain('No pude guardar la cartola en la base de datos: error técnico:');
    expect(r.plano).not.toContain('/Users');
    expect(r.plano).not.toContain('4111');
    expect(r.plano).toContain('****8263');
  });

  test('el texto para el usuario va escapado para HTML', () => {
    const r = describirError(new Error('a <b> & c'), 'procesar', 'un <archivo>', sinLog);
    expect(r.usuario).not.toContain('<archivo>');
    expect(r.usuario).toContain('&lt;archivo&gt;');
  });

  test('sanear quita el token y las URLs', () => {
    process.env.TELEGRAM_BOT_TOKEN = '123456:ABCDEFGHIJKLMNOPQRSTUVWXYZ012345678';
    const t = sanear('GET https://api.telegram.org/file/bot123456:ABCDEFGHIJKLMNOPQRSTUVWXYZ012345678/documents/file_1.pdf falló');
    expect(t).not.toContain('ABCDEFGH');
    expect(t).not.toContain('api.telegram.org');
    delete process.env.TELEGRAM_BOT_TOKEN;
  });

  test('registra el detalle con el stack', () => {
    const lineas = [];
    describirError(new Error('boom'), 'leer_pdf', 'x.pdf', { log: (t) => lineas.push(t) });
    expect(lineas[0]).toContain('paso=leer_pdf');
    expect(lineas[0]).toContain('boom');
  });
});
