/**
 * /editarcuenta (alias /editartarjeta): editar una cuenta o tarjeta ya guardada desde Telegram.
 *
 * Sin argumentos lista las cuentas con botones ("nombre · tipo · ****1234 · titular"). Al elegir una, muestra sus datos y un
 * botón por campo (Nombre, Tipo, Banco, Titular, Últimos 4 dígitos, Cuenta vinculada y Predeterminada). Cada campo se edita
 * respondiendo con el valor nuevo o eligiendo una opción, con un resumen y botones Guardar y Cancelar. También lo usan las
 * frases ("cambia el nombre de la 8263 a Crédito Valeska", "edita la cuenta 8263") y el botón Editar de /cuentas.
 *
 * Valida que los dígitos sean exactamente 4 y que no queden dos cuentas con los mismos 4 dígitos y el mismo tipo (ver
 * edicionCuentas.js). Los textos de la BD (nombres, titulares) se escapan siempre.
 */

import { botonCerrar } from './cerrar.js';
import { describirError } from './errores.js';
import {
  CAMPOS,
  CAMPO_POR_CODIGO,
  TIPOS_DB,
  etiquetaCuenta,
  validarEdicion,
  valorActual,
  cuentasEditables,
  obtenerCuentaEditable,
  cuentasPorDigitos,
  aplicarEdicion
} from '../edicionCuentas.js';
import { ETIQUETAS_TIPO_DB } from './cuentas.js';
import { migrarStorage } from '../migrarStorage.js';

const ESPERA_MS = 10 * 60 * 1000;
const ES_TARJETA = (c) => String(c.tipo).startsWith('tarjeta');

export function crearEditarCuenta(ctx) {
  const { bot, enviar, editar, responderCallback, esc, esChatAutorizado } = ctx;
  const borrarMensaje = ctx.borrarMensaje ?? (async () => {});

  // Campo que se está esperando por texto: chatId -> { cuentaId, campo, messageId, hasta }
  const esperando = new Map();
  // Cambios esperando Guardar o Cancelar: clave -> { cuentaId, campo, valor }
  const pendientes = new Map();
  // Mensajes con una pregunta o resumen abiertos (su Cancelar vale); al responder, guardar o cancelar dejan de estar abiertos
  const abiertas = new Set();
  let contador = 0;

  const nuevaClave = () => `${Date.now().toString(36)}${contador++}`;

  function errorBD(contexto, error) {
    console.error(`${contexto}:`, error.code ?? error.name);
  }

  // Cuentas cuyos archivos se están moviendo ahora (evita un doble clic)
  const moviendo = new Set();

  /**
   * Tras cambiar tipo, titular o dígitos la carpeta de la cuenta cambia (cuentas/<tipo>-<titular>-<últimos4>/). Simula la migración de
   * esa cuenta y, si hay archivos que mover, ofrece moverlos. No toca nada hasta que se pulsa el botón.
   */
  async function ofrecerMoverArchivos(chatId, cuentaId) {
    try {
      const sim = await migrarStorage({ aplicar: false, cuentaId });
      if (sim.movidos === 0) return;
      await enviar(chatId,
        `Esta cuenta tiene <b>${sim.movidos}</b> ${sim.movidos === 1 ? 'archivo guardado' : 'archivos guardados'} en la carpeta anterior. ` +
        '¿Los muevo a la carpeta nueva? Se verifica cada archivo, se actualiza la base de datos en una sola transacción y, si algo falla, todo vuelve a su lugar.',
        {
          reply_markup: {
            inline_keyboard: [[
              { text: 'Mover sus archivos a la carpeta nueva', callback_data: `ecm_${cuentaId}` },
              { text: 'Ahora no', callback_data: `ecn_${cuentaId}` }
            ]]
          }
        }
      );
    } catch (error) {
      errorBD('Error al revisar los archivos de una cuenta', error);
    }
  }

  // -------------------------------------------------------------------------
  // Lista y ficha de una cuenta
  // -------------------------------------------------------------------------

  async function listar(chatId) {
    const cuentas = await cuentasEditables();
    if (cuentas.length === 0) {
      await enviar(chatId, 'No tienes cuentas activas. Crea una con /savecard o escribe, por ejemplo: guarda la tarjeta crédito 8263 es de Valeska.');
      return true;
    }
    await enviar(chatId, '<b>¿Qué cuenta quieres editar?</b>', {
      reply_markup: {
        inline_keyboard: [
          ...cuentas.slice(0, 40).map(c => [{ text: etiquetaCuenta(c).slice(0, 60), callback_data: `ecs_${c.id}` }]),
          botonCerrar()
        ]
      }
    });
    return true;
  }

  function textoFicha(c) {
    return (
      `<b>${esc(c.nombre)}</b>\n` +
      `Tipo: ${esc(valorActual(c, 'tipo'))}\n` +
      `Banco: ${esc(valorActual(c, 'banco'))}\n` +
      `Titular: ${esc(valorActual(c, 'titular'))}\n` +
      `Tarjeta terminada en: ${c.ultimos4 ? esc(c.ultimos4) : 'sin dígitos'}\n` +
      `Cuenta vinculada terminada en: ${c.ultimos4_cuenta ? esc(c.ultimos4_cuenta) : 'sin cuenta vinculada'}\n` +
      `Predeterminada: ${esc(valorActual(c, 'predeterminada'))}\n\n` +
      '¿Qué quieres cambiar?'
    );
  }

  function tecladoFicha(c) {
    const boton = (campo) => ({ text: CAMPOS[campo].etiqueta, callback_data: `ecf_${CAMPOS[campo].codigo}_${c.id}` });
    const filas = [
      [boton('nombre'), boton('tipo')],
      [boton('banco'), boton('titular')],
      [boton('ultimos4')]
    ];
    if (ES_TARJETA(c)) filas[2].push(boton('cuenta'));
    filas.push([boton('predeterminada'), ...botonCerrar()]);
    return { reply_markup: { inline_keyboard: filas } };
  }

  /** Muestra los datos de la cuenta y los botones de cada campo (edita el mensaje si se da messageId) */
  async function mostrarFicha(chatId, cuentaId, messageId = null) {
    const c = await obtenerCuentaEditable(cuentaId);
    if (!c) {
      await enviar(chatId, 'Esa cuenta ya no está activa.');
      return true;
    }
    if (messageId) abiertas.delete(messageId);
    const editado = messageId ? await editar(textoFicha(c), { chat_id: chatId, message_id: messageId, ...tecladoFicha(c) }) : null;
    if (!editado) await enviar(chatId, textoFicha(c), tecladoFicha(c));
    return true;
  }

  // -------------------------------------------------------------------------
  // Un campo: pedir el valor, validar y confirmar
  // -------------------------------------------------------------------------

  async function pedirCampo(chatId, cuentaId, campo, messageId) {
    const c = await obtenerCuentaEditable(cuentaId);
    if (!c) {
      await enviar(chatId, 'Esa cuenta ya no está activa.');
      return;
    }
    const cancelar = [{ text: 'Cancelar', callback_data: `ecc_${cuentaId}` }];

    abiertas.add(messageId);
    if (campo === 'tipo') {
      await editar(`<b>${esc(c.nombre)}</b>\nElige el tipo nuevo (ahora: ${esc(valorActual(c, 'tipo'))}):`, {
        chat_id: chatId,
        message_id: messageId,
        reply_markup: {
          inline_keyboard: [
            ...TIPOS_DB.map(t => [{ text: ETIQUETAS_TIPO_DB[t], callback_data: `ecv_${t}_${cuentaId}` }]),
            cancelar
          ]
        }
      });
      return;
    }

    if (campo === 'predeterminada') {
      const esLaPredeterminada = Number(c.predeterminada) === 1;
      await editar(
        `<b>${esc(c.nombre)}</b>\n` +
        (esLaPredeterminada
          ? 'Hoy es tu cuenta predeterminada (la que uso cuando no dices con qué pagaste).'
          : 'La cuenta predeterminada es la que uso cuando no dices con qué pagaste. ¿La dejo así?'),
        {
          chat_id: chatId,
          message_id: messageId,
          reply_markup: {
            inline_keyboard: [
              [{ text: esLaPredeterminada ? 'Quitarle lo predeterminada' : 'Sí, hacerla predeterminada', callback_data: `ecv_${esLaPredeterminada ? '0' : '1'}p_${cuentaId}` }],
              cancelar
            ]
          }
        }
      );
      return;
    }

    // Los demás se editan respondiendo con el valor nuevo
    esperando.set(chatId, { cuentaId, campo, messageId, hasta: Date.now() + ESPERA_MS });
    const pista = {
      nombre: 'Escribe el nombre nuevo (por ejemplo: Crédito Valeska).',
      banco: 'Escribe el banco (por ejemplo: Banco de Chile) o «quitar».',
      titular: 'Escribe el titular (o «yo» para ti) o «quitar».',
      ultimos4: 'Escribe los 4 últimos dígitos de la tarjeta (nunca el número completo).',
      cuenta: 'Escribe los 4 últimos dígitos de la cuenta vinculada (nunca el número completo) o «quitar».'
    }[campo];
    await editar(`<b>${esc(c.nombre)}</b>\n${CAMPOS[campo].etiqueta} ahora: ${esc(valorActual(c, campo))}\n\n${pista}`, {
      chat_id: chatId,
      message_id: messageId,
      reply_markup: { inline_keyboard: [cancelar] }
    });
  }

  /** Valida el valor nuevo y muestra el resumen con Guardar y Cancelar. Devuelve false si no es válido (ya avisó). */
  async function proponerCambio(chatId, cuentaId, campo, entrada, { messageId = null, silencioso = false } = {}) {
    const [cuenta, todas] = await Promise.all([obtenerCuentaEditable(cuentaId), cuentasEditables()]);
    if (!cuenta) {
      await enviar(chatId, 'Esa cuenta ya no está activa.');
      return false;
    }
    const v = validarEdicion(cuenta, campo, entrada, todas);
    if (!v.ok) {
      await enviar(chatId, esc(v.error));
      return false;
    }

    const antes = valorActual(cuenta, campo);
    if (String(antes) === String(v.texto)) {
      if (!silencioso) await enviar(chatId, `Ya estaba así (${esc(antes)}): no hay nada que cambiar.`);
      return false;
    }

    const key = nuevaClave();
    pendientes.set(key, { cuentaId, campo, entrada });
    setTimeout(() => pendientes.delete(key), ESPERA_MS).unref?.();
    const texto =
      `<b>¿Guardar este cambio en ${esc(cuenta.nombre)}?</b>\n\n${esc(CAMPOS[campo].etiqueta)}: ${esc(antes)} → <b>${esc(v.texto)}</b>`;
    const opciones = {
      reply_markup: {
        inline_keyboard: [[
          { text: 'Guardar', callback_data: `ecg_${key}` },
          { text: 'Cancelar', callback_data: `ecc_${cuentaId}` }
        ]]
      }
    };
    const editado = messageId ? await editar(texto, { chat_id: chatId, message_id: messageId, ...opciones }) : null;
    if (editado) abiertas.add(messageId);
    else {
      const enviado = await enviar(chatId, texto, opciones);
      if (enviado?.message_id) abiertas.add(enviado.message_id);
    }
    return true;
  }

  /** Respuesta de texto al campo que se está editando. true si consumió el mensaje. */
  async function manejarTexto(msg) {
    const chatId = msg.chat.id;
    const espera = esperando.get(chatId);
    if (!espera || typeof msg.text !== 'string') return false;
    if (Date.now() > espera.hasta) {
      esperando.delete(chatId);
      return false;
    }

    try {
      // Un número largo escrito por error no se queda en el chat
      const c = await obtenerCuentaEditable(espera.cuentaId);
      const v = c ? validarEdicion(c, espera.campo, msg.text, await cuentasEditables()) : null;
      if (v && !v.ok && v.largo) await borrarMensaje(chatId, msg.message_id);

      const valido = await proponerCambio(chatId, espera.cuentaId, espera.campo, msg.text, { messageId: null });
      if (valido) {
        esperando.delete(chatId);
        abiertas.delete(espera.messageId); // la pregunta ya se respondió (el bot le quita el Cancelar y deja la respuesta)
      }
    } catch (error) {
      errorBD('Error al editar una cuenta', error);
      await enviar(chatId, describirError(error, 'actualizar', 'la cuenta').usuario);
    }
    return true;
  }

  // -------------------------------------------------------------------------
  // Para las frases ("cambia el nombre de la 8263 a X", "edita la cuenta 8263")
  // -------------------------------------------------------------------------

  /** Cuenta con esos 4 dígitos: { cuenta } o null (ya avisó si no hay o si hay varias) */
  async function resolverPorDigitos(chatId, digitos) {
    const halladas = await cuentasPorDigitos(digitos);
    if (halladas.length === 0) {
      await enviar(chatId, `No encuentro una cuenta o tarjeta terminada en ${esc(digitos)}. Escribe /editarcuenta para ver tus cuentas.`);
      return null;
    }
    if (halladas.length > 1) {
      await enviar(chatId, 'Hay varias cuentas con esos dígitos. Elige cuál quieres editar:', {
        reply_markup: { inline_keyboard: halladas.map(c => [{ text: etiquetaCuenta(c).slice(0, 60), callback_data: `ecs_${c.id}` }]) }
      });
      return null;
    }
    return { cuenta: halladas[0] };
  }

  /** "edita la cuenta 8263": abre su ficha */
  async function abrirPorDigitos(chatId, digitos) {
    const r = await resolverPorDigitos(chatId, digitos);
    if (r) await mostrarFicha(chatId, r.cuenta.id);
    return true;
  }

  /** "cambia el nombre de la 8263 a X" o "la tarjeta 8263 es del banco de chile": propone el cambio con Guardar y Cancelar */
  async function cambiarCampoPorDigitos(chatId, digitos, campo, valor) {
    const r = await resolverPorDigitos(chatId, digitos);
    if (r) await proponerCambio(chatId, r.cuenta.id, campo, valor);
    return true;
  }

  // -------------------------------------------------------------------------
  // Comando y botones
  // -------------------------------------------------------------------------

  function configurarComandos() {
    bot.onText(/^\/(?:editarcuenta|editartarjeta)(?:@\w+)?(?:\s+(\d{4}))?\s*$/i, async (msg, match) => {
      const chatId = msg.chat.id;
      if (!esChatAutorizado(chatId)) {
        await enviar(chatId, 'No estás autorizado para usar este bot.');
        return;
      }
      try {
        if (match[1]) await abrirPorDigitos(chatId, match[1]);
        else await listar(chatId);
      } catch (error) {
        errorBD('Error en /editarcuenta', error);
        await enviar(chatId, describirError(error, 'consultar', 'las cuentas').usuario);
      }
    });
  }

  /** Botones de este módulo. Devuelve true si el callback era suyo. */
  async function manejarCallback(cb, chatId, data) {
    const m = /^ec([sfvgcxmn])_(.+)$/.exec(data);
    if (!m) return false;
    const [, tipo, valor] = m;
    const messageId = cb.message.message_id;

    try {
      // Elegir una cuenta
      if (tipo === 's') {
        await responderCallback(cb.id, {});
        esperando.delete(chatId);
        await mostrarFicha(chatId, Number(valor), messageId);
        return true;
      }

      // Elegir un campo para editar
      if (tipo === 'f') {
        const [, codigo, id] = /^([a-z])_(\d+)$/.exec(valor) ?? [];
        const campo = CAMPO_POR_CODIGO[codigo];
        if (!campo) {
          await responderCallback(cb.id, { text: 'Opción no válida' });
          return true;
        }
        await responderCallback(cb.id, {});
        await pedirCampo(chatId, Number(id), campo, messageId);
        return true;
      }

      // Una opción elegida con botón: tipo (ecv_<tipo>_<id>) o predeterminada (ecv_1p_<id> / ecv_0p_<id>)
      if (tipo === 'v') {
        const op = /^(.+)_(\d+)$/.exec(valor);
        if (!op) return true;
        await responderCallback(cb.id, {});
        if (/^[01]p$/.test(op[1])) await proponerCambio(chatId, Number(op[2]), 'predeterminada', op[1] === '1p', { messageId });
        else await proponerCambio(chatId, Number(op[2]), 'tipo', op[1], { messageId });
        return true;
      }

      // Guardar
      if (tipo === 'g') {
        const pendiente = pendientes.get(valor);
        if (!pendiente) {
          await responderCallback(cb.id, { text: 'Este botón ya expiró, vuelve a intentarlo' });
          return true;
        }
        pendientes.delete(valor);
        abiertas.delete(messageId);
        // Se vuelve a validar al guardar: otra edición pudo dejar ese dato ocupado
        const [cuenta, todas] = await Promise.all([obtenerCuentaEditable(pendiente.cuentaId), cuentasEditables()]);
        const v = cuenta ? validarEdicion(cuenta, pendiente.campo, pendiente.entrada, todas) : null;
        if (!v?.ok) {
          await editar(esc(v?.error ?? 'Esa cuenta ya no está activa.'), { chat_id: chatId, message_id: messageId });
          await responderCallback(cb.id, { text: 'No se pudo guardar' });
          return true;
        }
        const listo = await aplicarEdicion(pendiente.cuentaId, pendiente.campo, v.valor);
        await responderCallback(cb.id, { text: listo ? 'Guardado' : 'Sin cambios' });
        if (listo) {
          await mostrarFicha(chatId, pendiente.cuentaId, messageId);
          // Si el cambio mueve la carpeta de la cuenta (tipo, titular o dígitos), se ofrece llevar sus archivos a la carpeta nueva
          if (['tipo', 'titular', 'ultimos4', 'cuenta'].includes(pendiente.campo)) await ofrecerMoverArchivos(chatId, pendiente.cuentaId);
        } else await editar('No pude guardarlo: la cuenta ya no está activa.', { chat_id: chatId, message_id: messageId });
        return true;
      }

      // Mover los archivos de la cuenta a su carpeta nueva (ecm_<id>) o dejarlos donde están (ecn_<id>)
      if (tipo === 'n') {
        await responderCallback(cb.id, { text: 'Los archivos se quedan donde están' });
        await editar('Listo: los archivos de esta cuenta se quedan en su carpeta actual. Lo nuevo se guardará en la carpeta nueva.', { chat_id: chatId, message_id: messageId });
        return true;
      }
      if (tipo === 'm') {
        if (moviendo.has(valor)) {
          await responderCallback(cb.id, { text: 'Ya los estoy moviendo' });
          return true;
        }
        moviendo.add(valor);
        try {
          await responderCallback(cb.id, { text: 'Moviendo...' });
          await editar('Moviendo los archivos de la cuenta...', { chat_id: chatId, message_id: messageId });
          const r = await migrarStorage({ aplicar: true, cuentaId: Number(valor) });
          await editar(
            r.movidos > 0
              ? `Moví ${r.movidos} ${r.movidos === 1 ? 'archivo' : 'archivos'} a la carpeta nueva de la cuenta. Dejé un log en la carpeta respaldos/.`
              : 'No había archivos por mover.',
            { chat_id: chatId, message_id: messageId }
          );
        } catch (error) {
          errorBD('Error al mover los archivos de una cuenta', error);
          await editar(`${describirError(error, 'mover_archivo', 'los archivos de la cuenta').usuario} Devolví todo a su lugar.`, { chat_id: chatId, message_id: messageId });
        } finally {
          moviendo.delete(valor);
        }
        return true;
      }

      // Cancelar (vuelve a la ficha) o cerrar
      if (tipo === 'c') {
        // Un Cancelar viejo (el cambio ya se guardó o la pregunta ya se respondió) no hace nada
        if (!abiertas.has(messageId)) {
          await responderCallback(cb.id, { text: 'Ese cambio ya se guardó, usa /editarcuenta para modificarlo' });
          await bot.editMessageReplyMarkup({ inline_keyboard: [] }, { chat_id: chatId, message_id: messageId }).catch(() => {});
          return true;
        }
        abiertas.delete(messageId);
        esperando.delete(chatId);
        await responderCallback(cb.id, { text: 'Cancelado' });
        await mostrarFicha(chatId, Number(valor), messageId);
        return true;
      }
      if (tipo === 'x') {
        abiertas.delete(messageId);
        esperando.delete(chatId);
        await editar('Listo.', { chat_id: chatId, message_id: messageId });
        await responderCallback(cb.id, {});
        return true;
      }
    } catch (error) {
      errorBD('Error en un botón de editar cuenta', error);
      await responderCallback(cb.id, { text: describirError(error, 'procesar', 'el cambio de la cuenta').toast });
      return true;
    }
    return false;
  }

  return { configurarComandos, manejarCallback, manejarTexto, listar, abrirPorDigitos, cambiarCampoPorDigitos, mostrarFicha, proponerCambio };
}
