/**
 * Eliminar, corregir y deshacer registros respondiendo (reply de Telegram) al mensaje que los
 * creó, en lenguaje natural: "elimina esto", "eran 4500", "era con la falabella", "deshacer".
 * También "elimina el último gasto" sin responder a nada.
 *
 * Se crea con crearRegistros(ctx): ctx trae los envoltorios de bot.js (enviar, editar,
 * responderCallback, esc). La interpretación es primero por reglas (intenciones.js) y, si no
 * alcanzan, Gemini (con el límite por chat y el filtro de privacidad). Eliminar y corregir
 * siempre piden confirmación con botones.
 *
 * Los textos que se muestran vienen de la BD (descripciones, nombres): se escapan siempre.
 */

import { describirError } from './errores.js';
import {
  buscarVinculo,
  ultimoRegistroManual,
  planEliminacion,
  eliminarRegistro,
  previsualizarCorreccion,
  corregirMovimiento,
  deshacerCambio,
  historialPendienteDe,
  vincularMensajes,
  etiquetaTipo
} from '../registros.js';
import { listarCuentasConBanco, listarCategorias } from '../gestion.js';
import { clasificarReply, replyDesdeGemini, puedeEnviarseAGemini } from './intenciones.js';
import { interpretarReplyRegistro, geminiDisponible } from './gemini.js';
import { limitadorGemini } from './limiteGemini.js';
import { fechaHoySantiago } from './fechas.js';
import { analizarMonto } from './parser.js';

const ESPERA_MS = 10 * 60 * 1000;
const CORREGIBLES = ['movimiento', 'pago_cuota'];

export function crearRegistros(ctx) {
  const { enviar, editar, responderCallback, esc } = ctx;
  const limitador = ctx.limitador ?? limitadorGemini;

  // El botón Deshacer vale 24 horas; después desaparece solo (botonesTemporales.js)
  const VIDA_DESHACER_MS = 24 * 60 * 60 * 1000;
  function programarVencimiento(chatId, messageId, texto, historialId) {
    ctx.botonesTemporales?.registrar({
      chatId, messageId, venceEn: Date.now() + VIDA_DESHACER_MS, texto,
      aviso: 'Deshacer ya no está disponible.', acciones: [`rgu_${historialId}`]
    });
  }

  // Confirmaciones pendientes: clave -> { accion, tipo, registroId, cambios }
  const pendientes = new Map();
  let contador = 0;

  const nuevaClave = (chatId) => `${chatId}_${Date.now()}_${contador++}`;

  function guardarPendiente(chatId, datos) {
    const key = nuevaClave(chatId);
    pendientes.set(key, datos);
    setTimeout(() => pendientes.delete(key), ESPERA_MS);
    return key;
  }

  /** Primera línea en negrita y el resto normal, todo escapado */
  function bloque(lineas) {
    return lineas.map((l, i) => (i === 0 ? `<b>${esc(l)}</b>` : esc(l))).join('\n');
  }

  function errorBD(contexto, error) {
    console.error(`${contexto}:`, error.code ?? error.name);
  }

  // -------------------------------------------------------------------------
  // Eliminar
  // -------------------------------------------------------------------------

  async function pedirEliminacion(chatId, tipo, registroId) {
    const plan = await planEliminacion(tipo, registroId);
    if (!plan.ok) {
      const historialId = await historialPendienteDe(tipo, registroId);
      await enviar(chatId, historialId
        ? 'Ese registro ya está eliminado. Si fue un error, respóndele «deshacer» a la confirmación de la eliminación.'
        : esc(plan.error));
      return true;
    }

    const key = guardarPendiente(chatId, { accion: 'eliminar', tipo, registroId });
    await enviar(chatId,
      `<b>¿Eliminar ${esc(etiquetaTipo(tipo))}?</b>\n\n${bloque(plan.lineas)}\n\n${esc(plan.aviso)}`,
      {
        reply_markup: {
          inline_keyboard: [[
            { text: 'Eliminar', callback_data: `rge_${key}` },
            { text: 'Cancelar', callback_data: `rgx_${key}` }
          ]]
        }
      }
    );
    return true;
  }

  async function confirmarEliminacion(cb, chatId, key) {
    const messageId = cb.message.message_id;
    const p = pendientes.get(key);
    if (!p || p.accion !== 'eliminar') {
      await responderCallback(cb.id, { text: 'Solicitud expirada' });
      return;
    }
    pendientes.delete(key);

    try {
      const r = await eliminarRegistro(p.tipo, p.registroId, chatId);
      if (!r.ok) {
        await editar(esc(r.error), { chat_id: chatId, message_id: messageId });
        await responderCallback(cb.id, { text: 'No se pudo eliminar' });
        return;
      }
      const textoEliminado = `<b>Eliminado</b>\n\n${bloque(r.resumen)}\n\nSi fue un error, responde «deshacer» a este mensaje (tienes 24 horas).`;
      await editar(
        textoEliminado,
        {
          chat_id: chatId,
          message_id: messageId,
          reply_markup: { inline_keyboard: [[{ text: 'Deshacer', callback_data: `rgu_${r.historialId}` }]] }
        }
      );
      programarVencimiento(chatId, messageId, textoEliminado, r.historialId);
      await vincularMensajes(chatId, [messageId], 'historial', r.historialId);
      await responderCallback(cb.id, { text: 'Eliminado' });
    } catch (error) {
      errorBD('Error al eliminar un registro', error);
      await responderCallback(cb.id, { text: describirError(error, 'borrar', 'el registro').toast });
    }
  }

  // -------------------------------------------------------------------------
  // Corregir
  // -------------------------------------------------------------------------

  async function pedirCorreccion(chatId, tipo, registroId, r) {
    if (!CORREGIBLES.includes(tipo)) {
      await enviar(chatId,
        `Por ahora solo puedo corregir movimientos y pagos de cuota. Si quieres, elimina ${esc(etiquetaTipo(tipo))} respondiendo «elimina esto» y créalo de nuevo.`
      );
      return true;
    }

    if (r.ambiguas) {
      await enviar(chatId,
        `Hay varias cuentas que calzan: ${r.ambiguas.map(c => esc(c.nombre)).join(', ')}. Responde de nuevo con el nombre exacto.`
      );
      return true;
    }
    if (r.problemas.length > 0) {
      await enviar(chatId, r.problemas.map(p => esc(p)).join('\n'));
      return true;
    }

    const vista = await previsualizarCorreccion(registroId, r.cambios);
    if (!vista.ok) {
      await enviar(chatId, esc(vista.error));
      return true;
    }
    if (vista.cambios.length === 0) {
      await enviar(chatId, 'Ya estaba así, no hay nada que cambiar.');
      return true;
    }

    // Corrección entendida por reglas (por ejemplo "eran 4690"): se aplica directo y queda en el historial
    // para deshacerla. Si el monto cambia más de 20 veces (típico de "lucas" o "mil" mal puestos), se confirma.
    const montoCambio = vista.cambios.find(c => c.campo === 'monto');
    const montoSospechoso = montoCambio && (
      montoCambio.despuesNumero >= montoCambio.antesNumero * 20 || montoCambio.despuesNumero * 20 <= montoCambio.antesNumero
    );
    if (r.origen === 'reglas' && !montoSospechoso) {
      const aplicada = await corregirMovimiento(registroId, r.cambios, chatId);
      if (!aplicada.ok) {
        await enviar(chatId, esc(aplicada.error));
        return true;
      }
      const lineasCorregido = vista.cambios.map(c => (
        c.campo === 'monto'
          ? `${c.antes.replace(/^\$/, '')} → ${c.despues.replace(/^\$/, '')}`
          : `${c.etiqueta} ${c.antes} → ${c.despues}`
      ));
      const textoCorregido = `Corregido: ${esc(lineasCorregido.join('; '))}`;
      const enviado = await enviar(chatId, textoCorregido, {
        reply_markup: { inline_keyboard: [[{ text: 'Deshacer', callback_data: `rgu_${aplicada.historialId}` }]] }
      });
      programarVencimiento(chatId, enviado?.message_id, textoCorregido, aplicada.historialId);
      // Responder «deshacer» a este mensaje también funciona
      if (enviado?.message_id) await vincularMensajes(chatId, [enviado.message_id], 'historial', aplicada.historialId);
      return true;
    }

    const key = guardarPendiente(chatId, { accion: 'corregir', tipo, registroId, cambios: r.cambios });
    await enviar(chatId,
      (montoSospechoso && r.origen === 'reglas'
        ? '<b>Ese monto cambia muchísimo. ¿Seguro?</b>\n\n'
        : '<b>¿Guardar esta corrección?</b>\n\n') +
      vista.cambios.map(c => `${esc(c.etiqueta)}: ${esc(c.antes)} → <b>${esc(c.despues)}</b>`).join('\n'),
      {
        reply_markup: {
          inline_keyboard: [[
            { text: 'Guardar', callback_data: `rgs_${key}` },
            { text: 'Cancelar', callback_data: `rgx_${key}` }
          ]]
        }
      }
    );
    return true;
  }

  async function confirmarCorreccion(cb, chatId, key) {
    const messageId = cb.message.message_id;
    const p = pendientes.get(key);
    if (!p || p.accion !== 'corregir') {
      await responderCallback(cb.id, { text: 'Solicitud expirada' });
      return;
    }
    pendientes.delete(key);

    try {
      const vista = await previsualizarCorreccion(p.registroId, p.cambios);
      const r = await corregirMovimiento(p.registroId, p.cambios, chatId);
      if (!r.ok) {
        await editar(esc(r.error), { chat_id: chatId, message_id: messageId });
        await responderCallback(cb.id, { text: 'No se pudo corregir' });
        return;
      }
      const lineas = vista.ok
        ? vista.cambios.map(c => `${esc(c.etiqueta)}: ${esc(c.antes)} → <b>${esc(c.despues)}</b>`).join('\n')
        : '';
      const textoCorrecion = `<b>Corregido</b>\n\n${lineas}\n\nSi fue un error, responde «deshacer» a este mensaje (tienes 24 horas).`;
      await editar(
        textoCorrecion,
        {
          chat_id: chatId,
          message_id: messageId,
          reply_markup: { inline_keyboard: [[{ text: 'Deshacer', callback_data: `rgu_${r.historialId}` }]] }
        }
      );
      programarVencimiento(chatId, messageId, textoCorrecion, r.historialId);
      await vincularMensajes(chatId, [messageId], 'historial', r.historialId);
      await responderCallback(cb.id, { text: 'Corregido' });
    } catch (error) {
      errorBD('Error al corregir un registro', error);
      await responderCallback(cb.id, { text: describirError(error, 'actualizar', 'el registro').toast });
    }
  }

  // -------------------------------------------------------------------------
  // Deshacer
  // -------------------------------------------------------------------------

  const TEXTO_DESHECHO = {
    eliminar: 'Listo, recuperé el registro eliminado.',
    corregir: 'Listo, volví el movimiento a como estaba antes de la corrección.'
  };

  /** Deshace un cambio del historial. Devuelve el texto para el usuario. */
  async function ejecutarDeshacer(historialId) {
    try {
      const r = await deshacerCambio(historialId);
      return r.ok ? TEXTO_DESHECHO[r.accion] ?? 'Listo, lo deshice.' : r.error;
    } catch (error) {
      errorBD('Error al deshacer', error);
      return describirError(error, 'deshacer', 'el cambio').plano;
    }
  }

  // -------------------------------------------------------------------------
  // Respuestas a un mensaje
  // -------------------------------------------------------------------------

  /** Cuentas y categorías reales para resolver nombres; nunca incluye dígitos de cuentas */
  async function cargarContexto() {
    const [cuentas, categorias] = await Promise.all([listarCuentasConBanco(), listarCategorias()]);
    return { cuentas, categorias };
  }

  /** Reglas primero y Gemini después (con el límite por chat y sin datos sensibles) */
  async function interpretar(chatId, texto) {
    const contexto = await cargarContexto();
    const hoy = fechaHoySantiago();
    const porReglas = clasificarReply(texto, { ...contexto, hoy });
    if (porReglas) return porReglas;

    // Los montos se entienden solo con reglas: nunca se consulta a Gemini por una cifra
    if (analizarMonto(texto)) return null;
    if (!geminiDisponible() || !puedeEnviarseAGemini(texto)) return null;
    if (!limitador.consumir(chatId)) return null;

    const ia = await interpretarReplyRegistro(texto, {
      cuentas: contexto.cuentas.map(c => c.nombre),
      categorias: contexto.categorias.map(c => c.nombre),
      hoy
    });
    return replyDesdeGemini(ia, { ...contexto, hoy });
  }

  /**
   * Atiende un mensaje que responde a otro. Devuelve true si el mensaje era una acción sobre un
   * registro; false si no (el flujo normal sigue como si no hubiera sido una respuesta).
   */
  async function manejarReply(msg) {
    const chatId = msg.chat.id;
    const respondido = msg.reply_to_message;
    if (!respondido || typeof msg.text !== 'string') return false;

    try {
      const vinculo = await buscarVinculo(chatId, respondido.message_id);
      if (!vinculo) return false;

      const r = await interpretar(chatId, msg.text.trim());
      if (!r) return false;

      // Respuesta a la confirmación de una eliminación o corrección: solo "deshacer"
      if (vinculo.tipo === 'historial') {
        if (r.accion !== 'deshacer') return false;
        await enviar(chatId, esc(await ejecutarDeshacer(vinculo.registroId)));
        return true;
      }

      if (r.accion === 'deshacer') {
        const historialId = await historialPendienteDe(vinculo.tipo, vinculo.registroId);
        await enviar(chatId, historialId
          ? esc(await ejecutarDeshacer(historialId))
          : 'No hay nada que deshacer en ese registro (solo se puede durante 24 horas).');
        return true;
      }
      if (r.accion === 'eliminar') return await pedirEliminacion(chatId, vinculo.tipo, vinculo.registroId);
      if (r.accion === 'corregir') return await pedirCorreccion(chatId, vinculo.tipo, vinculo.registroId, r);
      return false;
    } catch (error) {
      errorBD('Error al procesar la respuesta a un registro', error);
      await enviar(chatId, describirError(error, 'procesar', 'tu respuesta').usuario);
      return true;
    }
  }

  /** "elimina el último gasto": el último registro creado a mano en este chat, con confirmación */
  async function eliminarUltimo(chatId) {
    try {
      const ultimo = await ultimoRegistroManual(chatId);
      if (!ultimo) {
        await enviar(chatId, 'No encuentro un registro reciente tuyo en este chat para eliminar.');
        return true;
      }
      return await pedirEliminacion(chatId, ultimo.tipo, ultimo.registroId);
    } catch (error) {
      errorBD('Error al buscar el último registro', error);
      await enviar(chatId, describirError(error, 'consultar', 'el último registro').usuario);
      return true;
    }
  }

  // -------------------------------------------------------------------------
  // Botones
  // -------------------------------------------------------------------------

  /** Botones de este módulo. Devuelve true si el callback era suyo. */
  async function manejarCallback(cb, chatId, data) {
    const messageId = cb.message.message_id;
    let m;

    if ((m = data.match(/^rge_(.+)$/))) {
      await confirmarEliminacion(cb, chatId, m[1]);
      return true;
    }
    if ((m = data.match(/^rgs_(.+)$/))) {
      await confirmarCorreccion(cb, chatId, m[1]);
      return true;
    }
    if ((m = data.match(/^rgx_(.+)$/))) {
      pendientes.delete(m[1]);
      await editar('Cancelado', { chat_id: chatId, message_id: messageId });
      await responderCallback(cb.id, { text: 'Cancelado' });
      return true;
    }
    if ((m = data.match(/^rgu_(\d+)$/))) {
      const texto = await ejecutarDeshacer(Number(m[1]));
      await editar(esc(texto), { chat_id: chatId, message_id: messageId });
      await responderCallback(cb.id, {});
      return true;
    }
    return false;
  }

  return { manejarReply, manejarCallback, eliminarUltimo };
}
