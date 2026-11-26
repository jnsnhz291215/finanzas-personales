import { interpretarConsultaEstado, cuentasQueCalzan, resumirMes, aniosDe, nombreMes, mesDeArchivo } from './estadoCuenta.js';

const cuentas = [
  { id: 1, nombre: 'Crédito Valeska ****8263', tipo: 'tarjeta_credito', titular: 'Valeska Sanhueza', ultimos4: '8263' },
  { id: 2, nombre: 'Débito Juan', tipo: 'tarjeta_debito', titular: null, ultimos4: '1111' }
];

describe('interpretarConsultaEstado', () => {
  test.each([
    'estado cuenta tarjeta 8263',
    'estado de cuenta de la 8263',
    'cartolas de la 8263'
  ])('"%s" pide la cuenta 8263', (texto) => {
    expect(interpretarConsultaEstado(texto)).toMatchObject({ digitos: '8263', explicito: true });
  });

  test('historial de la tarjeta de Valeska trae el titular', () => {
    expect(interpretarConsultaEstado('historial de la tarjeta de Valeska')).toMatchObject({ titular: 'Valeska' });
  });

  test('el texto de una cartola que se envía no es una consulta', () => {
    expect(interpretarConsultaEstado('cartola de la 8263')).toBeNull();
    expect(interpretarConsultaEstado('son de la tarjeta 8263')).toBeNull();
    expect(interpretarConsultaEstado('estado cuenta 5500 pesos')).toBeNull();
  });
});

describe('cuentasQueCalzan', () => {
  test('por dígitos y por titular', () => {
    expect(cuentasQueCalzan(interpretarConsultaEstado('cartolas de la 8263'), cuentas).map(c => c.id)).toEqual([1]);
    expect(cuentasQueCalzan(interpretarConsultaEstado('historial de la tarjeta de Valeska'), cuentas).map(c => c.id)).toEqual([1]);
  });
});

describe('resumirMes', () => {
  test('cuenta cargos y abonos, detecta cuotas y suma marcados e ignorados', () => {
    const r = resumirMes([
      { tipo: 'cargo', monto: 100, descripcion: 'MERCADOLIBRE 06/12' },
      { tipo: 'cargo', monto: 50, descripcion: 'x', compra_cuota_id: 3, numero_cuota: 6, compra_alias: 'macbook', compra_total: 12 },
      { tipo: 'abono', monto: 10, descripcion: 'pago' }
    ], [{ marcados_mios: 2, ignorados: 5 }]);
    expect(r).toMatchObject({ cargos: 2, totalCargos: 150, abonos: 1, totalAbonos: 10, marcadosMios: 2, ignorados: 5 });
    expect(r.cuotas).toContain('Macbook 6/12');
  });

  test('sin cartolas de terceros no hay marcados ni ignorados', () => {
    expect(resumirMes([], [{ marcados_mios: null }])).toMatchObject({ marcadosMios: null, ignorados: null });
  });
});

describe('meses y años', () => {
  test('aniosDe ordena del más reciente', () => {
    expect(aniosDe(['2025-12', '2026-01', '2026-02'])).toEqual(['2026', '2025']);
  });

  test('nombreMes', () => {
    expect(nombreMes('2026-05')).toBe('mayo 2026');
  });

  test('la cartola es del mes del final de su período', () => {
    expect(mesDeArchivo({ periodo_hasta: '2026-05-14', fecha_importacion: '2026-06-01' })).toBe('2026-05');
    expect(mesDeArchivo({ periodo_hasta: null, ruta_archivo: 'a', fecha_importacion: '2026-06-01' }, new Map([['a', { hasta: '2026-04-30' }]]))).toBe('2026-04');
  });
});
