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

import { describirError } from './errores.js';
import { listarCompras } from '../cuotas.js';
import { listarGastosFijos } from '../planAhorro.js';
import {
  esTransferenciaSaliente,
  extraerDestinatario,
  esDestinoPropio,
  clavePorNombre,
  cruzarCuotas,
  fijoQueCalza,
  fijoPagadoEnElMes,
  marcarPagoDeGastoFijo,
  cruzarConAnteriores,
  repartirMonto,
  transferenciasSinVincularDelMes,
  vincularGrupo,
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
      const fijos = (await listarGastosFijos()).filter(f => f.destinatario);

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

        // 2b. A quien se le paga un gasto fijo (con un monto parecido, ±10 %): se propone marcarla como ese pago
        const fijo = fijoQueCalza(destinatario, mov.monto, fijos);
        if (fijo && !(await fijoPagadoEnElMes(fijo.id, mov.fecha))) {
          await proponerPagoFijo(chatId, mov, destinatario, fijo);
          continue;
        }

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

  /**
   * Cruza un monto con las cuotas del mes de una persona y pregunta cómo vincularlo:
   *  - calza con una cuota o con la suma de varias (hasta todas): confirma con un botón;
   *  - no calza solo, pero junto con otras transferencias del mes al mismo destinatario sí: ofrece vincularlas juntas;
   *  - es parcial, sobra o es ambiguo: muestra la diferencia y deja elegir cuáles cuotas cubre, con un botón por cuota.
   * `aplicar(cuotas)` hace el cambio y devuelve { ok, texto?, error? }; `aplicarGrupo(movimientos, cuotas)` hace lo mismo
   * para varias transferencias. Devuelve false si no hay cuotas pendientes (no preguntó nada).
   */
  async function ofrecerPlan(chatId, { monto, fecha, destinatario, compras, aplicar, anteriores = [], aplicarGrupo = null, movActual = null, alCancelar = null, textoSinVincular = 'Entendido: queda como un gasto, sin vincular.' }) {
    const r = cruzarCuotas(monto, compras);
    if (r.tipo === 'ninguna') return false;

    const encabezado = `Transferencia de ${dinero(monto)} a <b>${esc(destinatario)}</b> (${formatearFechaCL(String(fecha).slice(0, 10))}).`;
    const listar = (cuotas) => cuotas.map(c => `- ${esc(etiquetaCuota(c))}`).join('\n');

    if (r.tipo === 'exacta' || r.tipo === 'suma') {
      const key = guardar({ chatId, destinatario, aplicar, opciones: [r.cuotas], monto, alCancelar, textoSinVincular });
      await enviar(chatId,
        `${encabezado}\nCalza con ${r.tipo === 'suma' ? (r.cuotas.length === compras.length ? 'la suma de todas las cuotas de este mes' : 'la suma de las cuotas de este mes') : 'una cuota'}:\n` +
        `${listar(r.cuotas)}\n` +
        (r.tipo === 'suma' ? 'Si la vinculo, avanzo el contador de cada una (un movimiento por cuota; el total no cambia).\n' : '') +
        '¿La vinculo como pago de cuotas?',
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

    // Varias transferencias del mes que juntas suman las cuotas
    const junto = aplicarGrupo ? cruzarConAnteriores(monto, anteriores, compras) : null;
    if (junto) {
      const movimientos = [movActual, ...junto.movimientos].filter(Boolean);
      const key = guardar({ chatId, destinatario, aplicarGrupo, grupo: { movimientos, cuotas: junto.cruce.cuotas }, alCancelar, textoSinVincular });
      await enviar(chatId,
        `${encabezado}\nSola no calza con las cuotas, pero junto con ${junto.movimientos.length === 1 ? 'otra transferencia anterior' : `otras ${junto.movimientos.length} transferencias anteriores`} ` +
        `de este mes a ${esc(destinatario)} suma ${dinero(junto.total)} y calza con:\n${listar(junto.cruce.cuotas)}\n` +
        junto.movimientos.map(m => `- ${esc(formatearFechaCL(m.fecha))}: ${dinero(m.monto)}`).join('\n') +
        '\n¿Las vinculo todas como pago de esas cuotas? Cada cuota avanza su contador; no se crea ningún movimiento nuevo.',
        {
          reply_markup: {
            inline_keyboard: [[
              { text: 'Sí, vincularlas', callback_data: `tfh_${key}` },
              { text: 'No', callback_data: `tfn_${key}` }
            ]]
          }
        }
      );
      return true;
    }

    // Ambigua, parcial o con sobrante: se avisa la diferencia y Juan marca cuáles cuotas cubre
    const detalle = r.tipo === 'ambigua'
      ? 'Calza con más de una cuota o combinación de cuotas. Marca cuáles cubre.'
      : r.tipo === 'parcial'
        ? `Las cuotas de este mes suman ${dinero(r.total)}: <b>faltan ${dinero(r.diferencia)}</b>, es un pago parcial. Marca cuáles cubre.`
        : `Las cuotas de este mes suman ${dinero(r.total)}: <b>sobran ${dinero(r.diferencia)}</b>. Marca cuáles cubre.`;
    const key = guardar({ chatId, destinatario, aplicar, cuotas: r.cuotas, monto, seleccion: new Set(), alCancelar, textoSinVincular });
    const enviado = await enviar(chatId,
      `${encabezado}\n${detalle}\n${listar(r.cuotas)}\n` +
      'Lo que sobre o falte queda en la última cuota que marques.',
      tecladoSeleccion(key, r.cuotas, new Set())
    );
    pendientes.get(key).messageId = enviado?.message_id ?? null;
    return true;
  }

  function tecladoSeleccion(key, cuotas, seleccion) {
    return {
      reply_markup: {
        inline_keyboard: [
          ...cuotas.map((c, i) => [{
            text: `${seleccion.has(i) ? 'Cubre' : 'No cubre'}: ${c.compra.alias} (cuota ${c.numero})`.slice(0, 50),
            callback_data: `tft_${key}_${i}`
          }]),
          [
            { text: `Confirmar (${seleccion.size})`, callback_data: `tfc_${key}` },
            { text: 'Dejarla sin vincular', callback_data: `tfn_${key}` }
          ]
        ]
      }
    };
  }

  /** Cruza la transferencia (que ya existe como movimiento) con las cuotas de esa persona. true si preguntó. */
  async function ofrecerCuotas(chatId, mov, destinatario, compras, cuentaId) {
    const fecha = String(mov.fecha).slice(0, 10);
    const anteriores = await transferenciasSinVincularDelMes(destinatario, fecha, mov.id);
    return ofrecerPlan(chatId, {
      monto: mov.monto,
      fecha,
      destinatario,
      compras,
      anteriores,
      movActual: { id: mov.id, fecha, monto: Number(mov.monto) },
      aplicar: async (cuotas) => {
        const r = await aplicarPlanDeCuotas(mov, cuotas, { cuentaId, fecha });
        return r.ok
          ? { ok: true, texto: `Listo: ${cuotas.length > 1 ? 'repartí' : 'vinculé'} la transferencia a ${esc(destinatario)} como pago de ${cuotas.map(c => esc(etiquetaCuota({ ...c, monto: c.montoAplicado ?? c.monto }))).join(' y ')}.` }
          : r;
      },
      aplicarGrupo: async (movimientos, cuotas) => {
        await vincularGrupo(movimientos, cuotas);
        return { ok: true, texto: `Listo: vinculé ${movimientos.length} transferencias a ${esc(destinatario)} como pago de ${cuotas.map(c => esc(etiquetaCuota(c))).join(' y ')}.` };
      }
    });
  }

  /** La transferencia parece el pago de un gasto fijo: se pregunta antes de marcarla (así el plan no la cuenta dos veces) */
  async function proponerPagoFijo(chatId, mov, destinatario, fijo) {
    const key = guardar({ chatId, mov, destinatario, fijo });
    await enviar(chatId,
      `Transferencia de ${dinero(mov.monto)} a <b>${esc(destinatario)}</b> (${formatearFechaCL(String(mov.fecha).slice(0, 10))}). ` +
      `Parece el pago de tu gasto fijo <b>${esc(fijo.nombre)}</b> (${dinero(fijo.monto)}${fijo.dia_pago ? `, día ${fijo.dia_pago}` : ''}). ` +
      '¿La marco como ese pago? Así el plan no la cuenta otra vez como gasto.',
      {
        reply_markup: {
          inline_keyboard: [[
            { text: `Sí, es el pago de ${fijo.nombre}`.slice(0, 40), callback_data: `tfj_${key}` },
            { text: 'No, es otra cosa', callback_data: `tfk_${key}` }
          ]]
        }
      }
    );
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
    const m = data.match(/^tf([gpanythcjk])_([a-z0-9]+)(?:_(\d+))?$/);
    if (!m) return false;
    const [, tipo, key, indice] = m;
    const messageId = cb.message.message_id;
    const pendiente = pendientes.get(key);
    if (!pendiente) {
      await responderCallback(cb.id, { text: 'Solicitud expirada' });
      return true;
    }

    try {
      // Marcar o desmarcar una cuota (el mensaje se queda esperando la confirmación)
      if (tipo === 't') {
        const i = Number(indice);
        if (pendiente.seleccion.has(i)) pendiente.seleccion.delete(i);
        else pendiente.seleccion.add(i);
        await ctx.bot?.editMessageReplyMarkup(
          tecladoSeleccion(key, pendiente.cuotas, pendiente.seleccion).reply_markup,
          { chat_id: chatId, message_id: messageId }
        ).catch(() => {});
        await responderCallback(cb.id, {});
        return true;
      }

      pendientes.delete(key);
      const { destinatario, mov, cuentaId } = pendiente;

      if (tipo === 'n') {
        await editar(pendiente.textoSinVincular ?? 'Entendido: queda como un gasto, sin vincular.', { chat_id: chatId, message_id: messageId });
        await responderCallback(cb.id, {});
        if (pendiente.alCancelar) await pendiente.alCancelar();
        return true;
      }

      // Confirmar las cuotas marcadas: el monto se reparte y la última queda con la diferencia
      if (tipo === 'c') {
        if (pendiente.seleccion.size === 0) {
          pendientes.set(key, pendiente);
          await responderCallback(cb.id, { text: 'Marca al menos una cuota' });
          return true;
        }
        const elegidas = [...pendiente.seleccion].sort((a, b) => a - b).map(i => pendiente.cuotas[i]);
        const r = await pendiente.aplicar(repartirMonto(elegidas, pendiente.monto));
        await editar(r.ok ? r.texto : esc(r.error ?? 'No pude vincular la transferencia: ya no encuentro el movimiento o la compra.'), { chat_id: chatId, message_id: messageId });
        await responderCallback(cb.id, { text: r.ok ? 'Vinculada' : 'Error' });
        return true;
      }

      // No era el pago del gasto fijo: sigue la pregunta de siempre (gasto, préstamo o pago), o lo recordado del destinatario
      if (tipo === 'k') {
        await responderCallback(cb.id, {});
        const recordada = await obtenerClasificacion(destinatario);
        if (recordada) {
          await aplicarClasificacion(mov.id, recordada, destinatario);
          await editar(
            `Entendido: no es ese gasto fijo. Apliqué lo que recordaba de ${esc(destinatario)}: ${recordada === 'prestamo' ? 'préstamo' : recordada}.`,
            { chat_id: chatId, message_id: messageId }
          );
        } else {
          await editar('Entendido: no es ese gasto fijo.', { chat_id: chatId, message_id: messageId });
          await preguntar(chatId, mov, destinatario, cuentaId);
        }
        return true;
      }

      // Pago de un gasto fijo
      if (tipo === 'j') {
        await marcarPagoDeGastoFijo(mov.id, pendiente.fijo.id);
        await editar(
          `Listo: la transferencia a ${esc(destinatario)} quedó como el pago de <b>${esc(pendiente.fijo.nombre)}</b>. ` +
          'El plan no la cuenta otra vez como gasto.',
          { chat_id: chatId, message_id: messageId }
        );
        await responderCallback(cb.id, { text: 'Marcada' });
        return true;
      }

      // Varias transferencias que juntas cubren las cuotas
      if (tipo === 'h') {
        const r = await pendiente.aplicarGrupo(pendiente.grupo.movimientos, pendiente.grupo.cuotas);
        await editar(r.ok ? r.texto : esc(r.error ?? 'No pude vincular las transferencias: ya no encuentro alguno de los movimientos o la compra.'), { chat_id: chatId, message_id: messageId });
        await responderCallback(cb.id, { text: r.ok ? 'Vinculadas' : 'Error' });
        return true;
      }

      // Calza con una cuota o con la suma de varias
      if (tipo === 'y') {
        const plan = pendiente.opciones?.[Number(indice)];
        if (!plan) {
          await responderCallback(cb.id, { text: 'Solicitud expirada' });
          return true;
        }
        const r = await pendiente.aplicar(plan);
        await editar(r.ok ? r.texto : esc(r.error ?? 'No pude vincular la transferencia: ya no encuentro el movimiento o la compra.'), { chat_id: chatId, message_id: messageId });
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
      await responderCallback(cb.id, { text: describirError(error, 'vincular', 'la transferencia').toast });
      return true;
    }
  }

  return { procesarMovimientos, manejarCallback, ofrecerPlan };
}
