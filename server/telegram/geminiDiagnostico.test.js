import { describirError, clasificarError, sanear } from './errores.js';
import { lineasDeGemini } from './mantenimientoBot.js';
import { limpiarLinea, ultimasLineasDeError } from './bufferErrores.js';

const errorGemini = (http, estado, motivo = null, mensaje = 'x') =>
  Object.assign(new Error(mensaje), { name: 'ErrorGemini', codigo: http, http, estado, motivo });

describe('errores de Gemini traducidos con describirError (paso "gemini")', () => {
  test.each([
    [400, 'INVALID_ARGUMENT', 'API_KEY_INVALID', 'la clave de API no es válida (400 API_KEY_INVALID)'],
    [403, 'PERMISSION_DENIED', null, 'la clave no tiene permiso para usar Gemini o el modelo (403 PERMISSION_DENIED)'],
    [404, 'NOT_FOUND', null, 'el modelo no existe o no está disponible (404 NOT_FOUND)'],
    [429, 'RESOURCE_EXHAUSTED', null, 'se agotó la cuota o hay demasiadas solicitudes (429 RESOURCE_EXHAUSTED)'],
    [503, 'UNAVAILABLE', null, 'Gemini está sobrecargado o no disponible (503 UNAVAILABLE)']
  ])('HTTP %s %s', (http, estado, motivo, causa) => {
    expect(describirError(errorGemini(http, estado, motivo), 'gemini', 'gemini-x', { registrar: false }).causa).toBe(causa);
  });

  test('un corte de red no es un error de la API', () => {
    expect(clasificarError(Object.assign(new TypeError('fetch failed'), { cause: Object.assign(new Error('x'), { code: 'ECONNRESET' }) })).tipo).toBe('red');
  });
});

describe('informe de Gemini', () => {
  test('dice si la clave existe y su largo, sin mostrarla', () => {
    const l = lineasDeGemini({ claveDefinida: true, largoClave: 39, modeloConfigurado: true, resultados: [{ modelo: 'a', ok: true, ms: 800 }, { modelo: 'b', ok: false, ms: 90, error: errorGemini(404, 'NOT_FOUND') }] }, ['a', 'b']).join('\n');
    expect(l).toContain('definida (39 caracteres)');
    expect(l).toContain('a: respondió OK en 800 ms');
    expect(l).toContain('b: FALLÓ en 90 ms (HTTP 404 NOT_FOUND)');
    expect(l).toContain('1 de 2 modelos respondieron');
  });

  test('sin clave lo dice y no prueba nada', () => {
    const l = lineasDeGemini({ claveDefinida: false, largoClave: 0, modeloConfigurado: false, resultados: [] }, ['a']).join('\n');
    expect(l).toContain('NO está definida');
  });
});

describe('líneas de error sin secretos', () => {
  test('oculta keys, tokens, URLs, RUT y números largos', () => {
    process.env.GEMINI_API_KEY = 'AIzaSyEJEMPLO_de_prueba_1234567890abcd';
    const linea = limpiarLinea('falló con AIzaSyEJEMPLO_de_prueba_1234567890abcd en https://x.cl/a?key=zzz para 12.345.678-9 tarjeta 4111 1111 1111 8263');
    delete process.env.GEMINI_API_KEY;
    expect(linea).not.toContain('AIza');
    expect(linea).not.toContain('https');
    expect(linea).not.toContain('12.345.678');
    expect(linea).not.toContain('4111');
    expect(linea).toContain('****8263');
  });

  test('sin archivo de log usa la memoria', async () => {
    const r = await ultimasLineasDeError(5, '/no/existe/err.log');
    expect(r.origen).toBe('memoria');
  });
});
