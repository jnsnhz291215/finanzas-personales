import {
  parsearCSV,
  normalizarFecha,
  normalizarMonto,
  detectarFormato,
  procesarDatos,
  analizarCartola,
  calcularHashBuffer
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
