import { jest } from '@jest/globals';
import {
  esOrdenDeCancelar, esPreguntaDeLote, iniciarLote, sumarRecibido, marcarProcesado, registrarPregunta, cancelarLote, cerrarPreguntas,
  textoCancelacion, hayLote, estaCancelado
} from './loteEnCurso.js';
import { parsearCuotasPagadas } from './cuotasGestion.js';
import { textoContador } from './contadorCuotas.js';

describe('fijar cuántas cuotas van pagadas', () => {
  test('comando y frases', () => {
    expect(parsearCuotasPagadas('/cuotaspagadas Mac 6')).toMatchObject({ ref: { nombre: 'mac' }, n: 6, esComando: true });
    expect(parsearCuotasPagadas('del Mac van 6 pagadas')).toMatchObject({ ref: { nombre: 'mac' }, n: 6 });
    expect(parsearCuotasPagadas('la última cuota pagada del Mac es la 6')).toMatchObject({ ref: { nombre: 'mac' }, n: 6 });
    expect(parsearCuotasPagadas('/cuotaspagadas Apple 21.749 6')).toMatchObject({ ref: { nombre: 'apple', monto: 21749 }, n: 6 });
    expect(parsearCuotasPagadas('hola van 6 pagadas')).toBeNull();
  });

  test('avisa si los pagos vinculados superan lo nuevo', () => {
    const dinero = (n) => `$${n}`;
    const base = { compra: { total_cuotas: 12, monto_cuota: 100 }, antes: 7, despues: 4, pagado: 700, debe: 500, pagosVinculados: 700 };
    expect(textoContador({ ...base, superanLoNuevo: true }, 'Mac', dinero)).toContain('Ojo: tienes pagos vinculados');
    expect(textoContador({ ...base, superanLoNuevo: false, pagado: 400, pagosVinculados: 0 }, 'Mac', dinero)).not.toContain('Ojo');
  });
});

describe('cancelar lo que está en curso', () => {
  test('reconoce «cancela», «para», «detente» y no frases más largas', () => {
    for (const t of ['cancela', 'Para', 'detente', 'stop', 'cancelar todo']) expect(esOrdenDeCancelar(t)).toBe(true);
    for (const t of ['no cancela nada', 'parar la música', 'gasté 5 mil']) expect(esOrdenDeCancelar(t)).toBe(false);
  });

  test('solo las preguntas de un lote de cartolas llevan «Cancelar lote»', () => {
    const teclado = (cb) => ({ reply_markup: { inline_keyboard: [[{ text: 'x', callback_data: cb }]] } });
    expect(esPreguntaDeLote(teclado('lcy_s'))).toBe(true);
    expect(esPreguntaDeLote(teclado('cap_1'))).toBe(true);
    expect(esPreguntaDeLote(teclado('cgn_1'))).toBe(false);
    expect(esPreguntaDeLote(teclado('cerrar_x'))).toBe(false);
  });

  test('cancelar cierra las preguntas sin responder y cuenta lo procesado', async () => {
    iniciarLote(99, 7);
    sumarRecibido(99, 3);
    marcarProcesado(99, 2);
    registrarPregunta(99, 100, 'pregunta abierta');
    registrarPregunta(99, 101, 'pregunta ya contestada');
    const bot = {
      editMessageReplyMarkup: jest.fn(async (_, o) => { if (o.message_id === 101) throw new Error('message is not modified'); }),
      editMessageText: jest.fn(async () => ({}))
    };
    const info = cancelarLote(99);
    expect(info).toMatchObject({ total: 7, procesados: 2, recibidos: 3 });
    expect(hayLote(99)).toBe(false);
    expect(estaCancelado(99)).toBe(true);
    const sinResponder = await cerrarPreguntas(bot, 99, info.preguntas);
    expect(sinResponder).toBe(1);
    expect(bot.editMessageText).toHaveBeenCalledTimes(1);
    expect(bot.editMessageText.mock.calls[0][0]).toContain('Cancelado.');
    expect(textoCancelacion({ total: 7, procesados: 2, sinResponder })).toBe(
      'Cancelé el lote: procesé 2 de 7 archivos, quedaron 1 pregunta sin responder. Lo ya guardado sigue guardado; si quieres borrarlo usa /resetcuenta.'
    );
    // Una segunda vez ya no hay nada en curso
    expect(cancelarLote(99)).toBeNull();
  });
});
