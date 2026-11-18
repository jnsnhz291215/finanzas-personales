import { parsearCuenta, enmascararDigitos, TIPO_DB, ETIQUETAS_TIPO_DB } from './cuentas.js';

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
