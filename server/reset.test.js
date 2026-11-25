import {
  fraseCorrecta,
  fraseDe,
  nombreCarpetaRespaldo,
  contenidoOpcionesMysql,
  contarCategoriasPersonalizadas,
  lineasConteos,
  TABLAS_MOVIMIENTOS,
  TABLAS_TODO,
  CATEGORIAS_BASE
} from './reset.js';

describe('frases de confirmación', () => {
  test('hay que escribir la frase exacta', () => {
    expect(fraseCorrecta('BORRAR TODO', 'todo')).toBe(true);
    expect(fraseCorrecta('  BORRAR TODO ', 'todo')).toBe(true);
    expect(fraseCorrecta('borrar todo', 'todo')).toBe(false);
    expect(fraseCorrecta('BORRAR MOVIMIENTOS', 'todo')).toBe(false);
    expect(fraseCorrecta('BORRAR MOVIMIENTOS', 'movimientos')).toBe(true);
    expect(fraseCorrecta('RESTAURAR RESPALDO', 'restaurar')).toBe(true);
    expect(fraseCorrecta('si', 'todo')).toBe(false);
    expect(fraseCorrecta(null, 'todo')).toBe(false);
    expect(fraseDe('otra')).toBeNull();
  });
});

describe('respaldo', () => {
  test('la carpeta usa la hora de Chile', () => {
    expect(nombreCarpetaRespaldo('reset', new Date('2026-11-25T17:30:05Z'))).toBe('reset-2026-11-25_143005');
  });

  test('el archivo de opciones escapa comillas y no deja saltos de línea', () => {
    const t = contenidoOpcionesMysql({ host: 'localhost', port: '3307', user: 'juan', password: 'a"b\\c\nd' });
    expect(t).toContain('password="a\\"b\\\\cd"');
    expect(t).toContain('port=3307');
    expect(t.startsWith('[client]')).toBe(true);
  });
});

describe('qué se borra', () => {
  test('borrar todo incluye lo de movimientos, con los hijos antes que los padres', () => {
    for (const t of TABLAS_MOVIMIENTOS) expect(TABLAS_TODO).toContain(t);
    expect(TABLAS_TODO.indexOf('movimientos')).toBeLessThan(TABLAS_TODO.indexOf('cuentas'));
    expect(TABLAS_TODO.indexOf('movimientos')).toBeLessThan(TABLAS_TODO.indexOf('compras_cuotas'));
    expect(TABLAS_TODO.indexOf('reglas_categoria')).toBeLessThan(TABLAS_TODO.indexOf('categorias'));
    expect(TABLAS_MOVIMIENTOS).not.toContain('cuentas');
    expect(TABLAS_MOVIMIENTOS).not.toContain('compras_cuotas');
  });

  test('las categorías base no cuentan como personalizadas', () => {
    const base = CATEGORIAS_BASE.map(c => c[0]);
    expect(contarCategoriasPersonalizadas([...base, 'Mascotas', 'Viajes'])).toBe(2);
    expect(contarCategoriasPersonalizadas(['comida'])).toBe(0);
  });

  test('las líneas de conteos nombran todo lo que se borra', () => {
    const texto = lineasConteos({
      movimientos: 10, cuentas: 3, cuotas: 1, planAhorro: true, gastosFijos: 2,
      datosTransferencia: 4, reglas: 5, categoriasPersonalizadas: 1, archivos: 7
    }).join('\n');
    expect(texto).toContain('Movimientos: 10');
    expect(texto).toContain('Plan de ahorro: configurado');
    expect(texto).toContain('Archivos en storage: 7');
  });
});
