import {
  aFechaISO,
  fechaCorta,
  dentroDeVentana,
  filaSerializable,
  contadorTrasQuitarPago,
  etiquetaTipo,
  VENTANA_DESHACER_MS
} from './registros.js';

describe('fechas', () => {
  test('aFechaISO usa los componentes locales de un Date y corta los textos', () => {
    expect(aFechaISO(new Date(2026, 10, 5))).toBe('2026-11-05');
    expect(aFechaISO('2026-11-05T00:00:00.000Z')).toBe('2026-11-05');
  });

  test('fechaCorta muestra DD-MM-YYYY', () => {
    expect(fechaCorta('2026-11-05')).toBe('05-11-2026');
  });
});

describe('ventana de 24 horas para deshacer', () => {
  test('vale mientras no pasen 24 horas', () => {
    const t = 1_000_000;
    expect(dentroDeVentana(t, t + 1000)).toBe(true);
    expect(dentroDeVentana(t, t + VENTANA_DESHACER_MS - 1)).toBe(true);
    expect(dentroDeVentana(t, t + VENTANA_DESHACER_MS)).toBe(false);
    expect(dentroDeVentana('x')).toBe(false);
  });
});

describe('filaSerializable', () => {
  test('pasa las fechas a texto local, deja el resto y quita actualizado_en', () => {
    const fila = filaSerializable({
      id: 3,
      fecha: new Date(2026, 10, 5),
      creado_en: new Date(2026, 10, 5, 14, 30, 9),
      actualizado_en: new Date(),
      monto: '5500.00'
    });
    expect(fila).toEqual({ id: 3, fecha: '2026-11-05', creado_en: '2026-11-05 14:30:09', monto: '5500.00' });
  });
});

describe('contadorTrasQuitarPago', () => {
  test('solo retrocede si era la última cuota pagada', () => {
    expect(contadorTrasQuitarPago(7, 7)).toBe(6);
    expect(contadorTrasQuitarPago(7, 5)).toBe(7);
    expect(contadorTrasQuitarPago(12, 12)).toBe(11);
    expect(contadorTrasQuitarPago(3, null)).toBe(3);
  });
});

describe('etiquetaTipo', () => {
  test('nombra cada tipo de registro', () => {
    expect(etiquetaTipo('pago_cuota')).toBe('pago de cuota');
    expect(etiquetaTipo('importacion')).toBe('importación de cartola');
    expect(etiquetaTipo('otro')).toBe('registro');
  });
});
