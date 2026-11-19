import {
  parsearCSV,
  normalizarFecha,
  normalizarMonto,
  detectarFormato,
  procesarDatos,
  analizarCartola,
  calcularHashBuffer,
  movimientosDesdeTextoPDF,
  enmascararTextoCartola,
  validarMovimientosIA
} from './cartolas.js';
import { calzarConCartola } from './telegram/cuotas.js';

const CSV = Buffer.from(
  'Fecha,Descripcion,Cargo,Abono\n' +
  '15/11/2026,Transferencia a Valeska,85.000,\n' +
  '16/11/2026,Sueldo,,800.000\n'
);

describe('lectura de cartolas', () => {
  test('normalizarFecha y normalizarMonto', () => {
    expect(normalizarFecha('15/11/2026')).toBe('2026-11-15');
    expect(normalizarFecha('2026-11-15')).toBe('2026-11-15');
    expect(normalizarMonto('$85.000')).toBe(85000);
  });

  test('un CSV con cargo y abono se detecta y se procesa', async () => {
    const r = await analizarCartola(CSV, '.csv');

    expect(r.esManual).toBe(false);
    expect(r.movimientos).toEqual([
      { fecha: '2026-11-15', descripcion: 'Transferencia a Valeska', monto: 85000, tipo: 'cargo' },
      { fecha: '2026-11-16', descripcion: 'Sueldo', monto: 800000, tipo: 'abono' }
    ]);
  });

  test('el hash del buffer es estable', () => {
    expect(calcularHashBuffer(CSV)).toBe(calcularHashBuffer(Buffer.from(CSV)));
    expect(calcularHashBuffer(CSV)).toHaveLength(64);
  });

  test('sin datos no hay formato y el CSV se lee fila por fila', () => {
    expect(detectarFormato([])).toBeNull();
    expect(parsearCSV(CSV)).toHaveLength(2);
  });
});

describe('transferencias de la cartola que parecen cuotas', () => {
  const compras = [{ id: 1, alias: 'mac', alias_cartola: 'valeska', acreedor: 'tía' }];

  test('calza solo la que trae el alias de la cartola', async () => {
    const { movimientos } = await analizarCartola(CSV, '.csv');
    const candidatos = movimientos.filter(m => m.tipo === 'cargo' && calzarConCartola(m.descripcion, compras).length > 0);

    expect(candidatos.map(m => m.descripcion)).toEqual(['Transferencia a Valeska']);
  });
});

describe('PDF: reglas sobre el texto', () => {
  const TEXTO = [
    'CARTOLA CUENTA CORRIENTE',
    '15/11/2026 Transferencia a Valeska -85.000',
    '16/11/2026 Abono sueldo 800.000',
    '17/11/2026 Compra Jumbo 23.450-',
    '18/11/2026 Compra Lider 12.000 1.250.000'
  ].join('\n');

  test('toma líneas con fecha y un solo monto; el tipo sale del signo o de palabras clave', () => {
    const r = movimientosDesdeTextoPDF(TEXTO);

    expect(r.movimientos).toEqual([
      { fecha: '2026-11-15', descripcion: 'Transferencia a Valeska', monto: 85000, tipo: 'cargo' },
      { fecha: '2026-11-16', descripcion: 'Abono sueldo', monto: 800000, tipo: 'abono' },
      { fecha: '2026-11-17', descripcion: 'Compra Jumbo', monto: 23450, tipo: 'cargo' }
    ]);
  });

  test('una línea con monto y saldo es ambigua y se omite', () => {
    const r = movimientosDesdeTextoPDF(TEXTO);

    expect(r.lineasCandidatas).toBe(4);
    expect(r.movimientos.map(m => m.descripcion)).not.toContain('Compra Lider');
  });

  test('sin signo ni palabra clave el tipo queda sin resolver', () => {
    const r = movimientosDesdeTextoPDF('15/11/2026 Pedro Soto 20.000');

    expect(r.movimientos).toEqual([]);
    expect(r.sinTipo).toBe(1);
  });
});

describe('enmascararTextoCartola', () => {
  test('oculta RUT y números de cuenta pero conserva montos y fechas', () => {
    const r = enmascararTextoCartola(
      'Titular: Juan RUT 12.345.678-5\nCuenta corriente N° 00123456789\n15/11/2026 Compra Jumbo 23.450\nTarjeta 4111 1111 1111 1111'
    );

    expect(r).not.toContain('12.345.678');
    expect(r).not.toContain('00123456789');
    expect(r).not.toContain('4111');
    expect(r).toContain('15/11/2026 Compra Jumbo 23.450');
  });
});

describe('validarMovimientosIA', () => {
  const TEXTO = '15/11/2026 Transferencia a Valeska 85.000\n16/11/2026 Sueldo 800.000';

  test('acepta movimientos válidos cuyo monto aparece en el texto', () => {
    const r = validarMovimientosIA([
      { fecha: '2026-11-15', descripcion: 'Transferencia a Valeska', monto: 85000, tipo: 'cargo' },
      { fecha: '2026-11-16', descripcion: 'Sueldo', monto: 800000, tipo: 'abono' }
    ], TEXTO);

    expect(r.movimientos).toHaveLength(2);
    expect(r.descartados).toBe(0);
  });

  test('descarta montos inventados, fechas imposibles y tipos inválidos', () => {
    const r = validarMovimientosIA([
      { fecha: '2026-11-15', descripcion: 'Inventado', monto: 99999, tipo: 'cargo' },
      { fecha: '2026-02-31', descripcion: 'Fecha mala', monto: 85000, tipo: 'cargo' },
      { fecha: '2026-11-15', descripcion: 'Tipo malo', monto: 85000, tipo: 'otro' },
      { fecha: '2026-11-15', descripcion: 'Bien', monto: 85000, tipo: 'cargo' }
    ], TEXTO);

    expect(r.movimientos.map(m => m.descripcion)).toEqual(['Bien']);
    expect(r.descartados).toBe(3);
  });
});
