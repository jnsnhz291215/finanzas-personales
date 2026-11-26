/**
 * Qué hacer con cada transferencia saliente que se registra (por texto o al importar una cartola):
 *  - a una cuenta propia: movimiento interno, no suma como gasto ni como ingreso;
 *  - a quien le pagas una compra en cuotas (Valeska): pago de cuotas, cruzando el monto con la cuota del mes
 *    o con la suma de varias; si no calza (parcial o sobra), avisa la diferencia y pregunta;
 *  - a otra persona: pregunta si es gasto, préstamo o pago y recuerda la respuesta por destinatario.
 *
 * El gasto real sigue siendo la transferencia. La lógica de datos está en server/transferencias.js. Nunca se
 * muestra ni se guarda un RUT o un número de cuenta: solo el nombre del destinatario.
 */

import { listarCompras } from '../cuotas.js';
import {
  esTransferenciaSaliente,
  extraerDestinatario,
  esDestinoPropio,
  clavePorNombre,
  cruzarCuotas,
  obtenerClasificacion,
  recordarClasificacion,
  marcarPropia,
  aplicarClasificacion,
  aplicarPlanDeCuotas
} from '../transferencias.js';
import { comprasDeTitular, esTitularPropio } from './terceros.js';
import { formatearFechaCL } from './fechas.js';

const MAX_PREGUNTAS = 5;
const ESPERA_MS = 30 * 60 * 1000;

async function consulta() {
  return (await import('../db.js')).query;
}

export function crearTransferencias(ctx) {
  const { enviar, editar, responderCallback, esc, formatearMonto } = ctx;
  const dinero = (n) => `$${formatearMonto(n)}`;

  // Preguntas sin responder: clave -> { chatId, mov, destinatario, cuentaId, opciones }
  const pendientes = new Map();
  let contador = 0;

  function guardar(datos) {
    const key = `${Date.now().toString(36)}${contador++}`;
    pendientes.set(key, datos);
    setTimeout(() => pendientes.delete(key), ESPERA_MS).unref?.();
    return key;
  }

  const etiquetaCuota = (c) => `${c.compra.alias} cuota ${c.numero}/${c.compra.total_cuotas} (${dinero(c.monto)})`;

  /**
   * Clasifica las transferencias salientes de una lista de movimientos ({ id, fecha, descripcion, monto,
   * tipo }). `cuentaId` es la cuenta desde la que salieron. Devuelve los movimientos que NO se trataron
   * aquí (para que sigan su flujo de siempre).
   */
  async function procesarMovimientos(chatId, movimientos, { cuentaId = null } = {}) {
    const restantes = [];
    try {
      const query = await consulta();
      const [cuentas] = await query('SELECT id, nombre, titular FROM cuentas WHERE activa = 1');
      const propias = cuentas.filter(c => esTitularPropio(c.titular));
      const titularPropio = (process.env.TITULAR_POR_DEFECTO || '').trim();
      const compras = await listarCompras();

      let internas = 0;
      const recordadas = [];
      let preguntas = 0;

      for (const mov of movimientos) {
        if (mov.tipo !== 'cargo' || !esTransferenciaSaliente(mov.descripcion)) {
          restantes.push(mov);
          continue;
        }
        const destinatario = extraerDestinatario(mov.descripcion);
        if (!destinatario) {
          restantes.push(mov);
          continue;
        }

        // 1. A una cuenta propia: interno
        if (esDestinoPropio(destinatario, propias.map(c => c.nombre), titularPropio)) {
          const clave = clavePorNombre(destinatario);
          const destino = propias.find(c => Number(c.id) !== Number(cuentaId) && clave.includes(clavePorNombre(c.nombre)));
          await marcarPropia(mov.id, destino ? Number(destino.id) : null);
          internas++;
          continue;
        }

        // 2. A quien se le paga una compra en cuotas
        const deEsaPersona = comprasDeTitular(compras, destinatario);
        if (deEsaPersona.length > 0 && await ofrecerCuotas(chatId, mov, destinatario, deEsaPersona, cuentaId)) continue;

        // 3. Ya se sabe qué es lo que le transfiere a esa persona
        const recordada = await obtenerClasificacion(destinatario);
        if (recordada) {
          await aplicarClasificacion(mov.id, recordada, destinatario);
          recordadas.push(`${destinatario}: ${recordada === 'prestamo' ? 'préstamo' : recordada}`);
          continue;
        }

        // 4. Se pregunta (hasta 5 por vez; el resto queda como estaba)
        if (preguntas < MAX_PREGUNTAS) {
          await preguntar(chatId, mov, destinatario, cuentaId);
          preguntas++;
        } else {
          restantes.push(mov);
        }
      }

      const avisos = [];
      if (internas > 0) {
        avisos.push(`${internas} ${internas === 1 ? 'transferencia a una cuenta tuya quedó' : 'transferencias a cuentas tuyas quedaron'} como movimiento interno: no ${internas === 1 ? 'suma' : 'suman'} como gasto ni como ingreso.`);
      }
      if (recordadas.length > 0) avisos.push(`Apliqué lo que recordaba de ${esc(recordadas.slice(0, 5).join(', '))}.`);
      if (avisos.length > 0) await enviar(chatId, avisos.join('\n'));
    } catch (error) {
      console.error('Error al clasificar transferencias:', error.code ?? error.name);
      return movimientos;
    }
    return restantes;
  }

  /** Cruza el monto con las cuotas del mes de esa persona. true si preguntó (o resolvió); false si no hay cuotas. */
  async function ofrecerCuotas(chatId, mov, destinatario, compras, cuentaId) {
    const r = cruzarCuotas(mov.monto, compras);
    if (r.tipo === 'ninguna') return false;

    const encabezado = `Transferencia de ${dinero(mov.monto)} a <b>${esc(destinatario)}</b> (${formatearFechaCL(String(mov.fecha).slice(0, 10))}).`;

    if (r.tipo === 'exacta' || r.tipo === 'suma') {
      const key = guardar({ chatId, mov, destinatario, cuentaId, opciones: [r.cuotas] });
      await enviar(chatId,
        `${encabezado}\nCalza con ${r.tipo === 'suma' ? 'la suma de las cuotas de este mes' : 'una cuota'}:\n` +
        r.cuotas.map(c => `- ${esc(etiquetaCuota(c))}`).join('\n') +
        (r.tipo === 'suma' ? '\nSi la vinculo, la reparto en un movimiento por cuota (el total no cambia).' : '') +
        '\n¿La vinculo como pago de cuotas?',
        {
          reply_markup: {
            inline_keyboard: [[
              { text: 'Sí, vincular', callback_data: `tfy_${key}_0` },
              { text: 'No, es otro gasto', callback_data: `tfn_${key}` }
            ]]
          }
        }
      );
      return true;
    }

    // Ambigua, parcial o con sobrante: se avisa y se deja elegir una cuota o dejarla sin vincular
    const opciones = r.cuotas.map(c => [c]);
    const key = guardar({ chatId, mov, destinatario, cuentaId, opciones });
    const detalle = r.tipo === 'ambigua'
      ? 'Calza con más de una cuota o combinación de cuotas. ¿Con cuál la vinculo?'
      : r.tipo === 'parcial'
        ? `Las cuotas de este mes suman ${dinero(r.total)}: <b>faltan ${dinero(r.diferencia)}</b>, es un pago parcial. ¿La vinculo a alguna cuota?`
        : `Las cuotas de este mes suman ${dinero(r.total)}: <b>sobran ${dinero(r.diferencia)}</b>. ¿La vinculo a alguna cuota?`;
    await enviar(chatId,
      `${encabezado}\n${detalle}\n` + r.cuotas.map(c => `- ${esc(etiquetaCuota(c))}`).join('\n'),
      {
        reply_markup: {
          inline_keyboard: [
            ...r.cuotas.map((c, i) => [{ text: `Vincular a ${c.compra.alias} (cuota ${c.numero})`.slice(0, 50), callback_data: `tfy_${key}_${i}` }]),
            [{ text: 'Dejarla sin vincular (gasto)', callback_data: `tfn_${key}` }]
          ]
        }
      }
    );
    return true;
  }

  /** ¿Gasto, préstamo o pago? La respuesta se recuerda para ese destinatario */
  async function preguntar(chatId, mov, destinatario, cuentaId) {
    const key = guardar({ chatId, mov, destinatario, cuentaId });
    await enviar(chatId,
      `Transferencia de ${dinero(mov.monto)} a <b>${esc(destinatario)}</b> (${formatearFechaCL(String(mov.fecha).slice(0, 10))}). ` +
      `¿Qué fue? Lo recuerdo para la próxima vez que le transfieras a ${esc(destinatario)}.`,
      {
        reply_markup: {
          inline_keyboard: [[
            { text: 'Gasto', callback_data: `tfg_${key}` },
            { text: 'Préstamo', callback_data: `tfp_${key}` },
            { text: 'Pago', callback_data: `tfa_${key}` }
          ]]
        }
      }
    );
  }

  /** Botones de este módulo. Devuelve true si el callback era suyo. */
  async function manejarCallback(cb, chatId, data) {
    const m = data.match(/^tf([gpayn])_([a-z0-9]+)(?:_(\d+))?$/);
    if (!m) return false;
    const [, tipo, key, indice] = m;
    const messageId = cb.message.message_id;
    const pendiente = pendientes.get(key);
    if (!pendiente) {
      await responderCallback(cb.id, { text: 'Solicitud expirada' });
      return true;
    }
    pendientes.delete(key);
    const { mov, destinatario, cuentaId } = pendiente;

    try {
      if (tipo === 'n') {
        await editar('Entendido: queda como un gasto, sin vincular.', { chat_id: chatId, message_id: messageId });
        await responderCallback(cb.id, {});
        return true;
      }

      if (tipo === 'y') {
        const plan = pendiente.opciones?.[Number(indice)];
        if (!plan) {
          await responderCallback(cb.id, { text: 'Solicitud expirada' });
          return true;
        }
        const r = await aplicarPlanDeCuotas(mov, plan, { cuentaId, fecha: String(mov.fecha).slice(0, 10) });
        await editar(
          r.ok
            ? `Listo: ${plan.length > 1 ? 'repartí' : 'vinculé'} la transferencia a ${esc(destinatario)} como pago de ` +
              `${plan.map(c => esc(etiquetaCuota(c))).join(' y ')}.`
            : esc(r.error ?? 'No pude vincularla.'),
          { chat_id: chatId, message_id: messageId }
        );
        await responderCallback(cb.id, { text: r.ok ? 'Vinculada' : 'Error' });
        return true;
      }

      // Gasto, préstamo o pago: se aplica y se recuerda por destinatario
      const clasificacion = tipo === 'g' ? 'gasto' : tipo === 'p' ? 'prestamo' : 'pago';
      await aplicarClasificacion(mov.id, clasificacion, destinatario);
      await recordarClasificacion(destinatario, clasificacion);
      await editar(
        `Listo: la transferencia a ${esc(destinatario)} es un ${clasificacion === 'prestamo' ? 'préstamo' : clasificacion}. ` +
        'Lo recordaré para la próxima vez.',
        { chat_id: chatId, message_id: messageId }
      );
      await responderCallback(cb.id, { text: 'Guardado' });
      return true;
    } catch (error) {
      console.error('Error en un botón de transferencias:', error.code ?? error.name);
      await responderCallback(cb.id, { text: 'Error' });
      return true;
    }
  }

  return { procesarMovimientos, manejarCallback };
}
