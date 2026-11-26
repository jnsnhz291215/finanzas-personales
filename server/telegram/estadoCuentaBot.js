/**
 * /estadocuenta (alias /cartolas, /historial): revisar los estados de cuenta guardados, cuenta -> año -> mes, con botones que
 * editan el mismo mensaje. Al elegir un mes muestra el resumen (cargos, abonos, cuotas, marcados como míos e ignorados) y la
 * lista de movimientos, y ofrece descargar la cartola original guardada.
 *
 * Botones (prefijo ex): exl_x lista de cuentas · exc_<cuenta> años · exa_<cuenta>_<año> meses · exm_<cuenta>_<YYYY-MM> mes ·
 * exd_<cartola> descargar.
 *
 * Privacidad: nunca se muestra la ruta de un archivo; la descarga solo envía archivos que están dentro de FINANZAS_STORAGE.
 */

import { promises as fs } from 'fs';
import {
  interpretarConsultaEstado,
  cuentasQueCalzan,
  cuentasConRegistros,
  obtenerCuenta,
  mesesDeCuenta,
  detalleDeMes,
  obtenerArchivo,
  resumirMes,
  aniosDe,
  nombreMes
} from '../estadoCuenta.js';
import { resolverArchivo, rutaRaiz, dentroDe } from '../storage.js';
import { ETIQUETAS_TIPO_DB } from './cuentas.js';
import { formatearFechaCL } from './fechas.js';
import { partirEnMensajes } from './cuotas.js';

// Movimientos que se listan como máximo (el resto se resume en una línea)
const MAX_MOVIMIENTOS = 80;

export function crearEstadoCuenta(ctx) {
  const { bot, enviar, editar, responderCallback, esc, formatearMonto, esChatAutorizado } = ctx;
  const dinero = (n) => `$${formatearMonto(n)}`;

  /** Edita el mensaje de los botones; si no se puede (o no hay mensaje), manda uno nuevo */
  async function mostrar(chatId, messageId, texto, teclado) {
    const opciones = { reply_markup: { inline_keyboard: teclado } };
    if (messageId) {
      const editado = await editar(texto, { chat_id: chatId, message_id: messageId, ...opciones });
      if (editado) return;
    }
    await enviar(chatId, texto, opciones);
  }

  const etiquetaCuenta = (c) => {
    const digitos = c.ultimos4 || c.ultimos4_cuenta;
    return [c.nombre, digitos ? `****${digitos}` : null].filter(Boolean).join(' ').slice(0, 56);
  };

  // -------------------------------------------------------------------------
  // Pasos
  // -------------------------------------------------------------------------

  async function pasoCuentas(chatId, messageId, cuentas, aviso = null) {
    if (cuentas.length === 0) {
      await mostrar(chatId, messageId, 'Todavía no hay movimientos ni cartolas guardadas.', []);
      return;
    }
    await mostrar(
      chatId, messageId,
      `${aviso ? `${aviso}\n\n` : ''}<b>Estados de cuenta</b>\n¿De qué cuenta?`,
      cuentas.map(c => [{ text: etiquetaCuenta(c), callback_data: `exc_${c.id}` }])
    );
  }

  /** Años de la cuenta; si hay uno solo se salta directo a sus meses */
  async function pasoAnios(chatId, messageId, cuentaId) {
    const cuenta = await obtenerCuenta(cuentaId);
    if (!cuenta) return mostrar(chatId, messageId, 'Esa cuenta ya no está disponible.', []);
    const anios = aniosDe((await mesesDeCuenta(cuentaId)).keys());
    if (anios.length === 0) {
      return mostrar(chatId, messageId, `${esc(cuenta.nombre)} no tiene movimientos ni cartolas guardadas.`, [[{ text: 'Volver', callback_data: 'exl_x' }]]);
    }
    if (anios.length === 1) return pasoMeses(chatId, messageId, cuentaId, anios[0]);
    await mostrar(
      chatId, messageId,
      `<b>${esc(cuenta.nombre)}</b>\n¿De qué año?`,
      [...anios.map(a => [{ text: a, callback_data: `exa_${cuentaId}_${a}` }]), [{ text: 'Volver', callback_data: 'exl_x' }]]
    );
  }

  async function pasoMeses(chatId, messageId, cuentaId, anio) {
    const cuenta = await obtenerCuenta(cuentaId);
    if (!cuenta) return mostrar(chatId, messageId, 'Esa cuenta ya no está disponible.', []);
    const meses = await mesesDeCuenta(cuentaId);
    const delAnio = [...meses.entries()].filter(([m]) => m.startsWith(`${anio}-`)).sort((a, b) => b[0].localeCompare(a[0]));
    const variosAnios = aniosDe(meses.keys()).length > 1;
    const volver = [{ text: 'Volver', callback_data: variosAnios ? `exc_${cuentaId}` : 'exl_x' }];

    if (delAnio.length === 0) return mostrar(chatId, messageId, `${esc(cuenta.nombre)} no tiene registros en ${esc(anio)}.`, [volver]);
    await mostrar(
      chatId, messageId,
      `<b>${esc(cuenta.nombre)}</b> · ${esc(anio)}\n¿Qué mes?`,
      [
        ...delAnio.map(([mes, n]) => [{
          text: `${nombreMes(mes)} · ${n.movimientos} mov.${n.cartolas > 0 ? ` · ${n.cartolas} cartola${n.cartolas === 1 ? '' : 's'}` : ''}`.slice(0, 60),
          callback_data: `exm_${cuentaId}_${mes}`
        }]),
        volver
      ]
    );
  }

  function lineaMovimiento(m) {
    const descripcion = m.descripcion.length > 34 ? `${m.descripcion.slice(0, 33)}...` : m.descripcion;
    return `${formatearFechaCL(m.fecha)} · ${esc(descripcion)} · ${m.tipo === 'cargo' ? '-' : '+'}${dinero(m.monto)}`;
  }

  async function pasoMes(chatId, messageId, cuentaId, mes) {
    const cuenta = await obtenerCuenta(cuentaId);
    if (!cuenta) return mostrar(chatId, messageId, 'Esa cuenta ya no está disponible.', []);
    const { movimientos, archivos } = await detalleDeMes(cuentaId, mes);
    const r = resumirMes(movimientos, archivos);

    const lineas = [
      `<b>${esc(cuenta.nombre)}</b>`,
      `Titular: ${esc(cuenta.titular || 'sin titular')} · ${esc(ETIQUETAS_TIPO_DB[cuenta.tipo] ?? cuenta.tipo)}`,
      `Período: ${esc(nombreMes(mes))}`,
      '',
      `Cargos: ${r.cargos} por ${dinero(r.totalCargos)}`,
      `Abonos: ${r.abonos} por ${dinero(r.totalAbonos)}`,
      `Cuotas detectadas: ${r.cuotas.length > 0 ? r.cuotas.map(c => esc(c)).join(', ') : 'ninguna'}`
    ];
    if (r.marcadosMios !== null) lineas.push(`Marcados como míos: ${r.marcadosMios} · ignorados: ${r.ignorados}`);
    if (archivos.length > 0) lineas.push(`Cartolas guardadas: ${archivos.length}`);

    const botones = archivos.map((a, i) => [{
      text: archivos.length === 1 ? 'Descargar cartola' : `Descargar cartola ${i + 1}${a.periodo_hasta ? ` (hasta ${formatearFechaCL(String(a.periodo_hasta).slice(0, 10))})` : ''}`.slice(0, 60),
      callback_data: `exd_${a.id}`
    }]);
    const anio = mes.slice(0, 4);
    botones.push([{ text: 'Volver', callback_data: `exa_${cuentaId}_${anio}` }]);
    await mostrar(chatId, messageId, lineas.join('\n'), botones);

    if (movimientos.length > 0) {
      const mostrados = movimientos.slice(0, MAX_MOVIMIENTOS);
      const resto = movimientos.length - mostrados.length;
      const mensajes = partirEnMensajes([
        '<b>Movimientos</b>',
        ...mostrados.map(lineaMovimiento),
        ...(resto > 0 ? [`... y ${resto} más`] : [])
      ]);
      for (const m of mensajes) await enviar(chatId, m);
    }
  }

  // -------------------------------------------------------------------------
  // Descarga
  // -------------------------------------------------------------------------

  async function descargar(chatId, archivoId) {
    const archivo = await obtenerArchivo(archivoId);
    // Solo se envía un archivo que existe y está dentro de FINANZAS_STORAGE; la ruta nunca llega al chat
    const absoluta = archivo ? await resolverArchivo(archivo.ruta_archivo) : null;
    if (!absoluta || !dentroDe(rutaRaiz(), absoluta)) return false;
    try {
      await fs.access(absoluta);
      await bot.sendDocument(chatId, absoluta);
      return true;
    } catch (error) {
      console.error('Error al enviar una cartola:', error.code ?? error.name);
      return false;
    }
  }

  // -------------------------------------------------------------------------
  // Entrada
  // -------------------------------------------------------------------------

  /** Empieza con lo que se pidió (dígitos, titular, nombre) o con la lista de cuentas que tienen registros */
  async function responder(chatId, consulta) {
    const cuentas = await cuentasConRegistros();
    if (!consulta || (!consulta.digitos && !consulta.titular && !consulta.termino)) return pasoCuentas(chatId, null, cuentas);

    const calzan = cuentasQueCalzan(consulta, cuentas);
    if (calzan.length === 1) return pasoAnios(chatId, null, calzan[0].id);
    if (calzan.length > 1) return pasoCuentas(chatId, null, calzan, 'Hay varias cuentas que calzan.');
    return pasoCuentas(chatId, null, cuentas, 'No encontré una cuenta con registros que calce con eso.');
  }

  /**
   * Texto libre ("estado de cuenta de la 8263", "historial de la tarjeta de Valeska", "cartolas de la 8263"). Devuelve true si
   * lo atendió; un texto que no pide una cuenta concreta ni calza con ninguna se deja pasar a los demás.
   */
  async function manejarTexto(msg) {
    const consulta = interpretarConsultaEstado(msg.text);
    if (!consulta) return false;
    const chatId = msg.chat.id;
    try {
      if (!consulta.explicito) {
        const cuentas = await cuentasConRegistros();
        if (cuentasQueCalzan(consulta, cuentas).length === 0) return false;
      }
      await responder(chatId, consulta);
    } catch (error) {
      console.error('Error en /estadocuenta:', error.code ?? error.name);
      await enviar(chatId, 'No pude abrir los estados de cuenta. Inténtalo de nuevo.');
    }
    return true;
  }

  function configurarComandos() {
    bot.onText(/^\/(?:estadocuenta|cartolas|historial)(?:@\w+)?(?:\s+([\s\S]+))?$/i, async (msg, match) => {
      const chatId = msg.chat.id;
      if (!esChatAutorizado(chatId)) {
        await enviar(chatId, 'No estás autorizado para usar este bot.');
        return;
      }
      try {
        const argumento = (match[1] || '').trim();
        await responder(chatId, argumento ? interpretarConsultaEstado(`estado cuenta ${argumento}`) : null);
      } catch (error) {
        console.error('Error en /estadocuenta:', error.code ?? error.name);
        await enviar(chatId, 'No pude abrir los estados de cuenta. Inténtalo de nuevo.');
      }
    });
  }

  async function manejarCallback(cb, chatId, data) {
    let m;
    const messageId = cb.message.message_id;
    try {
      if (data === 'exl_x') {
        await responderCallback(cb.id, {});
        await pasoCuentas(chatId, messageId, await cuentasConRegistros());
        return true;
      }
      if ((m = data.match(/^exc_(\d+)$/))) {
        await responderCallback(cb.id, {});
        await pasoAnios(chatId, messageId, Number(m[1]));
        return true;
      }
      if ((m = data.match(/^exa_(\d+)_(\d{4})$/))) {
        await responderCallback(cb.id, {});
        await pasoMeses(chatId, messageId, Number(m[1]), m[2]);
        return true;
      }
      if ((m = data.match(/^exm_(\d+)_(\d{4}-\d{2})$/))) {
        await responderCallback(cb.id, {});
        await pasoMes(chatId, messageId, Number(m[1]), m[2]);
        return true;
      }
      if ((m = data.match(/^exd_(\d+)$/))) {
        const enviado = await descargar(chatId, Number(m[1]));
        await responderCallback(cb.id, { text: enviado ? 'Cartola enviada' : 'No encuentro el archivo de esa cartola' });
        return true;
      }
    } catch (error) {
      console.error('Error en /estadocuenta:', error.code ?? error.name);
      await responderCallback(cb.id, { text: 'No pude abrirlo, inténtalo de nuevo' });
      return true;
    }
    return false;
  }

  return { configurarComandos, manejarTexto, manejarCallback };
}
