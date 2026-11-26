import { clasificarPorReglas, puedeEnviarseAGemini, limpiarBusqueda, clasificarReply, detectarEliminarUltimo, replyDesdeGemini, detectarAsignarDigitos, detectarReset, detectarGuardarCuenta, detectarEditarCuenta } from './intenciones.js';

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

describe('respuestas a un registro (clasificarReply)', () => {
  const cuentas = [
    { id: 1, nombre: 'FAN', banco: 'Banco de Chile', tipo: 'tarjeta_debito' },
    { id: 2, nombre: 'CMR', banco: 'Falabella', tipo: 'tarjeta_credito' }
  ];
  const categorias = [{ id: 1, nombre: 'Comida' }, { id: 2, nombre: 'Transporte' }];
  const hoy = '2026-11-25';
  const reply = (texto) => clasificarReply(texto, { cuentas, categorias, hoy });

  test('eliminar', () => {
    for (const t of ['elimina esto', 'eliminar', 'bórralo', 'me equivoqué, sácalo']) {
      expect(reply(t)?.accion).toBe('eliminar');
    }
  });

  test('deshacer', () => {
    expect(reply('deshacer')?.accion).toBe('deshacer');
    expect(reply('deshazlo')?.accion).toBe('deshacer');
  });

  test('corregir el monto', () => {
    expect(reply('eran 4500').cambios).toEqual({ monto: 4500 });
    expect(reply('4.500').cambios).toEqual({ monto: 4500 });
    expect(reply('eran 57 mil').cambios).toEqual({ monto: 57000 });
  });

  test('corregir la cuenta por banco, nombre o tipo', () => {
    expect(reply('era con la falabella').cambios).toEqual({ cuenta_id: 2 });
    expect(reply('con la FAN').cambios).toEqual({ cuenta_id: 1 });
    expect(reply('era con la tarjeta de débito').cambios).toEqual({ cuenta_id: 1 });
  });

  test('corregir la categoría y avisar si no existe', () => {
    expect(reply('la categoría es comida').cambios).toEqual({ categoria_id: 1 });
    expect(reply('la categoría es viajes').problemas[0]).toMatch(/viajes/);
  });

  test('corregir la fecha', () => {
    expect(reply('fue ayer').cambios).toEqual({ fecha: '2026-11-24' });
    expect(reply('fue el 15').cambios).toEqual({ fecha: '2026-11-15' });
    expect(reply('15/11').cambios).toEqual({ fecha: '2026-11-15' });
    expect(reply('fue el lunes').cambios).toEqual({ fecha: '2026-11-23' });
  });

  test('un texto que no es ninguna acción no se interpreta', () => {
    expect(reply('hola, qué tal')).toBeNull();
    expect(reply('almuerzo 5500 débito')).toBeNull();
  });

  test('"elimina el último gasto" sin responder a nada', () => {
    expect(detectarEliminarUltimo('elimina el último gasto')).toBe(true);
    expect(detectarEliminarUltimo('borra el último')).toBe(true);
    expect(detectarEliminarUltimo('borra los últimos 3')).toBe(false);
    expect(intencion('borra el último gasto')).toBe('eliminar_ultimo');
  });

  test('la respuesta de Gemini se resuelve con las cuentas y categorías reales', () => {
    const r = replyDesdeGemini({ accion: 'corregir', monto: 4500, fecha: null, cuenta: 'CMR', categoria: 'Comida' }, { cuentas, categorias, hoy });
    expect(r.cambios).toEqual({ monto: 4500, cuenta_id: 2, categoria_id: 1 });
    expect(replyDesdeGemini({ accion: 'eliminar' }, { cuentas, categorias, hoy }).accion).toBe('eliminar');
    expect(replyDesdeGemini(null)).toBeNull();
  });
});

describe('asignar los últimos 4 dígitos en lenguaje natural', () => {
  test('la FAN termina en 6958', () => {
    expect(detectarAsignarDigitos('la FAN termina en 6958')).toEqual({ termino: 'fan', digitos: '6958', tipo: null });
    expect(intencion('la FAN termina en 6958')).toBe('asignar_digitos');
  });

  test('la cuenta de la falabella termina en 1234 es de cuenta', () => {
    expect(detectarAsignarDigitos('la cuenta de la falabella termina en 1234')).toEqual({ termino: 'falabella', digitos: '1234', tipo: 'cuenta' });
    expect(detectarAsignarDigitos('la tarjeta CMR termina en 5678').tipo).toBe('tarjeta');
  });

  test('un número largo o un gasto normal no calzan', () => {
    expect(detectarAsignarDigitos('la FAN termina en 12345')).toBeNull();
    expect(detectarAsignarDigitos('almuerzo 5500 débito')).toBeNull();
  });
});

describe('reset y restauración en lenguaje natural', () => {
  test('solo calzan mensajes que son exactamente eso', () => {
    expect(detectarReset('empezar de cero')).toBe('reset');
    expect(detectarReset('borrar todo')).toBe('reset');
    expect(detectarReset('restaurar último respaldo')).toBe('restaurar_respaldo');
    expect(detectarReset('almuerzo 5500')).toBeNull();
    expect(detectarReset('borra todo lo del mes pasado')).toBeNull();
    expect(intencion('empezar de cero')).toBe('reset');
  });
});

describe('correcciones de monto con muletillas y de lugar', () => {
  const cuentas = [{ id: 1, nombre: 'FAN', banco: 'Banco de Chile', tipo: 'tarjeta_debito' }];
  const categorias = [{ id: 1, nombre: 'Supermercado' }];
  const cambios = (t) => clasificarReply(t, { cuentas, categorias, hoy: '2026-11-25' })?.cambios;

  test('"eran 4690", "fueron 4.690", "4690" y variantes con muletillas', () => {
    for (const t of ['eran 4690', 'fueron 4.690', '4690', 'en realidad eran 4690', 'creo que fueron 4.690', 'perdón, son 4690', 'no, 4690', 'aprox 4690', 'en realidad fueron 4.690 pesos']) {
      expect(cambios(t)).toEqual({ monto: 4690 });
    }
    expect(cambios('eran como 4 mil')).toEqual({ monto: 4000 });
  });

  test('"lucas" se respeta tal cual (el bot pide confirmar si el monto cambia muchísimo)', () => {
    expect(cambios('en realidad 4690 lucas')).toEqual({ monto: 4690000 });
  });

  test('"era en el líder" corrige la descripción si no es una cuenta ni una categoría', () => {
    expect(cambios('era en el líder')).toEqual({ descripcion: 'Líder' });
    expect(cambios('la descripción es Líder')).toEqual({ descripcion: 'Líder' });
    expect(cambios('era en supermercado')).toEqual({ categoria_id: 1 });
    expect(cambios('era en la fan')).toEqual({ cuenta_id: 1 });
  });
});

describe('guardar una cuenta o tarjeta con una frase', () => {
  test('saca el texto en formato /savecard, los últimos 4 dígitos y el titular', () => {
    expect(detectarGuardarCuenta('guarda la tarjeta crédito 8263 es de Valeska Sanhueza')).toMatchObject({
      ultimos4: '8263', titular: 'Valeska Sanhueza', numeroLargo: false,
      textoCuenta: 'la tarjeta crédito terminada en 8263 a nombre de Valeska Sanhueza'
    });
    expect(detectarGuardarCuenta('nueva tarjeta débito 5555 de Juan')).toMatchObject({ ultimos4: '5555', titular: 'Juan' });
    expect(detectarGuardarCuenta('la tarjeta 8263 es de Valeska')).toMatchObject({ ultimos4: '8263', titular: 'Valeska' });
  });

  test('el banco no es el titular y sin titular queda null (se usa el por defecto)', () => {
    const r = detectarGuardarCuenta('agrega mi cuenta rut 1234 del banco estado');
    expect(r).toMatchObject({ ultimos4: '1234', titular: null });
    expect(r.textoCuenta).toContain('del banco estado');
  });

  test('un número largo se reduce a los últimos 4 y se marca como largo', () => {
    const r = detectarGuardarCuenta('guarda la tarjeta débito banco de chile 4111 1111 1111 1234');
    expect(r).toMatchObject({ ultimos4: '1234', numeroLargo: true });
    expect(JSON.stringify(r)).not.toContain('4111');
  });

  test('un gasto con tarjeta o una consulta no se confunden', () => {
    expect(detectarGuardarCuenta('pagué 5000 con la tarjeta 1234')).toBeNull();
    expect(detectarGuardarCuenta('almuerzo 5500 tarjeta')).toBeNull();
    expect(detectarGuardarCuenta('la FAN termina en 6958')).toBeNull();
    expect(clasificarPorReglas('guarda la tarjeta crédito 8263 es de Valeska Sanhueza').intencion).toBe('guardar_cuenta');
    expect(clasificarPorReglas('pagué 5000 con la tarjeta 1234')?.intencion).not.toBe('guardar_cuenta');
  });
});

describe('editar una cuenta con una frase', () => {
  test('abrir, cambiar el nombre y cambiar el banco', () => {
    expect(detectarEditarCuenta('edita la cuenta 8263')).toEqual({ accion: 'abrir', digitos: '8263' });
    expect(detectarEditarCuenta('cambia el nombre de la 8263 a Crédito Valeska')).toEqual({
      accion: 'campo', campo: 'nombre', digitos: '8263', valor: 'Crédito Valeska'
    });
    expect(detectarEditarCuenta('la tarjeta 8263 es del banco de chile')).toEqual({
      accion: 'campo', campo: 'banco', digitos: '8263', valor: 'banco de chile'
    });
  });

  test('"es de Valeska" es el titular (guardar_cuenta), no el banco', () => {
    expect(detectarEditarCuenta('la tarjeta 8263 es de Valeska')).toBeNull();
    expect(clasificarPorReglas('la tarjeta 8263 es de Valeska').intencion).toBe('guardar_cuenta');
    expect(clasificarPorReglas('edita la cuenta 8263').intencion).toBe('editar_cuenta');
  });
});
