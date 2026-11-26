import { parsearFilaTarjeta, movimientosDesdeTextoPDF } from '../cartolas.js';
import { claveCompra } from '../cargosCartola.js';
import { esCargoBanco, tieneTasaInteres, nombreSugerido } from './terceros.js';

// Fila como la entrega el texto extraído del PDF (datos inventados): el código va pegado a la fecha y el número de cuota, al segundo monto
const FILA = ' LAS CONDES08/05/20261234567890 APPLE.COM CL APPLE      TASA INT.  0,00% $        260.988 $        260.98806/12 $         21.749';

describe('fila de un estado de cuenta de tarjeta', () => {
  test('une la cuota con su descripción y toma el valor de la cuota como monto', () => {
    const f = parsearFilaTarjeta(FILA);
    expect(f).toMatchObject({ fecha: '2026-05-08', monto: 21749, tipo: 'cargo' });
    expect(f.cuota).toMatchObject({ actual: 6, total: 12, valorCuota: 21749, montoOperacion: 260988 });
    expect(f.descripcion).toContain('06/12');
  });

  test('una compra a una sola cuota (01/01) no es una cuota', () => {
    const f = parsearFilaTarjeta('08/05/20261234567890 COMISION MANTENCION $          1.500 $          1.50001/01 $          1.500');
    expect(f.cuota).toBeUndefined();
    expect(f.monto).toBe(1500);
  });

  test('la cuota 00/NN todavía no se cobra', () => {
    expect(parsearFilaTarjeta('08/05/20261234567890 TIENDA TASA INT. 0,00% $ 124.221 $ 124.22100/03 $ 41.407')).toBeNull();
  });

  test('un monto negativo es un abono', () => {
    const f = parsearFilaTarjeta('08/05/20261234567890 MONTO CANCELADO $ -50.000 $ -50.00001/01 $ -50.000');
    expect(f.tipo).toBe('abono');
  });

  test('el texto del PDF con esas filas se lee por reglas', () => {
    const r = movimientosDesdeTextoPDF(`${FILA}\n${FILA.replace('21.749', '202.332')}\n08/05/20261234567890 COMISION MANTENCION $ 1.500 $ 1.50001/01 $ 1.500`);
    expect(r.movimientos).toHaveLength(3);
    expect(r.filasTarjeta).toBe(3);
  });
});

describe('cargos del banco y tasa de interés', () => {
  test('reconoce los cargos del banco', () => {
    for (const d of ['COMISION ADMINISTRACION', 'IMPUESTO DECRETO LEY 3475 TASA 0,03 %', 'INTERESES ROTATIVOS', 'INTERES DE MORA']) {
      expect(esCargoBanco(d)).toBe(true);
    }
    expect(esCargoBanco('SUPERMERCADO LIDER')).toBe(false);
  });

  test('TASA INT. marca una compra en cuotas y el nombre sugerido sale del comercio', () => {
    expect(tieneTasaInteres('APPLE.COM CL APPLE TASA INT. 0,00%')).toBe(true);
    expect(nombreSugerido('APPLE.COM CL APPLE TASA INT. 0,00% 06/12')).toBe('Apple');
  });

  test('la misma compra de otro mes tiene la misma clave', () => {
    const a = { fecha: '2026-05-08', descripcion: 'APPLE.COM CL APPLE TASA INT. 0,00% 06/12', monto: 21749 };
    expect(claveCompra(a)).toBe(claveCompra({ ...a, descripcion: 'APPLE.COM CL APPLE TASA INT. 0,00% 07/12' }));
    expect(claveCompra(a)).not.toBe(claveCompra({ ...a, monto: 202332 }));
  });
});
