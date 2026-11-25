import path from 'path';
import { fileURLToPath } from 'url';
import {
  limpiarSalida,
  explicarFalloRemoto,
  explicarProgramaFaltante,
  contarArchivosDelStat,
  fechaHoraChile,
  textoProgreso,
  textoVuelta,
  titulosParaIA
} from './sistemaBot.js';

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

describe('verificaciones de /update', () => {
  test('explica un fallo de acceso al repositorio', () => {
    const r = explicarFalloRemoto({ error: 'git@github.com: Permission denied (publickey).\nfatal: Could not read from remote repository.' });
    expect(r).toMatch(/deploy key/);
  });

  test('un problema de red no se confunde con falta de acceso', () => {
    const r = explicarFalloRemoto({ error: 'ssh: connect to host github.com port 22: Connection timed out\nfatal: Could not read from remote repository.' });
    expect(r).toMatch(/conexión/);
    expect(explicarFalloRemoto({ timeout: true })).toMatch(/no respondió a tiempo/);
    expect(explicarFalloRemoto({ error: 'algo raro' })).toMatch(/No pude consultar/);
  });

  test('dice qué falta cuando no se encuentra un programa', () => {
    expect(explicarProgramaFaltante('npm')).toBe('PM2 no encuentra npm: revisa el PATH o nvm.');
    expect(explicarProgramaFaltante('git')).toMatch(/git/);
  });
});

describe('prueba del cambio', () => {
  test('cuenta los archivos de la última línea de git diff --stat', () => {
    const stat = ' server/a.js | 4 ++--\n server/b.js | 10 ++++\n 2 files changed, 12 insertions(+), 2 deletions(-)\n';
    expect(contarArchivosDelStat(stat)).toBe(2);
    expect(contarArchivosDelStat(' 1 file changed, 1 insertion(+)')).toBe(1);
    expect(contarArchivosDelStat('')).toBe(0);
  });

  test('muestra la fecha del commit en hora de Chile', () => {
    expect(fechaHoraChile('2026-11-25T17:03:22Z')).toBe('25-11-2026 14:03');
    expect(fechaHoraChile('no es fecha')).toBe('no es fecha');
  });

  test('a Gemini solo van títulos sin datos sensibles y hasta 30', () => {
    const titulos = ['Feat: algo', 'Fix: rut 12.345.678-5', ...Array.from({ length: 40 }, (_, i) => `Cambio ${i}`)];
    const r = titulosParaIA(titulos);
    expect(r).not.toContain('Fix: rut 12.345.678-5');
    expect(r.length).toBe(30);
  });
});

describe('mensajes de /update', () => {
  test('el avance marca los pasos terminados, el actual y los que fallan', () => {
    const t = textoProgreso({
      entorno: ['git: 2.43.0'],
      pasos: [{ nombre: 'Verificando', listo: true }, { nombre: 'Descargando cambios', fallo: true }],
      final: 'No pude actualizar.'
    });
    expect(t).toContain('Verificando: listo');
    expect(t).toContain('Descargando cambios: falló');
    expect(t).toContain('git: 2.43.0');
    expect(t).toContain('No pude actualizar.');
  });

  test('al volver compara el hash con el esperado', () => {
    const a = 'a'.repeat(40);
    const b = 'b'.repeat(40);
    expect(textoVuelta({ hashActual: a, hashEsperado: a, motivo: 'update' })).toMatch(/Actualización confirmada/);
    expect(textoVuelta({ hashActual: a, hashEsperado: b, motivo: 'update' })).toMatch(/Algo no calzó/);
    expect(textoVuelta({ hashActual: a, hashEsperado: null, motivo: 'reboot' })).not.toMatch(/confirmada|no calzó/);
    expect(textoVuelta({ hashActual: a, hashEsperado: null, motivo: 'reboot' })).toContain('Versión: aaaaaaa');
  });
});
