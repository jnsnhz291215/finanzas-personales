import { validarEdicion, etiquetaCuenta, leerCuatroDigitos, valorActual, CAMPOS, CAMPO_POR_CODIGO } from './edicionCuentas.js';

const fan = { id: 1, nombre: 'FAN', tipo: 'tarjeta_debito', banco: 'Banco de Chile', titular: 'Juan Sanhueza', ultimos4: '5555', ultimos4_cuenta: '1234', activa: 1, predeterminada: 0 };
const cmr = { id: 2, nombre: 'CMR', tipo: 'tarjeta_credito', banco: 'Falabella', titular: 'Valeska', ultimos4: '8263', ultimos4_cuenta: null, activa: 1, predeterminada: 0 };
const otraDebito = { id: 3, nombre: 'Otra', tipo: 'tarjeta_debito', banco: null, titular: null, ultimos4: '9999', ultimos4_cuenta: null, activa: 1 };
const todas = [fan, cmr, otraDebito];

describe('lista y datos', () => {
  test('cada cuenta se muestra como "nombre · tipo · ****1234 · titular"', () => {
    expect(etiquetaCuenta(cmr)).toBe('CMR · Tarjeta de crédito · ****8263 · Valeska');
    expect(etiquetaCuenta({ ...otraDebito })).toBe('Otra · Tarjeta de débito · ****9999 · sin titular');
    expect(etiquetaCuenta({ nombre: 'Efectivo', tipo: 'efectivo' })).toBe('Efectivo · Efectivo · sin dígitos · sin titular');
  });

  test('cada campo tiene su código para los botones', () => {
    expect(Object.keys(CAMPOS)).toEqual(['nombre', 'tipo', 'banco', 'titular', 'ultimos4', 'cuenta', 'predeterminada']);
    for (const [campo, c] of Object.entries(CAMPOS)) expect(CAMPO_POR_CODIGO[c.codigo]).toBe(campo);
    expect(valorActual(cmr, 'ultimos4')).toBe('****8263');
  });
});

describe('validación de cada campo', () => {
  test('el nombre no puede ser solo dígitos ni quedar vacío', () => {
    expect(validarEdicion(cmr, 'nombre', 'Crédito Valeska', todas)).toMatchObject({ ok: true, valor: 'Crédito Valeska' });
    expect(validarEdicion(cmr, 'nombre', '8263', todas).ok).toBe(false);
    expect(validarEdicion(cmr, 'nombre', '   ', todas).ok).toBe(false);
  });

  test('los dígitos son exactamente 4 y un número largo se rechaza', () => {
    expect(validarEdicion(cmr, 'ultimos4', '4321', todas)).toMatchObject({ ok: true, valor: '4321', texto: '****4321' });
    expect(validarEdicion(cmr, 'ultimos4', '432', todas).ok).toBe(false);
    const largo = validarEdicion(cmr, 'ultimos4', '4111 1111 1111 1111', todas);
    expect(largo).toMatchObject({ ok: false, largo: true });
    expect(JSON.stringify(largo)).not.toContain('4111');
    expect(leerCuatroDigitos('****8263')).toEqual({ digitos: '8263' });
  });

  test('no quedan dos cuentas con los mismos 4 dígitos y el mismo tipo', () => {
    // otraDebito y fan son del mismo tipo: 5555 ya está en FAN
    expect(validarEdicion(otraDebito, 'ultimos4', '5555', todas).ok).toBe(false);
    // la tarjeta de crédito sí puede tener 5555 (otro tipo)
    expect(validarEdicion(cmr, 'ultimos4', '5555', todas).ok).toBe(true);
    // cambiar el tipo también lo cuida: pasar CMR a débito con un dígito ya usado por otra débito
    const choca = { ...cmr, ultimos4: '9999' };
    expect(validarEdicion(choca, 'tipo', 'tarjeta_debito', todas).ok).toBe(false);
    expect(validarEdicion(cmr, 'tipo', 'tarjeta_debito', todas).ok).toBe(true);
  });

  test('banco, titular y cuenta vinculada', () => {
    expect(validarEdicion(cmr, 'banco', 'banco de chile', todas)).toMatchObject({ ok: true, valor: 'Banco de Chile' });
    expect(validarEdicion(cmr, 'banco', 'quitar', todas)).toMatchObject({ ok: true, valor: null });
    expect(validarEdicion(cmr, 'titular', 'valeska sanhueza', todas)).toMatchObject({ ok: true, valor: 'Valeska Sanhueza' });
    expect(validarEdicion(cmr, 'titular', 'Valeska 2', todas).ok).toBe(false);
  });

  test('la cuenta vinculada con 4 dígitos que ya tiene otra del mismo tipo se rechaza; de otro tipo, se acepta', () => {
    const debito = { ...otraDebito };
    expect(validarEdicion(debito, 'cuenta', '1234', todas).ok).toBe(false);
    expect(validarEdicion(cmr, 'cuenta', '1234', todas).ok).toBe(true);
  });

  test('predeterminada acepta sí y no', () => {
    expect(validarEdicion(cmr, 'predeterminada', true, todas)).toMatchObject({ ok: true, valor: true, texto: 'sí' });
    expect(validarEdicion(cmr, 'predeterminada', false, todas)).toMatchObject({ ok: true, valor: false, texto: 'no' });
  });
});
