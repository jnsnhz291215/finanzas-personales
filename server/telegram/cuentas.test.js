import { parsearCuenta, enmascararDigitos, TIPO_DB, ETIQUETAS_TIPO_DB, esNombreSoloDigitos, nombreAutomatico } from './cuentas.js';

describe('parsearCuenta', () => {
  test('debería interpretar una tarjeta de débito con alias, banco, últimos 4 y titular', () => {
    const r = parsearCuenta(
      '/savecard tarjeta debito FAN banco de chile terminada en 1234 a nombre mio (juan sanhueza)'
    );

    expect(r.tipo).toBe('debito');
    expect(r.banco).toBe('Banco de Chile');
    expect(r.nombre).toBe('FAN');
    expect(r.ultimos4).toBe('1234');
    expect(r.titular).toBe('Juan Sanhueza');
    expect(r.numeroCompletoRechazado).toBe(false);
  });

  test('debería interpretar una tarjeta de crédito CMR con cupo y día de pago', () => {
    const r = parsearCuenta(
      '/savecard tarjeta de crédito CMR falabella terminada en 5678 cupo 110 mil paga el 24 a nombre mio (juan sanhueza)'
    );

    expect(r.tipo).toBe('credito');
    expect(r.banco).toBe('Falabella');
    expect(r.nombre).toBe('CMR');
    expect(r.ultimos4).toBe('5678');
    expect(r.cupo).toBe(110000);
    expect(r.diaPago).toBe(24);
    expect(r.titular).toBe('Juan Sanhueza');
  });

  test('debería interpretar efectivo y usar tipo + banco como nombre si no hay alias', () => {
    const r = parsearCuenta('/nuevacuenta efectivo');

    expect(r.tipo).toBe('efectivo');
    expect(r.banco).toBeNull();
    expect(r.nombre).toBe('Efectivo');
    expect(r.ultimos4).toBeNull();
  });

  test('debería rechazar un número completo de 16 dígitos sin guardarlo ni repetirlo', () => {
    const r = parsearCuenta('/savecard tarjeta debito FAN banco santander 4111 1111 1111 1111');

    expect(r.numeroCompletoRechazado).toBe(true);
    expect(r.ultimos4).toBeNull();
    expect(r.tipo).toBe('debito');
    expect(r.nombre).toBe('FAN');

    const serializado = JSON.stringify(r);
    expect(serializado).not.toContain('4111');
    expect(serializado).not.toContain('1111');
  });

  test('debería rechazar también un número completo sin espacios', () => {
    const r = parsearCuenta('/savecard credito visa 4111111111111111');

    expect(r.numeroCompletoRechazado).toBe(true);
    expect(r.ultimos4).toBeNull();
    expect(JSON.stringify(r)).not.toContain('4111111111111111');
  });

  test('solo acepta 4 dígitos después de "terminada en", "final" o "****"', () => {
    expect(parsearCuenta('/savecard debito FAN final 9876').ultimos4).toBe('9876');
    expect(parsearCuenta('/savecard debito FAN **** 4321').ultimos4).toBe('4321');
    expect(parsearCuenta('/savecard debito FAN termina en 12345').ultimos4).toBeNull();
  });

  test('debería reconocer cuenta RUT, vista, corriente y ahorro con o sin tilde', () => {
    expect(parsearCuenta('/savecard cuenta rut').tipo).toBe('cuenta_vista');
    expect(parsearCuenta('/savecard cuenta rut').banco).toBe('BancoEstado');
    expect(parsearCuenta('/savecard cuenta vista bci').tipo).toBe('cuenta_vista');
    expect(parsearCuenta('/savecard cuenta corriente itau').banco).toBe('Itaú');
    expect(parsearCuenta('/savecard cuenta de ahorro scotiabank').tipo).toBe('ahorro');
    expect(parsearCuenta('/savecard tarjeta de débito santander').tipo).toBe('debito');
    expect(parsearCuenta('/savecard tarjeta de CREDITO ripley').tipo).toBe('credito');
  });

  test('debería reconocer los bancos ignorando tildes y mayúsculas', () => {
    expect(parsearCuenta('/savecard debito BancoEstado').banco).toBe('BancoEstado');
    expect(parsearCuenta('/savecard debito BANCO ESTADO').banco).toBe('BancoEstado');
    expect(parsearCuenta('/savecard debito Banco Security').banco).toBe('Security');
    expect(parsearCuenta('/savecard credito BICE').banco).toBe('BICE');
  });

  test('titular con "a nombre de" y sin tipo reconocible', () => {
    const r = parsearCuenta('/savecard debito FAN a nombre de maria perez');
    expect(r.titular).toBe('Maria Perez');

    const sinTipo = parsearCuenta('/savecard mi tarjeta del trabajo');
    expect(sinTipo.tipo).toBeNull();
  });

  test('debería usar tipo + banco como nombre cuando no queda alias', () => {
    const r = parsearCuenta('/savecard tarjeta debito banco de chile');
    expect(r.nombre).toBe('Tarjeta de débito Banco de Chile');
  });
});

describe('titular', () => {
  const titularOriginal = process.env.TITULAR_POR_DEFECTO;

  beforeEach(() => {
    delete process.env.TITULAR_POR_DEFECTO;
  });

  afterAll(() => {
    if (titularOriginal === undefined) delete process.env.TITULAR_POR_DEFECTO;
    else process.env.TITULAR_POR_DEFECTO = titularOriginal;
  });

  test('"titular yo" no queda en el nombre y usa "Yo" si no hay titular por defecto', () => {
    const r = parsearCuenta('/savecard tarjeta FAN del banco de chile debito terminada en 1234 titular yo');

    expect(r.tipo).toBe('debito');
    expect(r.banco).toBe('Banco de Chile');
    expect(r.nombre).toBe('FAN');
    expect(r.ultimos4).toBe('1234');
    expect(r.titular).toBe('Yo');
  });

  test('"yo", "mio", "mía" y "propia" usan TITULAR_POR_DEFECTO si está definida', () => {
    process.env.TITULAR_POR_DEFECTO = 'Juan Sanhueza';

    expect(parsearCuenta('/savecard debito FAN titular yo').titular).toBe('Juan Sanhueza');
    expect(parsearCuenta('/savecard debito FAN titular: mía').titular).toBe('Juan Sanhueza');
    expect(parsearCuenta('/savecard debito FAN titular propia').titular).toBe('Juan Sanhueza');
    expect(parsearCuenta('/savecard debito FAN a nombre mio').titular).toBe('Juan Sanhueza');
    expect(parsearCuenta('/savecard debito FAN titular yo').nombre).toBe('FAN');
  });

  test('"a nombre mio" sin nombre entre paréntesis usa el titular por defecto', () => {
    const r = parsearCuenta('/savecard debito FAN a nombre mio');

    expect(r.titular).toBe('Yo');
    expect(r.nombre).toBe('FAN');
  });

  test('debería reconocer "a nombre de Juan Sanhueza"', () => {
    const r = parsearCuenta('/savecard tarjeta debito FAN a nombre de Juan Sanhueza');

    expect(r.titular).toBe('Juan Sanhueza');
    expect(r.nombre).toBe('FAN');
  });

  test('debería reconocer "titular: Juan Sanhueza"', () => {
    const r = parsearCuenta('/savecard credito CMR titular: Juan Sanhueza');

    expect(r.titular).toBe('Juan Sanhueza');
    expect(r.nombre).toBe('CMR');
    expect(r.banco).toBe('Falabella');
  });

  test('debería reconocer "de" seguido de un nombre propio al final', () => {
    const r = parsearCuenta('/savecard cuenta vista bci de Juan Sanhueza');

    expect(r.titular).toBe('Juan Sanhueza');
    expect(r.banco).toBe('BCI');
  });

  test('"de FAN" en mayúsculas es un alias, no un titular', () => {
    const r = parsearCuenta('/savecard tarjeta debito de FAN');

    expect(r.titular).toBeNull();
    expect(r.nombre).toBe('FAN');
  });

  test('sin titular queda sin indicar y el nombre no arrastra palabras sueltas', () => {
    const r = parsearCuenta('/savecard debito FAN del banco santander');

    expect(r.titular).toBeNull();
    expect(r.nombre).toBe('FAN');
    expect(r.banco).toBe('Santander');
  });
});

describe('cuenta terminada en (ultimos4Cuenta)', () => {
  test('"cuenta terminada en 1234" llena ultimos4Cuenta y no ultimos4', () => {
    const r = parsearCuenta('/savecard cuenta corriente FAN banco de chile cuenta terminada en 1234');

    expect(r.ultimos4Cuenta).toBe('1234');
    expect(r.ultimos4).toBeNull();
    expect(r.tipo).toBe('cuenta_corriente');
    expect(r.nombre).toBe('FAN');
  });

  test('tarjeta y cuenta en el mismo texto', () => {
    const r = parsearCuenta('/savecard tarjeta debito FAN banco de chile terminada en 6958 cuenta terminada en 1234');

    expect(r.ultimos4).toBe('6958');
    expect(r.ultimos4Cuenta).toBe('1234');
    expect(r.tipo).toBe('debito');
  });

  test('"cuenta corriente terminada en" conserva el tipo', () => {
    const r = parsearCuenta('/savecard FAN banco estado cuenta vista terminada en 4321');

    expect(r.tipo).toBe('cuenta_vista');
    expect(r.ultimos4Cuenta).toBe('4321');
    expect(r.banco).toBe('BancoEstado');
  });

  test('sin "cuenta" delante, "terminada en" sigue siendo de la tarjeta', () => {
    const r = parsearCuenta('/savecard tarjeta debito FAN terminada en 1234');

    expect(r.ultimos4).toBe('1234');
    expect(r.ultimos4Cuenta).toBeNull();
  });

  test('un número largo de cuenta se rechaza y no se guarda ningún dígito', () => {
    const r = parsearCuenta('/savecard cuenta vista FAN 00123456789012345');

    expect(r.numeroCompletoRechazado).toBe(true);
    expect(r.ultimos4Cuenta).toBeNull();
    expect(JSON.stringify(r)).not.toContain('0012345');
  });
});

describe('tipo efectivo', () => {
  test('efectivo se guarda como efectivo, no como cuenta_vista', () => {
    expect(TIPO_DB.efectivo).toBe('efectivo');
    expect(TIPO_DB.cuenta_vista).toBe('cuenta_vista');
    expect(ETIQUETAS_TIPO_DB.efectivo).toBe('Efectivo');
  });

  test('"efectivo" con un alias usa el alias como nombre', () => {
    const r = parsearCuenta('/savecard efectivo billetera');

    expect(r.tipo).toBe('efectivo');
    expect(r.nombre).toBe('billetera');
    expect(r.banco).toBeNull();
  });
});

describe('enmascararDigitos', () => {
  test('reemplaza números largos antes de enviarlos a un servicio externo', () => {
    expect(enmascararDigitos('tarjeta 4111 1111 1111 1111 terminada en 1234'))
      .toBe('tarjeta [número] terminada en 1234');
    expect(enmascararDigitos('cuenta 12345678901')).toBe('cuenta [número]');
  });
});

describe('el nombre nunca es solo dígitos', () => {
  test('/savecard tarjeta 8263 ya no usa los dígitos como nombre', () => {
    expect(parsearCuenta('/savecard tarjeta 8263').nombre).toBeNull();
    expect(parsearCuenta('/savecard tarjeta credito 8263').nombre).toBe('Tarjeta de crédito');
    expect(parsearCuenta('/savecard tarjeta debito FAN terminada en 1234').nombre).toBe('FAN');
  });

  test('detecta nombres que son solo dígitos o máscara', () => {
    expect(['8263', '**** 8263', '12 34', ''].map(esNombreSoloDigitos)).toEqual([true, true, true, true]);
    expect(['Mi FAN', 'Crédito Valeska ****8263'].map(esNombreSoloDigitos)).toEqual([false, false]);
  });

  test('nombre automático: tipo, primer nombre del titular y los 4 dígitos', () => {
    expect(nombreAutomatico({ tipo: 'credito', titular: 'Valeska Sanhueza', ultimos4: '8263' })).toBe('Crédito Valeska ****8263');
    expect(nombreAutomatico({ tipo: 'tarjeta_debito', titular: 'Juan', ultimos4: '5555' })).toBe('Débito Juan ****5555');
    expect(nombreAutomatico({ tipo: 'cuenta_vista', titular: null, ultimos4Cuenta: '1234' })).toBe('Cuenta vista ****1234');
  });
});
