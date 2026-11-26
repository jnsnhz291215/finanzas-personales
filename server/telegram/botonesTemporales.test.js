import { jest } from '@jest/globals';
import { crearBotonesTemporales } from './botonesTemporales.js';
import { TAREAS, tareaPorId, lineasDeFechas } from './mantenimientoBot.js';

/** BD en memoria: solo lo que usa el helper */
function bdFalsa() {
  const filas = [];
  const query = async (sql, params = []) => {
    if (sql.startsWith('DELETE')) {
      const i = filas.findIndex(f => f.chat_id === params[0] && f.message_id === params[1]);
      if (i >= 0) filas.splice(i, 1);
      return [{}];
    }
    if (sql.startsWith('INSERT')) {
      filas.push({ chat_id: params[0], message_id: params[1], vence_en: params[2], texto: params[3], aviso: params[4], acciones: params[5], permanentes: params[6] });
      return [{}];
    }
    return [filas.map(f => ({ ...f }))];
  };
  return { filas, consulta: async () => query };
}

function botFalso() {
  return { editMessageText: jest.fn(async () => ({})), editMessageReplyMarkup: jest.fn(async () => ({})) };
}

const esperar = (ms) => new Promise(r => setTimeout(r, ms));

describe('botones con vencimiento', () => {
  test('al vencer quita el botón y agrega el aviso al texto', async () => {
    const bot = botFalso();
    const bd = bdFalsa();
    const b = crearBotonesTemporales({ bot, consulta: bd.consulta });
    b.registrar({ chatId: 1, messageId: 10, venceEn: Date.now() + 30, texto: '<b>Listo</b>', aviso: 'Deshacer ya no está disponible.', acciones: ['rcz_1'] });
    await esperar(80);
    expect(bot.editMessageText).toHaveBeenCalledTimes(1);
    const [texto, opciones] = bot.editMessageText.mock.calls[0];
    expect(texto).toContain('Deshacer ya no está disponible.');
    expect(opciones.reply_markup.inline_keyboard).toEqual([]);
    expect(bd.filas).toHaveLength(0);
  });

  test('si se usa a tiempo (alTocar) el temporizador se cancela', async () => {
    const bot = botFalso();
    const b = crearBotonesTemporales({ bot, consulta: bdFalsa().consulta });
    b.registrar({ chatId: 1, messageId: 10, venceEn: Date.now() + 40, texto: 'x', aviso: 'ya no', acciones: ['rcz_1'] });
    expect(b.alTocar({ data: 'otro', message: { chat: { id: 1 }, message_id: 10 } })).toBe(false);
    expect(b.alTocar({ data: 'rcz_1', message: { chat: { id: 1 }, message_id: 10 } })).toBe(true);
    await esperar(90);
    expect(bot.editMessageText).not.toHaveBeenCalled();
  });

  test('ignora sin avisar los errores de un mensaje ya editado o borrado', async () => {
    const bot = botFalso();
    bot.editMessageText = jest.fn(async () => { throw { response: { body: { description: 'Bad Request: message to edit not found' } } }; });
    const log = jest.fn();
    const b = crearBotonesTemporales({ bot, consulta: bdFalsa().consulta, log });
    b.registrar({ chatId: 1, messageId: 10, venceEn: Date.now() + 10, texto: 'x', aviso: 'ya no', acciones: [] });
    await esperar(60);
    expect(bot.editMessageText).toHaveBeenCalled();
    expect(log).not.toHaveBeenCalled();
  });

  test('al reiniciar limpia los vencidos y reprograma los pendientes', async () => {
    const bot = botFalso();
    const bd = bdFalsa();
    const antes = crearBotonesTemporales({ bot: botFalso(), consulta: bd.consulta });
    antes.registrar({ chatId: 1, messageId: 1, venceEn: Date.now() - 1000, texto: 'a', aviso: 'ya no', acciones: [] });
    antes.registrar({ chatId: 1, messageId: 2, venceEn: Date.now() + 40, texto: 'b', aviso: 'ya no', acciones: [] });
    antes.cancelar(1, 1);
    antes.cancelar(1, 2);
    // Se simula el reinicio: las filas siguen en la BD y los temporizadores ya no existen
    bd.filas.push(
      { chat_id: 1, message_id: 1, vence_en: Date.now() - 1000, texto: 'a', aviso: 'ya no', acciones: '[]', permanentes: '[]' },
      { chat_id: 1, message_id: 2, vence_en: Date.now() + 40, texto: 'b', aviso: 'ya no', acciones: '[]', permanentes: '[]' }
    );
    const despues = crearBotonesTemporales({ bot, consulta: bd.consulta, log: () => {} });
    await despues.restaurar();
    expect(bot.editMessageText).toHaveBeenCalledTimes(1);
    await esperar(100);
    expect(bot.editMessageText).toHaveBeenCalledTimes(2);
  });
});

describe('/mantenimiento', () => {
  test('solo hay una lista cerrada de tareas y un id desconocido no se ejecuta', () => {
    expect(TAREAS.map(t => t.id)).toEqual(['fechas_contar', 'fechas_aplicar']);
    expect(tareaPorId('rm -rf /')).toBeNull();
    expect(tareaPorId('fechas_aplicar').confirmar).toBe(true);
    expect(tareaPorId('fechas_contar').confirmar).toBe(false);
  });

  test('el resultado son solo números', () => {
    const l = lineasDeFechas({ archivos: 2, movimientos: 5, cargos: 7, compras: 1, movimientosSinCorregir: 3, cargosSinCorregir: 0 }, false);
    expect(l.join('\n')).toContain('Movimientos por reparar: 5');
    expect(l.join('\n')).toContain('Sin poder corregir: 3 movimientos y 0 cargos leídos');
  });
});
