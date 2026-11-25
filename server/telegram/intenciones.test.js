import { clasificarPorReglas, puedeEnviarseAGemini, limpiarBusqueda } from './intenciones.js';

const intencion = (texto) => clasificarPorReglas(texto)?.intencion ?? null;

describe('clasificarPorReglas', () => {
  test('registrar un gasto o un ingreso', () => {
    expect(intencion('almuerzo 5500 débito falabella')).toBe('registrar');
    expect(intencion('me pagaron 400 mil')).toBe('registrar');
    expect(intencion('ayer pagué 12.500 en el super')).toBe('registrar');
  });

  test('pagar una cuota', () => {
    expect(intencion('pagué cuota tía mac 7/12')).toBe('pagar_cuota');
    expect(intencion('pagué la cuota del mac')).toBe('pagar_cuota');
  });

  test('nueva compra en cuotas', () => {
    expect(intencion('compré audífonos en 6 cuotas de 15 mil con la tarjeta de la tía')).toBe('nueva_compra_cuotas');
  });

  test('consultar gastos o totales', () => {
    expect(intencion('cuánto gasté este mes')).toBe('consultar_gastos');
    expect(intencion('cuánto llevo en comida')).toBe('consultar_gastos');
  });

  test('plan de ahorro', () => {
    expect(intencion('cuánto puedo gastar')).toBe('plan');
    expect(intencion('cuánto debería ahorrar')).toBe('plan');
  });

  test('datos de transferencia: solo el nombre de la cuenta, nunca más', () => {
    const r = clasificarPorReglas('pásame los datos de la mercado pago');

    expect(r.intencion).toBe('datos_transferencia');
    expect(r.datos).toEqual({ termino: 'mercado pago' });
  });

  test('cuentas', () => {
    expect(intencion('qué cuentas tengo')).toBe('cuentas');
    expect(intencion('mis cuentas')).toBe('cuentas');
  });

  test('cuotas pendientes', () => {
    expect(intencion('cuánto le debo a la tía')).toBe('cuotas_pendientes');
    expect(intencion('cuántas cuotas me quedan del mac')).toBe('cuotas_pendientes');
    expect(clasificarPorReglas('cuáles son mis cuotas pendientes').datos).toEqual({ lista: true });
  });

  test('buscar movimientos, sin las palabras de relleno', () => {
    const r = clasificarPorReglas('busca uber de octubre');

    expect(r.intencion).toBe('buscar');
    expect(r.datos.texto).toBe('uber octubre');
  });

  test('ayuda', () => {
    expect(intencion('qué puedes hacer')).toBe('ayuda');
    expect(intencion('cómo funciona esto')).toBe('ayuda');
  });

  test('lo que no calza con ninguna regla queda sin clasificar (se pregunta o se consulta a Gemini)', () => {
    expect(intencion('hola')).toBeNull();
    expect(intencion('gracias')).toBeNull();
    expect(intencion('almuerzo')).toBeNull();
    expect(intencion('')).toBeNull();
  });

  test('los comandos no pasan por el enrutador', () => {
    expect(intencion('/plan')).toBeNull();
    expect(intencion('/savecard efectivo')).toBeNull();
  });

  test('la confianza de las reglas es alta y el origen es "reglas"', () => {
    expect(clasificarPorReglas('almuerzo 5500')).toMatchObject({ confianza: 'alta', origen: 'reglas' });
  });
});

describe('puedeEnviarseAGemini', () => {
  test('mensajes normales sí', () => {
    expect(puedeEnviarseAGemini('almuerzo 5500 débito')).toBe(true);
    expect(puedeEnviarseAGemini('cuánto llevo en comida')).toBe(true);
  });

  test('nunca RUT, correos, números de cuenta ni datos de transferencia', () => {
    expect(puedeEnviarseAGemini('mi rut es 12.345.678-5')).toBe(false);
    expect(puedeEnviarseAGemini('12345678-5')).toBe(false);
    expect(puedeEnviarseAGemini('escríbeme a juan@mail.com')).toBe(false);
    expect(puedeEnviarseAGemini('cuenta vista 1234567890')).toBe(false);
    expect(puedeEnviarseAGemini('transferí a la cuenta 123456789012')).toBe(false);
    expect(puedeEnviarseAGemini('mi tarjeta 4111 1111 1111 1111')).toBe(false);
    expect(puedeEnviarseAGemini('guarda mis datos de transferencia')).toBe(false);
    expect(puedeEnviarseAGemini('titular Juan Sanhueza')).toBe(false);
  });
});

describe('limpiarBusqueda', () => {
  test('quita las palabras de relleno y conserva el texto y el mes', () => {
    expect(limpiarBusqueda('uber de octubre')).toBe('uber octubre');
    expect(limpiarBusqueda('los gastos del mes pasado')).toBe('mes pasado');
    expect(limpiarBusqueda('')).toBe('');
  });
});
