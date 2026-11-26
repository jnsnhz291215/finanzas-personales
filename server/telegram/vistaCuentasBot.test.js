import {
  lineaVinculo,
  avisosDeCuenta,
  bloqueCuenta,
  formatearVista,
  interpretarCorreccionCuenta,
  resolverReferencia,
  planVinculo
} from './vistaCuentasBot.js';
import { cuentaSegura } from '../resumenDatos.js';
import { detectarDatosGuardados, clasificarPorReglas } from './intenciones.js';

const cuenta = (extra = {}) => ({
  id: 1, nombre: 'FAN', banco: 'Banco de Chile', tipo: 'tarjeta_debito', titular: 'Juan Sanhueza', activa: true,
  ultimos4: '6958', ultimos4_cuenta: '1234', movimientos: 5, cartolas: 1, numeroCompleto: false, digitosInvalidos: false, ...extra
});

describe('vínculos tarjeta-cuenta', () => {
  test('dice la tarjeta vinculada a la cuenta, o lo que falta', () => {
    expect(lineaVinculo(cuenta())).toBe('Tarjeta terminada en 6958 vinculada a la cuenta terminada en 1234');
    expect(lineaVinculo(cuenta({ ultimos4_cuenta: null }))).toBe('Tarjeta terminada en 6958 · Aviso: sin número de cuenta vinculado');
    expect(lineaVinculo(cuenta({ tipo: 'cuenta_vista', ultimos4: null }))).toBe('sin tarjeta vinculada · Cuenta terminada en 1234');
    expect(lineaVinculo(cuenta({ tipo: 'tarjeta_credito', ultimos4_cuenta: null }))).toBe('Tarjeta terminada en 6958 · sin número de cuenta vinculado');
    expect(lineaVinculo(cuenta({ tipo: 'efectivo', ultimos4: null, ultimos4_cuenta: null }))).toMatch(/Efectivo/);
  });

  test('avisa si falta el titular o si hay un número completo guardado, sin mostrarlo', () => {
    expect(avisosDeCuenta(cuenta({ titular: null }))).toContain('sin titular');
    const raro = avisosDeCuenta(cuenta({ numeroCompleto: true }));
    expect(raro.join(' ')).toMatch(/número completo/);
    const c = cuentaSegura({ id: 1, nombre: 'X', tipo: 'cuenta_vista', activa: 1, ultimos4: null, ultimos4_cuenta: '1234', numero_cuenta: '00123456789012' });
    expect(c.numeroCompleto).toBe(true);
    expect(JSON.stringify(c)).not.toContain('00123456789012');
  });

  test('cuentaSegura descarta dígitos que no son exactamente 4', () => {
    const c = cuentaSegura({ id: 1, nombre: 'X', tipo: 'tarjeta_debito', activa: 1, ultimos4: '123456', ultimos4_cuenta: null });
    expect(c.ultimos4).toBeNull();
    expect(c.digitosInvalidos).toBe(true);
  });

  test('el bloque incluye titular, banco y tipo, cuenta por defecto y conteos', () => {
    const b = bloqueCuenta(cuenta(), 1, { esDefecto: true });
    for (const t of ['(cuenta por defecto)', 'Titular: Juan Sanhueza', 'Banco de Chile', 'Movimientos: 5 · Cartolas: 1']) expect(b).toContain(t);
  });
});

describe('formatearVista', () => {
  const resumen = {
    cuentas: [cuenta(), cuenta({ id: 2, nombre: 'Vieja', activa: false })],
    cuotas: [{ alias: 'macbook', acreedor: 'Valeska', monto_cuota: 85000, total_cuotas: 12, cuotas_pagadas: 5, dia_pago: 24 }],
    categorias: ['Comida'],
    totales: { movimientos: 10, primero: '2026-03-05', ultimo: '2026-11-24' }
  };

  test('un solo mensaje con cuentas, cuotas, titular por defecto, categorías y totales', () => {
    const [m] = formatearVista(resumen, { defectoId: 1, hoy: '2026-11-25', titularDefecto: 'Juan Sanhueza' });
    expect(formatearVista(resumen, { hoy: '2026-11-25' })).toHaveLength(1);
    for (const t of ['macbook', 'titular: Valeska', 'cuota 6 de 12', 'Titular por defecto: Juan Sanhueza', 'Categorías en uso: Comida', 'Movimientos: 10', 'Desactivadas: Vieja']) {
      expect(m.texto).toContain(t);
    }
    expect(m.cuentas).toEqual([{ indice: 1, id: 1 }]);
  });

  test('muestra por titular las cuotas del mes, lo pagado y lo pendiente', () => {
    const [m] = formatearVista(
      { ...resumen, titularesMes: [{ titular: 'Valeska', compras: 2, cuotasMes: 130000, pagado: 85000, pendiente: 45000 }] },
      { hoy: '2026-11-25' }
    );
    expect(m.texto).toContain('Valeska</b>: cuotas del mes $130.000 · pagado $85.000 · pendiente $45.000');
  });

  test('sin datos responde corto', () => {
    const [m] = formatearVista({ cuentas: [], cuotas: [], categorias: [], totales: { movimientos: 0 } });
    expect(m.texto).toBe('Todavía no tengo cuentas ni cuotas guardadas. Crea una cuenta con /savecard.');
  });

  test('si no cabe se parte en varios mensajes y la numeración sigue', () => {
    const muchas = Array.from({ length: 40 }, (_, i) => cuenta({ id: i + 1, nombre: `Cuenta ${i + 1}` }));
    const partes = formatearVista({ ...resumen, cuentas: muchas }, { hoy: '2026-11-25' });
    expect(partes.length).toBeGreaterThan(1);
    expect(partes.flatMap(p => p.cuentas).map(c => c.indice)).toEqual(Array.from({ length: 40 }, (_, i) => i + 1));
    for (const p of partes) expect(p.texto.length).toBeLessThanOrEqual(4000);
  });
});

describe('corrección en lenguaje natural', () => {
  test('vínculo tarjeta-cuenta, en los dos órdenes', () => {
    expect(interpretarCorreccionCuenta('la tarjeta 1234 es de la cuenta 5678')).toEqual({ accion: 'vincular', tarjeta: '1234', cuenta: '5678' });
    expect(interpretarCorreccionCuenta('la cuenta 5678 tiene la tarjeta 1234')).toEqual({ accion: 'vincular', tarjeta: '1234', cuenta: '5678' });
  });

  test('titular de esta, por número, por nombre o por dígitos', () => {
    expect(interpretarCorreccionCuenta('esta es de Valeska')).toMatchObject({ accion: 'titular', titular: 'Valeska', referencia: { tipo: 'esta' } });
    expect(interpretarCorreccionCuenta('la 2 es de valeska').referencia).toEqual({ tipo: 'indice', valor: 2 });
    expect(interpretarCorreccionCuenta('la FAN es de Valeska').referencia).toEqual({ tipo: 'nombre', valor: 'fan' });
    expect(interpretarCorreccionCuenta('la tarjeta 1234 es de Valeska').referencia).toEqual({ tipo: 'digitos', valor: '1234', de: 'tarjeta' });
    expect(interpretarCorreccionCuenta('titular Valeska')).toMatchObject({ titular: 'Valeska' });
  });

  test('un número largo se rechaza y un texto cualquiera no se entiende', () => {
    expect(interpretarCorreccionCuenta('la tarjeta 4111 1111 1111 1111 es de la cuenta 5678')).toEqual({ error: 'largo' });
    expect(interpretarCorreccionCuenta('hola')).toBeNull();
  });

  test('resuelve la cuenta nombrada y avisa si no existe', () => {
    const cuentas = [cuenta(), cuenta({ id: 2, nombre: 'CMR', ultimos4: '5678', ultimos4_cuenta: null })];
    expect(resolverReferencia({ tipo: 'indice', valor: 2 }, [{ indice: 1, id: 1 }, { indice: 2, id: 2 }], cuentas).cuenta.id).toBe(2);
    expect(resolverReferencia({ tipo: 'esta' }, [{ indice: 1, id: 1 }], cuentas).cuenta.id).toBe(1);
    expect(resolverReferencia({ tipo: 'esta' }, [{ indice: 1, id: 1 }, { indice: 2, id: 2 }], cuentas).error).toMatch(/varias/);
    expect(resolverReferencia({ tipo: 'digitos', valor: '5678', de: 'tarjeta' }, [], cuentas).cuenta.id).toBe(2);
    expect(resolverReferencia({ tipo: 'digitos', valor: '0000', de: 'tarjeta' }, [], cuentas).error).toMatch(/No encuentro/);
  });

  test('planVinculo completa el dato que falta y nunca fusiona dos cuentas', () => {
    const a = cuenta({ id: 1, ultimos4: null, ultimos4_cuenta: '5678' });
    const b = cuenta({ id: 2, ultimos4: '1234', ultimos4_cuenta: null });
    expect(planVinculo('1234', '5678', [a]).cambio).toMatchObject({ tipo: 'tarjeta', digitos: '1234' });
    expect(planVinculo('1234', '5678', [b]).cambio).toMatchObject({ tipo: 'cuenta', digitos: '5678' });
    expect(planVinculo('1234', '5678', [a, b]).error).toMatch(/cuentas distintas/);
    expect(planVinculo('1234', '5678', []).error).toMatch(/No encuentro/);
  });
});

describe('intención "qué datos tienes guardados"', () => {
  test('va a /cuentas por reglas y no se confunde con los datos de transferencia', () => {
    for (const t of ['qué datos tienes guardados', 'datos guardados', 'muéstrame mis cuentas', 'qué cuentas tengo']) {
      expect(clasificarPorReglas(t).intencion).toBe('cuentas');
    }
    expect(detectarDatosGuardados('pásame los datos de la mercado pago')).toBe(false);
    expect(clasificarPorReglas('pásame los datos de la mercado pago').intencion).toBe('datos_transferencia');
  });
});
