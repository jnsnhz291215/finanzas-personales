import {
  conTimeout,
  formatearTamano,
  textoTamano,
  formatearDuracion,
  contarProblemas,
  lineaFinal,
  formatearEstado,
  revisarVariables,
  ejecutarChequeo
} from './statusBot.js';
import { motivoFalloGemini } from './gemini.js';
import { detectarEstado } from './intenciones.js';

const seccion = (titulo, ...estados) => ({ titulo, items: estados.map((estado, i) => ({ estado, texto: `item ${i}` })) });

describe('resumen del estado', () => {
  test('cuenta solo los que no funcionan y arma la línea final', () => {
    const ok = [seccion('A', 'ok', 'aviso')];
    expect(contarProblemas(ok)).toBe(0);
    expect(lineaFinal(ok)).toBe('Todo en orden (1 aviso)');
    expect(lineaFinal([seccion('A', 'ok')])).toBe('Todo en orden');

    const mal = [seccion('A', 'fallo', 'ok'), seccion('B', 'fallo')];
    expect(lineaFinal(mal)).toBe('Hay 2 problemas');
    expect(lineaFinal([seccion('A', 'fallo')])).toBe('Hay 1 problema');
  });

  test('el mensaje usa ✅ y ❌, "Aviso:" y escapa el texto', () => {
    const texto = formatearEstado([
      { titulo: 'Base <db>', items: [{ estado: 'ok', texto: 'bien' }, { estado: 'fallo', texto: 'mal' }, { estado: 'aviso', texto: 'ojo' }] }
    ], (t) => t.replace(/</g, '&lt;'));
    expect(texto).toContain('✅ bien');
    expect(texto).toContain('❌ mal');
    expect(texto).toContain('Aviso: ojo');
    expect(texto).toContain('Base &lt;db>');
    expect(texto).toContain('Hay 1 problema');
  });

  test('no pasa el límite de Telegram', () => {
    const grande = [{ titulo: 'X', items: Array.from({ length: 300 }, () => ({ estado: 'ok', texto: 'linea larga '.repeat(5) })) }];
    expect(formatearEstado(grande).length).toBeLessThanOrEqual(4000);
  });
});

describe('formatos', () => {
  test('tamaños y duraciones', () => {
    expect(formatearTamano(512)).toBe('512 B');
    expect(formatearTamano(1536)).toBe('1,5 KB');
    expect(formatearTamano(-1)).toBe('desconocido');
    expect(formatearDuracion(93784)).toBe('1 d 2 h 3 min');
    expect(formatearDuracion(125)).toBe('2 min');
  });
});

describe('variables de entorno', () => {
  test('solo muestra nombres, nunca valores', () => {
    const items = revisarVariables({ TELEGRAM_BOT_TOKEN: 'secreto-123', GEMINI_API_KEY: 'otro-secreto', NODE_ENV: 'production' }, 'sqlite');
    const texto = JSON.stringify(items);
    expect(texto).toContain('TELEGRAM_ALLOWED_CHAT_IDS');
    expect(texto).not.toContain('secreto');
    expect(items[0].estado).toBe('fallo');
  });

  test('con mariadb exige las variables de la base; todo presente es ok', () => {
    const base = { TELEGRAM_BOT_TOKEN: 'a', TELEGRAM_ALLOWED_CHAT_IDS: '1' };
    expect(revisarVariables(base, 'mariadb')[0].texto).toMatch(/DB_HOST/);
    const completo = { ...base, DB_HOST: 'h', DB_USER: 'u', DB_PASSWORD: '', DB_NAME: 'n' };
    expect(revisarVariables(completo, 'mariadb')[0].estado).toBe('ok');
  });
});

describe('SESSION_SECRET y tamaños', () => {
  test('SESSION_SECRET es opcional y solo se avisa si se sirve la web', () => {
    const base = { TELEGRAM_BOT_TOKEN: 'a', TELEGRAM_ALLOWED_CHAT_IDS: '1', FINANZAS_STORAGE: 'x', GEMINI_API_KEY: 'g' };
    const sinWeb = revisarVariables(base, 'sqlite');
    expect(sinWeb[0].estado).toBe('ok');
    expect(JSON.stringify(sinWeb)).not.toContain('SESSION_SECRET');
    const conWeb = revisarVariables({ ...base, SERVIR_FRONTEND: 'true' }, 'sqlite');
    expect(conWeb[0].estado).toBe('ok');
    expect(JSON.stringify(conWeb)).toContain('SESSION_SECRET');
  });

  test('un conteo incompleto dice "más de"', () => {
    expect(textoTamano(1536)).toBe('1,5 KB');
    expect(textoTamano(1536, true)).toBe('más de 1,5 KB');
  });
});

describe('tiempo máximo de cada chequeo', () => {
  test('un chequeo que no termina o que falla se vuelve "No funciona"', async () => {
    const lento = await ejecutarChequeo('Lento', () => new Promise(() => {}), 30);
    expect(lento.items[0].estado).toBe('fallo');
    expect(lento.items[0].texto).toMatch(/No respondió/);

    const roto = await ejecutarChequeo('Roto', async () => { throw new Error('x'); });
    expect(roto.items[0].estado).toBe('fallo');

    const bien = await ejecutarChequeo('Bien', async () => [{ estado: 'ok', texto: 'listo' }]);
    expect(bien.items[0].estado).toBe('ok');
  });

  test('conTimeout rechaza si pasa el tiempo', async () => {
    await expect(conTimeout(new Promise(() => {}), 20)).rejects.toMatchObject({ esTimeout: true });
    await expect(conTimeout(Promise.resolve(5), 20)).resolves.toBe(5);
  });
});

describe('motivo de un fallo de Gemini', () => {
  test('lo explica en lenguaje simple', () => {
    expect(motivoFalloGemini({ codigo: 400, message: 'API key not valid' })).toMatch(/clave/);
    expect(motivoFalloGemini({ codigo: 429, message: 'quota' })).toMatch(/cuota/);
    expect(motivoFalloGemini(new TypeError('fetch failed'))).toMatch(/internet/);
    expect(motivoFalloGemini({ name: 'TimeoutError', message: 'x' })).toMatch(/a tiempo/);
    expect(motivoFalloGemini({ codigo: 503, message: 'x' })).toMatch(/fallando/);
  });
});

describe('estado en lenguaje natural', () => {
  test('solo calzan mensajes que son exactamente eso', () => {
    for (const t of ['estado', 'status', 'todo bien?', '¿Está todo bien?']) expect(detectarEstado(t)).toBe(true);
    expect(detectarEstado('estado de cuenta')).toBe(false);
    expect(detectarEstado('almuerzo 5500')).toBe(false);
  });
});
