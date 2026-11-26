import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { COMANDOS, COMANDOS_CONOCIDOS, COMANDOS_MENU, SECCIONES, EJEMPLOS, mensajesAyuda, lineaComando, entradaComando } from './comandos.js';

const dir = path.dirname(fileURLToPath(import.meta.url));

/** Nombres de comando que el código registra de verdad (bot.onText y comando() en todos los manejadores) */
function comandosRegistrados() {
  const nombres = new Set();
  for (const archivo of fs.readdirSync(dir).filter(f => f.endsWith('.js') && !f.endsWith('.test.js'))) {
    const texto = fs.readFileSync(path.join(dir, archivo), 'utf8');
    for (const m of texto.matchAll(/(?:onText|comando)\(\s*\/(.+?)\/[a-z]*\s*,/g)) {
      const n = /\\\/(?:\(\?:)?([a-z_|]+)/.exec(m[1]);
      if (n) for (const x of n[1].split('|')) nombres.add(x);
    }
  }
  return nombres;
}

describe('lista de comandos', () => {
  test('cada comando registrado en el código está en la lista, y la lista no tiene comandos que ya no existen', () => {
    const registrados = comandosRegistrados();
    expect([...COMANDOS_CONOCIDOS].sort()).toEqual([...registrados].sort());
  });

  test('cada comando tiene sección conocida y descripción, y no hay nombres repetidos', () => {
    const todos = COMANDOS.flatMap(c => [c.nombre, ...(c.alias ?? [])]);
    expect(new Set(todos).size).toBe(todos.length);
    for (const c of COMANDOS) {
      expect(SECCIONES).toContain(c.seccion);
      expect(c.descripcion.length).toBeGreaterThan(5);
    }
    expect(COMANDOS_CONOCIDOS.has('borrar_ultimo')).toBe(false);
  });

  test('cada comando tiene un ejemplo real que empieza con el comando (así nunca falta en los nuevos)', () => {
    for (const c of COMANDOS) {
      expect({ comando: c.nombre, ejemplo: typeof c.ejemplo }).toEqual({ comando: c.nombre, ejemplo: 'string' });
      const nombres = [c.nombre, ...(c.alias ?? [])];
      const primero = c.ejemplo.trim().split(/\s+/)[0];
      expect({ comando: c.nombre, empiezaBien: nombres.map(n => `/${n}`).includes(primero) }).toEqual({ comando: c.nombre, empiezaBien: true });
    }
  });

  test('el menú de Telegram queda con los 6 de siempre, en su orden', () => {
    expect(COMANDOS_MENU.map(c => c.command)).toEqual(['help', 'plan', 'cuentas', 'cuotas', 'status', 'update']);
  });
});

describe('texto de /help', () => {
  const mensajes = mensajesAyuda((t) => t);
  const todo = mensajes.join('\n');

  test('lista todos los comandos y todos los alias, cada uno con su descripción y debajo "Ej: ..."', () => {
    for (const c of COMANDOS) {
      expect(todo).toContain(lineaComando(c));
      expect(todo).toContain(entradaComando(c));
      expect(todo).toContain(`Ej: ${c.ejemplo}`);
      for (const alias of c.alias ?? []) expect(todo).toContain(`/${alias}`);
    }
    expect(todo).not.toContain('borrar_ultimo');
  });

  test('agrupa por sección y deja los ejemplos al final', () => {
    let ultimo = -1;
    for (const seccion of SECCIONES) {
      const i = todo.indexOf(`<b>${seccion}</b>`);
      expect(i).toBeGreaterThan(ultimo);
      ultimo = i;
    }
    const ejemplos = todo.indexOf('Ejemplos de frases');
    expect(ejemplos).toBeGreaterThan(ultimo);
    for (const e of EJEMPLOS) expect(todo.indexOf(e.frase)).toBeGreaterThan(ejemplos);
  });

  test('ningún mensaje pasa el límite de Telegram y ninguna entrada queda partida', () => {
    for (const m of mensajes) expect(m.length).toBeLessThanOrEqual(4096);
    for (const c of COMANDOS) {
      expect(mensajes.some(m => m.includes(entradaComando(c)))).toBe(true);
    }
  });
});
