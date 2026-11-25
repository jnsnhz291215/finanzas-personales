import {
  parsearDatos,
  normalizarRut,
  formatearRut,
  calcularDV,
  detectarConsultaDatos,
  buscarRegistros,
  textoPlanoDatos,
  camposFaltantes
} from './datosTransferencia.js';
import { parsearMensaje } from './parser.js';

describe('RUT', () => {
  test('calcularDV usa módulo 11 y acepta K', () => {
    expect(calcularDV('12345678')).toBe('5');
    expect(calcularDV('10000013')).toBe('K');
  });

  test('normalizarRut acepta con o sin puntos y guion', () => {
    expect(normalizarRut('12.345.678-5')).toBe('12345678-5');
    expect(normalizarRut('12345678-5')).toBe('12345678-5');
    expect(normalizarRut('123456785')).toBe('12345678-5');
  });

  test('normalizarRut acepta K en mayúscula o minúscula', () => {
    expect(normalizarRut('10.000.013-K')).toBe('10000013-K');
    expect(normalizarRut('10000013-k')).toBe('10000013-K');
  });

  test('normalizarRut rechaza un dígito verificador inválido', () => {
    expect(normalizarRut('12.345.678-9')).toBeNull();
    expect(normalizarRut('10.000.013-5')).toBeNull();
  });

  test('formatearRut vuelve a poner los puntos', () => {
    expect(formatearRut('12345678-5')).toBe('12.345.678-5');
    expect(formatearRut('10000013-K')).toBe('10.000.013-K');
  });
});

describe('parsearDatos', () => {
  test('debería interpretar el ejemplo completo', () => {
    const r = parsearDatos(
      '/savetrans mercado pago cuenta vista 1234567890 juan sanhueza rut 12.345.678-5 correo juan@mail.com'
    );

    expect(r.banco).toBe('Mercado Pago');
    expect(r.alias).toBe('Mercado Pago');
    expect(r.tipoCuenta).toBe('vista');
    expect(r.numeroCuenta).toBe('1234567890');
    expect(r.titular).toBe('Juan Sanhueza');
    expect(r.rut).toBe('12345678-5');
    expect(r.rutInvalido).toBe(false);
    expect(r.email).toBe('juan@mail.com');
    expect(camposFaltantes(r)).toEqual([]);
  });

  test('un RUT con dígito verificador inválido no se guarda y se avisa', () => {
    const r = parsearDatos('/savetrans mercado pago cuenta vista 1234567890 juan sanhueza rut 12.345.678-9');

    expect(r.rut).toBeNull();
    expect(r.rutInvalido).toBe(true);
    expect(camposFaltantes(r)).toContain('rut');
  });

  test('un RUT con dígito verificador K', () => {
    const r = parsearDatos('/savetrans tenpo cuenta vista 5551234 pedro soto rut 10.000.013-K');

    expect(r.rut).toBe('10000013-K');
    expect(r.rutInvalido).toBe(false);
  });

  test('un RUT sin puntos', () => {
    const r = parsearDatos('/savetrans mach cuenta vista 7776655 ana diaz rut 12345678-5');

    expect(r.rut).toBe('12345678-5');
    expect(r.banco).toBe('MACH');
  });

  test('una cuenta RUT sin número usa el RUT sin dígito verificador', () => {
    const r = parsearDatos('/savetrans banco estado cuenta rut juan perez rut 12345678-5');

    expect(r.tipoCuenta).toBe('rut');
    expect(r.banco).toBe('BancoEstado');
    expect(r.numeroCuenta).toBe('12345678');
    expect(r.rut).toBe('12345678-5');
  });

  test('un alias explícito reemplaza al nombre del banco', () => {
    const r = parsearDatos('/savetrans banco de chile cuenta corriente 98765432 alias sueldo juan perez rut 12.345.678-5');

    expect(r.banco).toBe('Banco de Chile');
    expect(r.alias).toBe('sueldo');
    expect(r.tipoCuenta).toBe('corriente');
    expect(r.numeroCuenta).toBe('98765432');
    expect(r.titular).toBe('Juan Perez');
  });

  test('reconoce las instituciones nuevas', () => {
    expect(parsearDatos('/savetrans tenpo cuenta vista 1234567').banco).toBe('Tenpo');
    expect(parsearDatos('/savetrans coopeuch cuenta vista 1234567').banco).toBe('Coopeuch');
    expect(parsearDatos('/savetrans prepago los heroes cuenta vista 1234567').banco).toBe('Prepago Los Héroes');
  });

  test('lo que falta se reporta como campo faltante', () => {
    const r = parsearDatos('/savetrans mercado pago cuenta vista 1234567890');

    expect(camposFaltantes(r)).toEqual(['titular', 'rut']);
  });
});

describe('detectarConsultaDatos', () => {
  test('detecta "pásame los datos de transferencia de la mercado pago"', () => {
    expect(detectarConsultaDatos('pásame los datos de transferencia de la mercado pago'))
      .toEqual({ termino: 'mercado pago' });
  });

  test('detecta otras formas de pedirlos', () => {
    expect(detectarConsultaDatos('datos de la FAN')).toEqual({ termino: 'fan' });
    expect(detectarConsultaDatos('mis datos del banco de chile')).toEqual({ termino: 'chile' });
    expect(detectarConsultaDatos('pasame los datos')).toEqual({ termino: null });
  });

  test('"pagué 5 mil en la mercado pago" sigue siendo un gasto', () => {
    expect(detectarConsultaDatos('pagué 5 mil en la mercado pago')).toBeNull();

    const gasto = parsearMensaje('pagué 5 mil en la mercado pago');
    expect(gasto.monto).toBe(5000);
    expect(gasto.tipoMovimiento).toBe('compra');
  });

  test('un mensaje con monto nunca es una consulta', () => {
    expect(detectarConsultaDatos('gasté 5 lucas en datos del celular')).toBeNull();
  });

  test('los comandos no se tratan como consulta en lenguaje natural', () => {
    expect(detectarConsultaDatos('/datos mercado pago')).toBeNull();
  });
});

describe('buscarRegistros y respuesta', () => {
  const registros = [
    {
      id: 1, alias: 'Mercado Pago', nombre_titular: 'Juan Sanhueza', rut: '12345678-5',
      banco: 'Mercado Pago', tipo_cuenta: 'vista', numero_cuenta: '1234567890', email: 'juan@mail.com'
    },
    {
      id: 2, alias: 'FAN', nombre_titular: 'Juan Sanhueza', rut: '12345678-5',
      banco: 'Banco de Chile', tipo_cuenta: 'corriente', numero_cuenta: '98765432', email: null
    }
  ];

  test('busca por alias o banco ignorando tildes, mayúsculas y artículos', () => {
    expect(buscarRegistros(registros, 'mercado pago').map(r => r.id)).toEqual([1]);
    expect(buscarRegistros(registros, 'la FAN').map(r => r.id)).toEqual([2]);
    expect(buscarRegistros(registros, 'banco de chile').map(r => r.id)).toEqual([2]);
    expect(buscarRegistros(registros, 'inexistente')).toEqual([]);
  });

  test('responde en texto plano, un campo por línea y sin etiquetas HTML', () => {
    const texto = textoPlanoDatos(registros[0]);

    expect(texto).toBe(
      'Juan Sanhueza\n12.345.678-5\nMercado Pago\nCuenta Vista\n1234567890\njuan@mail.com'
    );
    expect(texto).not.toMatch(/[<>]/);
  });

  test('sin correo no deja una línea vacía', () => {
    expect(textoPlanoDatos(registros[1]).split('\n')).toHaveLength(5);
  });
});
