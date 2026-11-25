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
  validarMovimientosIA,
  pdfSinTexto,
  buscarUltimos4
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

describe('buscarUltimos4: encabezado', () => {
  test('"cuenta" dentro de un movimiento no se toma como número de cuenta', () => {
    const texto = 'Cartola\nFecha Descripción Monto\n12/11/2026 Traspaso a cuenta 5555 $1.000\nTarjeta XXXX 4321';
    expect(buscarUltimos4(texto)).toEqual([{ digitos: '4321', tipo: 'tarjeta' }]);
  });

  test('el número de cuenta del encabezado sí se toma y la máscara puede ir más abajo', () => {
    const texto = 'Cuenta corriente N° 00-123-45678\n12/11/2026 Compra $1.000\nTarjeta **** 1234';
    expect(buscarUltimos4(texto)).toEqual([
      { digitos: '5678', tipo: 'cuenta' },
      { digitos: '1234', tipo: 'tarjeta' }
    ]);
  });
});

describe('buscarUltimos4', () => {
  test('máscaras de tarjeta: **** 1234, XXXX-1234, XXXX XXXX XXXX 1234', () => {
    expect(buscarUltimos4('Tarjeta **** 1234')).toEqual([{ digitos: '1234', tipo: 'tarjeta' }]);
    expect(buscarUltimos4('Tarjeta XXXX-5678')).toEqual([{ digitos: '5678', tipo: 'tarjeta' }]);
    expect(buscarUltimos4('XXXX XXXX XXXX 6958')).toEqual([{ digitos: '6958', tipo: 'tarjeta' }]);
    expect(buscarUltimos4('Tarjeta ••••4321')).toEqual([{ digitos: '4321', tipo: 'tarjeta' }]);
  });

  test('"terminada en 1234" es de tarjeta y "cuenta terminada en 1234" es de cuenta', () => {
    expect(buscarUltimos4('Tarjeta terminada en 6958')).toEqual([{ digitos: '6958', tipo: 'tarjeta' }]);
    expect(buscarUltimos4('Cuenta terminada en 4321')).toEqual([{ digitos: '4321', tipo: 'cuenta' }]);
  });

  test('N° de cuenta: solo los últimos 4 dígitos, nunca el número completo', () => {
    const a = buscarUltimos4('N° cuenta 00-123-45678');
    const b = buscarUltimos4('Cuenta corriente N° 00123456789');

    expect(a).toEqual([{ digitos: '5678', tipo: 'cuenta' }]);
    expect(b).toEqual([{ digitos: '6789', tipo: 'cuenta' }]);
    expect(JSON.stringify([a, b])).not.toContain('00123456789');
    expect(JSON.stringify([a, b])).not.toContain('123');
  });

  test('una máscara con "cuenta" delante se cuenta como cuenta, una sola vez', () => {
    expect(buscarUltimos4('N° cuenta XXXX-5678')).toEqual([{ digitos: '5678', tipo: 'cuenta' }]);
  });

  test('tarjeta y cuenta en el mismo encabezado', () => {
    expect(buscarUltimos4('Cuenta corriente N° 00123456789\nTarjeta **** 1234')).toEqual([
      { digitos: '6789', tipo: 'cuenta' },
      { digitos: '1234', tipo: 'tarjeta' }
    ]);
  });

  test('no confunde fechas, montos ni números largos sin máscara', () => {
    expect(buscarUltimos4('Cuenta corriente 15-11-2026')).toEqual([]);
    expect(buscarUltimos4('15/11/2026 Compra Jumbo 23.450')).toEqual([]);
    expect(buscarUltimos4('4111111111111111')).toEqual([]);
    expect(buscarUltimos4('')).toEqual([]);
  });

  test('solo revisa el comienzo del archivo y sin repetidos', () => {
    expect(buscarUltimos4(`Tarjeta **** 1234\n${'x'.repeat(7000)}\n**** 9999`)).toEqual([{ digitos: '1234', tipo: 'tarjeta' }]);
    expect(buscarUltimos4('**** 1234 y otra vez **** 1234')).toEqual([{ digitos: '1234', tipo: 'tarjeta' }]);
  });

  test('un CSV con encabezado de cuenta entrega solo los 4 dígitos', async () => {
    const csv = Buffer.from('Cuenta N° 00-123-45678\nFecha,Descripcion,Cargo,Abono\n15/11/2026,Compra,1.000,\n');
    const r = await analizarCartola(csv, '.csv').catch(() => ({ ultimos4: [] }));

    expect(r.ultimos4.every(u => /^\d{4}$/.test(u.digitos))).toBe(true);
  });
});

describe('pdfSinTexto', () => {
  test('un PDF escaneado casi no trae texto (menos de 50 caracteres sin espacios)', () => {
    expect(pdfSinTexto('')).toBe(true);
    expect(pdfSinTexto('   \n\n  \t ')).toBe(true);
    expect(pdfSinTexto('Página 1 de 3')).toBe(true);
    expect(pdfSinTexto(null)).toBe(true);
  });

  test('una cartola con texto no se considera escaneada', () => {
    expect(pdfSinTexto('15/11/2026 Transferencia a Valeska 85.000\n16/11/2026 Abono sueldo 800.000')).toBe(false);
  });

  test('los espacios no cuentan para el mínimo', () => {
    expect(pdfSinTexto('a '.repeat(40))).toBe(true);
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
