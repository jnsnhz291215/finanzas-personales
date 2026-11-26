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

describe('fecha de una fila de tarjeta (año de 2 o 4 dígitos pegado al código)', () => {
  const opciones = { anioActual: 2026 };

  test('dd/mm/aa seguido del código: no toma el código como parte del año', () => {
    const f = parsearFilaTarjeta('SANTIAGO02/09/260212345678 APPLE.COM CL TASA INT. 0,00% $ 260.988 $ 260.98807/12 $ 202.332', opciones);
    expect(f.fecha).toBe('2026-09-02');
    expect(f.cuota).toMatchObject({ actual: 7, total: 12 });
  });

  test('"08/05/2617" (año 26 y código 17...) se lee como 2026-05-08', () => {
    const f = parsearFilaTarjeta('LAS CONDES08/05/2617 WEPLAY WEB TASA INT. 0,00% $ 100.000 $ 100.00003/06 $ 13.915', opciones);
    expect(f.fecha).toBe('2026-05-08');
  });

  test('dd/mm/aa sin código, seguido de la descripción', () => {
    const f = parsearFilaTarjeta('17/09/26 COMISION ADMINISTRACION $ 3.000 $ 3.00001/01 $ 3.000', opciones);
    expect(f.fecha).toBe('2026-09-17');
    expect(f.cuota).toBeUndefined();
  });

  test('dd/mm/aaaa con código sigue leyéndose con 4 dígitos', () => {
    const f = parsearFilaTarjeta('SANTIAGO02/09/20260212345678 TIENDA $ 20.000 $ 20.00001/01 $ 20.000', opciones);
    expect(f.fecha).toBe('2026-09-02');
  });

  test('una fecha imposible se descarta y usa la del período; sin período, la fila se descarta', () => {
    const fila = 'SANTIAGO99/99/99 TIENDA $ 20.000 $ 20.00001/01 $ 20.000';
    expect(parsearFilaTarjeta(fila, opciones)).toBeNull();
    expect(parsearFilaTarjeta(fila, { ...opciones, fechaRespaldo: '2026-09-17' }).fecha).toBe('2026-09-17');
  });

  test('en el texto completo, una fila con fecha ilegible toma la del período', () => {
    const r = movimientosDesdeTextoPDF('PERIODO FACTURADO 02/09/26 al 17/09/26\nX99/99/99 TIENDA $ 20.000 $ 20.00001/01 $ 20.000\n02/09/26 COMISION ADMINISTRACION $ 3.000 $ 3.00001/01 $ 3.000', opciones);
    expect(r.movimientos.map(m => m.fecha).sort()).toEqual(['2026-09-02', '2026-09-17']);
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

describe('cuotas repetidas en un lote de cartolas', () => {
  const fila = (n) => ({
    fecha: '2026-05-08', descripcion: `APPLE.COM CL APPLE 0${n}/12`, monto: 21749, tipo: 'cargo',
    cuota: { actual: n, total: 12, valorCuota: 21749, montoOperacion: 260988, tasa: '0,00' }
  });

  test('la misma compra en varias cartolas se reconoce y se queda la cuota más alta', async () => {
    const { mejoresCuotasDeLote, claveCuotaDeLote } = await import('./terceros.js');
    expect(claveCuotaDeLote(fila(6))).toBe(claveCuotaDeLote(fila(7)));
    const mejores = mejoresCuotasDeLote([{ movimientos: [fila(5), fila(6)] }, { movimientos: [fila(7)] }]);
    expect(mejores.size).toBe(1);
    expect([...mejores.values()][0].actual).toBe(7);
  });
});
