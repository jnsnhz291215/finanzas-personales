import path from 'path';
import { fileURLToPath } from 'url';
import { limpiarSalida } from './sistemaBot.js';

describe('limpiarSalida', () => {
  test('deja solo las últimas líneas', () => {
    const salida = Array.from({ length: 20 }, (_, i) => `linea ${i + 1}`).join('\n');

    expect(limpiarSalida(salida, 3)).toBe('linea 18\nlinea 19\nlinea 20');
  });

  test('quita las líneas que mencionan .env', () => {
    const r = limpiarSalida('error: cannot pull\nerror: your local changes to .env would be overwritten\nAborting');

    expect(r).not.toContain('.env');
    expect(r).toContain('Aborting');
  });

  test('quita credenciales de las URL', () => {
    const r = limpiarSalida('fatal: unable to access https://usuario:secreto123@github.com/x/y.git/: error');

    expect(r).not.toContain('secreto123');
    expect(r).not.toContain('usuario');
    expect(r).toContain('https://github.com/x/y.git/');
  });

  test('oculta la ruta del repositorio', () => {
    const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
    const r = limpiarSalida(`error: ${repo}/server/index.js tiene cambios locales`);

    expect(r).not.toContain(repo);
    expect(r).toContain('<repo>/server/index.js');
  });

  test('acota el largo de cada línea y tolera salidas vacías', () => {
    expect(limpiarSalida('x'.repeat(500)).length).toBe(200);
    expect(limpiarSalida('')).toBe('');
    expect(limpiarSalida(null)).toBe('');
  });
});
