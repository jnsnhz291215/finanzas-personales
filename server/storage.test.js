import os from 'os';
import path from 'path';
import fs from 'fs/promises';
import {
  nombreSeguro,
  dentroDe,
  mesRecepcion,
  rutaRelativa,
  carpetaBase,
  guardarBuffer,
  resolverArchivo,
  borrarArchivo,
  guardarTemporal,
  confirmarTemporal,
  borrarTemporal,
  limpiarTemporales
} from './storage.js';

describe('helpers puros', () => {
  test('nombreSeguro deja solo el nombre y limpia caracteres raros', () => {
    expect(nombreSeguro('../../etc/passwd')).toBe('passwd');
    expect(nombreSeguro('foto 1.jpg')).toBe('foto 1.jpg');
    expect(nombreSeguro('a<b>:c?.pdf')).toBe('a_b__c_.pdf');
    expect(nombreSeguro('...oculto')).toBe('oculto');
    expect(nombreSeguro('')).toBe('archivo');
  });

  test('dentroDe no acepta salirse de la base', () => {
    expect(dentroDe('/a/b', '/a/b/c/d.txt')).toBe(true);
    expect(dentroDe('/a/b', '/a/b')).toBe(false);
    expect(dentroDe('/a/b', '/a/b/../x')).toBe(false);
    expect(dentroDe('/a/b', '/otro/lugar')).toBe(false);
  });

  test('mes de recepción y ruta relativa', () => {
    expect(mesRecepcion('2026-11-18')).toBe('2026-11');
    expect(rutaRelativa('comprobantes', '2026-11', 'x.jpg')).toBe('comprobantes/2026-11/x.jpg');
  });
});

describe('guardar, resolver y borrar', () => {
  const guardado = process.env.FINANZAS_STORAGE;
  let raiz;

  beforeEach(async () => {
    raiz = await fs.mkdtemp(path.join(os.tmpdir(), 'finanzas-storage-'));
    process.env.FINANZAS_STORAGE = raiz;
    delete process.env.CARTOLAS_PATH;
    delete process.env.RESPALDOS_PATH;
  });

  afterAll(() => {
    if (guardado === undefined) delete process.env.FINANZAS_STORAGE;
    else process.env.FINANZAS_STORAGE = guardado;
  });

  test('guarda por tipo y mes, con la ruta relativa a la raíz', async () => {
    const r = await guardarBuffer('comprobantes', '../../foto.jpg', Buffer.from('x'), { prefijo: 'respaldo_cuota_1_', mes: '2026-11' });

    expect(r.ruta).toBe('comprobantes/2026-11/respaldo_cuota_1_foto.jpg');
    expect(r.absoluta).toBe(path.join(raiz, 'comprobantes', '2026-11', 'respaldo_cuota_1_foto.jpg'));
    expect(await resolverArchivo(r.ruta)).toBe(r.absoluta);
  });

  test('un nombre repetido no se sobrescribe', async () => {
    const a = await guardarBuffer('archivos', 'foto.jpg', Buffer.from('a'), { mes: '2026-11' });
    const b = await guardarBuffer('archivos', 'foto.jpg', Buffer.from('b'), { mes: '2026-11' });

    expect(b.ruta).not.toBe(a.ruta);
  });

  test('resolver rechaza rutas fuera del almacenamiento', async () => {
    expect(await resolverArchivo('comprobantes/../../etc/passwd')).toBeNull();
    expect(await resolverArchivo('/etc/passwd')).toBeNull();
    expect(await resolverArchivo('')).toBeNull();
  });

  test('borrar elimina el archivo y devuelve false si no existe', async () => {
    const r = await guardarBuffer('cartolas', 'c.csv', Buffer.from('x'), { mes: '2026-11' });

    expect(await borrarArchivo(r.ruta)).toBe(true);
    expect(await resolverArchivo(r.ruta)).toBeNull();
    expect(await borrarArchivo(r.ruta)).toBe(false);
  });

  test('CARTOLAS_PATH obsoleta sigue mandando para cartolas', async () => {
    process.env.CARTOLAS_PATH = path.join(raiz, 'antiguas');

    expect(carpetaBase('cartolas')).toBe(path.join(raiz, 'antiguas'));
    expect(carpetaBase('comprobantes')).toBe(path.join(raiz, 'comprobantes'));
  });

  test('los registros anteriores /uploads/respaldos/<archivo> se siguen resolviendo', async () => {
    const respaldos = path.join(raiz, 'viejos');
    await fs.mkdir(respaldos, { recursive: true });
    await fs.writeFile(path.join(respaldos, 'antiguo.jpg'), 'x');
    process.env.RESPALDOS_PATH = respaldos;

    expect(await resolverArchivo('/uploads/respaldos/antiguo.jpg')).toBe(path.join(respaldos, 'antiguo.jpg'));
  });
});

describe('temporales sin confirmar', () => {
  const guardado = process.env.FINANZAS_STORAGE;
  let raiz;

  beforeEach(async () => {
    raiz = await fs.mkdtemp(path.join(os.tmpdir(), 'finanzas-tmp-'));
    process.env.FINANZAS_STORAGE = raiz;
    delete process.env.CARTOLAS_PATH;
  });

  afterAll(() => {
    if (guardado === undefined) delete process.env.FINANZAS_STORAGE;
    else process.env.FINANZAS_STORAGE = guardado;
  });

  test('un pendiente vive en tmp/ y al confirmarlo pasa a cartolas/{YYYY-MM}/', async () => {
    const tmp = await guardarTemporal('../cartola.pdf', Buffer.from('x'));
    expect(tmp.ruta).toMatch(/^tmp\/\d+-[0-9a-f]{8}-cartola\.pdf$/);
    expect(tmp.absoluta.startsWith(path.join(raiz, 'tmp'))).toBe(true);

    const definitiva = await confirmarTemporal(tmp.ruta, 'cartolas', { prefijo: 'telegram_' });
    expect(definitiva).toMatch(/^cartolas\/\d{4}-\d{2}\/telegram_cartola\.pdf$/);
    expect(await resolverArchivo(definitiva)).not.toBeNull();
    await expect(fs.access(tmp.absoluta)).rejects.toThrow();
  });

  test('confirmar un temporal que ya no existe falla', async () => {
    await expect(confirmarTemporal('tmp/inexistente.pdf')).rejects.toThrow();
  });

  test('cancelar borra el temporal', async () => {
    const tmp = await guardarTemporal('a.csv', Buffer.from('x'));

    expect(await borrarTemporal(tmp.ruta)).toBe(true);
    expect(await borrarTemporal(tmp.ruta)).toBe(false);
  });

  test('no se acepta una ruta que se salga de tmp/', async () => {
    expect(await borrarTemporal('tmp/../../etc/passwd')).toBe(false);
  });

  test('la limpieza borra solo lo que supera la edad máxima', async () => {
    const viejo = await guardarTemporal('viejo.csv', Buffer.from('x'));
    const nuevo = await guardarTemporal('nuevo.csv', Buffer.from('x'));
    const hace25h = new Date(Date.now() - 25 * 60 * 60 * 1000);
    await fs.utimes(viejo.absoluta, hace25h, hace25h);

    expect(await limpiarTemporales()).toBe(1);
    await expect(fs.access(viejo.absoluta)).rejects.toThrow();
    await expect(fs.access(nuevo.absoluta)).resolves.toBeUndefined();
  });
});
