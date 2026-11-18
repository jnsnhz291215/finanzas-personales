/**
 * Compras en cuotas desde Telegram: /cuotas (alta y lista), pago de cuota por mensaje, foto o
 * documento con caption, consultas sin comando y pregunta cuando una transferencia a terceros
 * parece un pago de cuota. Los comprobantes no se leen ni se envían a ningún servicio externo.
 *
 * Se crea con crearCuotas(ctx): ctx trae el bot y los envoltorios de bot.js (enviar, editar,
 * responderCallback), esc, esChatAutorizado, formatearMonto, resolverCuentaPago(medioPago),
 * guardarRespaldo(fileId, nombre), eliminarRespaldo(nombre) y manejarFoto(msg).
 * Los errores de BD se registran solo con su código.
 */

import path from 'path';
import { parsearMontoExacto, extraerFecha, extraerMedioPago } from './parser.js';
import { fechaHoySantiago, formatearFechaCL } from './fechas.js';
import {
  detectarAltaCuotas,
  parsearAltaCuotas,
  parsearPagoCuota,
  validarPagoCuota,
  buscarCompras,
  detectarConsultaCuotas,
  resumenCompra,
  normalizar
} from './cuotas.js';
import {
  listarCompras,
  obtenerCompra,
  crearCompra,
  fijarAliasCartola,
  registrarPagoCuota,
  vincularMovimientoACuota,
  buscarCuotasPorCartola
} from '../cuotas.js';

const ESPERA_MS = 5 * 60 * 1000;

const PREGUNTAS_ALTA = {
  alias: '¿Cómo le llamas a la compra? Escribe una palabra, por ejemplo: mac.',
  totalCuotas: '¿En cuántas cuotas es? Por ejemplo: 12.',
  montoCuota: '¿De cuánto es cada cuota? Por ejemplo: 85 mil.',
  acreedor: '¿A quién se le debe? Por ejemplo: tía.'
};

export function crearCuotas(ctx) {
  const {
    bot, enviar, editar, responderCallback, esc, esChatAutorizado, formatearMonto,
    resolverCuentaPago, guardarRespaldo, eliminarRespaldo, manejarFoto
  } = ctx;

  const dinero = (n) => `$${formatearMonto(n)}`;

  // Altas pendientes de confirmar: clave -> { datos }
  const pendientesAlta = new Map();
  // Pagos de cuota pendientes de confirmar: clave -> { chatId, parsed, medioPago, fecha, archivo, compraId, numero, monto }
  const pendientesPago = new Map();
  // Fotos sin caption esperando que se elija la compra: clave -> { info, msg }
  const fotosPendientes = new Map();
  // Dato que se espera de un chat durante el alta: chatId -> { key, campo, hasta }
  const esperando = new Map();

  const botonCancelarAlta = (key) => ({ reply_markup: { inline_keyboard: [[{ text: 'Cancelar', callback_data: `cqx_${key}` }]] } });
  const caducar = (mapa, key) => setTimeout(() => mapa.delete(key), ESPERA_MS);

  function errorBD(contexto, error) {
    console.error(`${contexto}:`, error.code ?? error.name);
  }

  // -------------------------------------------------------------------------
  // Texto de las compras
  // -------------------------------------------------------------------------

  function lineaCompra(c, hoy, prefijo = '') {
    const r = resumenCompra(c, hoy);
    const proxima = r.proximaCuota
      ? `próxima: cuota ${r.proximaCuota}${r.proximaFecha ? ` el ${formatearFechaCL(r.proximaFecha)}` : ''} (${dinero(r.montoCuota)})`
      : 'terminada';
    return `${prefijo}<b>${esc(c.alias)}</b> (${esc(c.acreedor)}) - ${r.pagadas}/${r.total} pagadas - ` +
      `pendiente ${dinero(r.montoPendiente)} - ${proxima}`;
  }

  async function enviarLista(chatId) {
    const compras = await listarCompras();
    if (compras.length === 0) {
      await enviar(chatId,
        'No tienes compras en cuotas en curso.\n\nCrea una con: /cuotas nueva mac 12 cuotas de 85 mil tía, pagadas 6'
      );
      return;
    }
    const hoy = fechaHoySantiago();
    const total = compras.reduce((suma, c) => suma + resumenCompra(c, hoy).montoPendiente, 0);
    await enviar(chatId,
      '<b>Compras en cuotas:</b>\n\n' +
      compras.map((c, i) => lineaCompra(c, hoy, `${i + 1}. `)).join('\n') +
      `\n\nTotal pendiente: ${dinero(total)}\n\nPaga una cuota escribiendo, por ejemplo: pagué cuota tía mac`
    );
  }

  // -------------------------------------------------------------------------
  // Alta
  // -------------------------------------------------------------------------

  function faltaEnAlta(d) {
    if (!d.alias) return 'alias';
    if (!d.totalCuotas) return 'totalCuotas';
    if (!d.montoCuota) return 'montoCuota';
    if (!d.acreedor) return 'acreedor';
    return null;
  }

  function textoConfirmacionAlta(d) {
    const pagadas = d.cuotasPagadas ?? 0;
    const total = d.montoTotal ?? d.montoCuota * d.totalCuotas;
    return (
      '<b>Confirmar compra en cuotas:</b>\n\n' +
      `Compra: ${esc(d.alias)}\n` +
      `A quién: ${esc(d.acreedor)}\n` +
      `Cuotas: ${d.totalCuotas} de ${dinero(d.montoCuota)}\n` +
      `Pagadas: ${pagadas} de ${d.totalCuotas}\n` +
      `Total: ${dinero(total)}${d.montoTotal ? '' : ' (cuotas por monto)'}\n` +
      `Queda por pagar: ${dinero((d.totalCuotas - pagadas) * d.montoCuota)}\n` +
      `Día de pago: ${d.diaPago ?? 'sin indicar'}\n` +
      `Alias en la cartola: ${d.aliasCartola ? esc(d.aliasCartola) : 'sin indicar'}`
    );
  }

  async function avanzarAlta(chatId, key) {
    const pendiente = pendientesAlta.get(key);
    if (!pendiente) return;
    const d = pendiente.datos;

    if (d.cuotasPagadas !== null && d.totalCuotas && d.cuotasPagadas > d.totalCuotas) {
      await enviar(chatId, `Las cuotas pagadas (${d.cuotasPagadas}) no pueden superar el total (${d.totalCuotas}). Se dejan en 0.`);
      d.cuotasPagadas = 0;
    }

    const falta = faltaEnAlta(d);
    if (falta) {
      esperando.set(chatId, { key, campo: falta, hasta: Date.now() + ESPERA_MS });
      await enviar(chatId, PREGUNTAS_ALTA[falta], botonCancelarAlta(key));
      return;
    }

    esperando.delete(chatId);
    await enviar(chatId, textoConfirmacionAlta(d), {
      reply_markup: {
        inline_keyboard: [[
          { text: 'Guardar', callback_data: `cqg_${key}` },
          { text: 'Cancelar', callback_data: `cqx_${key}` }
        ]]
      }
    });
  }

  async function iniciarAlta(chatId, texto) {
    const datos = parsearAltaCuotas(texto);
    const key = `${chatId}_${Date.now()}`;
    pendientesAlta.set(key, { datos });
    caducar(pendientesAlta, key);
    await avanzarAlta(chatId, key);
  }

  /** Respuesta a una pregunta del alta. true si el mensaje se consumió. */
  async function manejarTexto(msg) {
    const chatId = msg.chat.id;
    const espera = esperando.get(chatId);
    if (!espera) return false;
    if (Date.now() > espera.hasta) {
      esperando.delete(chatId);
      return false;
    }
    const pendiente = pendientesAlta.get(espera.key);
    if (!pendiente) {
      esperando.delete(chatId);
      return false;
    }

    const texto = msg.text.trim();
    const d = pendiente.datos;
    const reintentar = (aviso) => enviar(chatId, aviso, botonCancelarAlta(espera.key));

    if (espera.campo === 'alias') {
      const alias = texto.split(/\s+/)[0].toLowerCase();
      if (!alias) return (await reintentar('Escribe una palabra para identificar la compra.'), true);
      d.alias = alias.slice(0, 100);
    } else if (espera.campo === 'totalCuotas') {
      const n = parseInt(texto, 10);
      if (!/^\d{1,3}$/.test(texto) || n < 1 || n > 120) return (await reintentar('Escribe un número de cuotas entre 1 y 120.'), true);
      d.totalCuotas = n;
    } else if (espera.campo === 'montoCuota') {
      const monto = parsearMontoExacto(texto);
      if (!monto) return (await reintentar('No entendí el monto. Por ejemplo: 85 mil o 85.000.'), true);
      d.montoCuota = monto;
    } else if (espera.campo === 'acreedor') {
      if (texto.length < 2) return (await reintentar('Escribe a quién se le debe, por ejemplo: tía.'), true);
      d.acreedor = texto.slice(0, 100);
    }

    esperando.delete(chatId);
    await avanzarAlta(chatId, espera.key);
    return true;
  }

  // -------------------------------------------------------------------------
  // Pago de cuota
  // -------------------------------------------------------------------------

  function textoConfirmacionPago(compra, p, avisos) {
    const despues = Math.max(compra.cuotas_pagadas, p.numero);
    const restantes = Math.max(0, compra.total_cuotas - despues);
    return (
      '<b>Confirmar pago de cuota:</b>\n\n' +
      `Compra: ${esc(compra.alias)}\n` +
      `Cuota ${p.numero} de ${compra.total_cuotas}\n` +
      `Monto: ${dinero(p.monto)}\n` +
      `A quién: ${esc(compra.acreedor)}\n` +
      `Queda por pagar después de esta: ${dinero(restantes * compra.monto_cuota)} (${restantes} ${restantes === 1 ? 'cuota' : 'cuotas'})` +
      (p.archivo ? '\nRespaldo adjunto' : '') +
      (avisos.length > 0 ? `\n\n${avisos.map(a => `Ojo: ${esc(a)}`).join('\n')}` : '')
    );
  }

  /** Muestra la confirmación del pago para una compra elegida; valida el número de cuota */
  async function presentarPago(chatId, key, compra) {
    const p = pendientesPago.get(key);
    if (!p) return;

    const validacion = validarPagoCuota(compra, { numero: p.parsed.numero, total: p.parsed.total });
    if (validacion.errores.length > 0) {
      await descartarPago(key);
      await enviar(chatId, validacion.errores.map(e => esc(e)).join('\n'));
      return;
    }

    p.compraId = compra.id;
    p.numero = validacion.numero;
    p.monto = p.parsed.monto ?? compra.monto_cuota;

    await enviar(chatId, textoConfirmacionPago(compra, p, validacion.avisos), {
      reply_markup: {
        inline_keyboard: [[
          { text: 'Guardar', callback_data: `cqp_${key}` },
          { text: 'Cancelar', callback_data: `cqc_${key}` }
        ]]
      }
    });
  }

  /** Quita un pago pendiente y borra su respaldo si ya se había descargado */
  async function descartarPago(key) {
    const p = pendientesPago.get(key);
    pendientesPago.delete(key);
    if (p?.archivo) await eliminarRespaldo(p.archivo);
  }

  /**
   * Interpreta un texto (mensaje o caption) como pago de cuota. Devuelve true si lo era.
   * `archivo` es el nombre del respaldo ya guardado, si vino con una foto o documento.
   */
  async function iniciarPagoCuota(chatId, texto, archivo = null) {
    const parsed = parsearPagoCuota(texto);
    if (!parsed) return false;

    const compras = await listarCompras();
    if (compras.length === 0) {
      if (archivo) await eliminarRespaldo(archivo);
      await enviar(chatId, 'No tienes compras en cuotas en curso. Crea una con /cuotas nueva mac 12 cuotas de 85 mil tía.');
      return true;
    }

    const calzan = buscarCompras(compras, parsed.palabras);
    if (calzan.length === 0) {
      if (archivo) await eliminarRespaldo(archivo);
      const hoy = fechaHoySantiago();
      await enviar(chatId,
        'No encontré una compra que calce con ese mensaje. Tus compras:\n\n' +
        compras.map((c, i) => lineaCompra(c, hoy, `${i + 1}. `)).join('\n')
      );
      return true;
    }

    const key = `${chatId}_${Date.now()}`;
    pendientesPago.set(key, {
      chatId,
      parsed,
      medioPago: extraerMedioPago(texto),
      fecha: extraerFecha(texto),
      archivo,
      compraId: null
    });
    caducar(pendientesPago, key);

    if (calzan.length === 1) {
      await presentarPago(chatId, key, calzan[0]);
      return true;
    }

    // Varias coincidencias: nunca se elige sola
    await enviar(chatId, '¿De cuál compra es la cuota?', {
      reply_markup: {
        inline_keyboard: [
          ...calzan.map(c => [{
            text: `${c.alias} (${c.acreedor}) - cuota ${c.cuotas_pagadas + 1}/${c.total_cuotas}`.slice(0, 50),
            callback_data: `cqs_${key}_${c.id}`
          }]),
          [{ text: 'Cancelar', callback_data: `cqc_${key}` }]
        ]
      }
    });
    return true;
  }

  async function guardarPago(cb, chatId, key) {
    const p = pendientesPago.get(key);
    if (!p || !p.compraId) {
      await responderCallback(cb.id, { text: 'Solicitud expirada' });
      return;
    }

    try {
      const compra = await obtenerCompra(p.compraId);
      const cuenta = await resolverCuentaPago(p.medioPago);
      if (!compra || !cuenta) {
        await responderCallback(cb.id, { text: !cuenta ? 'No hay cuentas registradas' : 'La compra ya no existe' });
        return;
      }

      const { compra: actualizada } = await registrarPagoCuota({
        compraId: compra.id,
        numero: p.numero,
        monto: p.monto,
        cuentaId: cuenta.id,
        fecha: p.fecha,
        descripcion: `Cuota ${p.numero}/${compra.total_cuotas} ${compra.alias} (${compra.acreedor})`,
        archivoRespaldo: p.archivo
      });
      pendientesPago.delete(key);

      const restantes = actualizada.total_cuotas - actualizada.cuotas_pagadas;
      await editar(
        `Pago registrado: cuota ${p.numero} de ${actualizada.total_cuotas} de <b>${esc(actualizada.alias)}</b> ` +
        `(${dinero(p.monto)} a ${esc(actualizada.acreedor)}).` +
        (p.archivo ? '\nRespaldo adjunto' : '') +
        (actualizada.terminada
          ? '\n\nCompra terminada: ya pagaste todas las cuotas.'
          : `\nQueda por pagar: ${dinero(restantes * actualizada.monto_cuota)} (${restantes} ${restantes === 1 ? 'cuota' : 'cuotas'}).`),
        { chat_id: chatId, message_id: cb.message.message_id }
      );
      await responderCallback(cb.id, { text: 'Guardado' });
    } catch (error) {
      errorBD('Error al registrar el pago de cuota', error);
      await responderCallback(cb.id, { text: 'Error al guardar' });
    }
  }

  // -------------------------------------------------------------------------
  // Fotos y documentos
  // -------------------------------------------------------------------------

  /**
   * Foto o documento. Con caption que es un pago de cuota: se interpreta como un mensaje y se
   * guarda el archivo como respaldo. Foto sin caption: pregunta si es un pago de cuota y de
   * cuál compra. Devuelve true si lo atendió; false deja el flujo normal (cartolas, fotos).
   */
  async function manejarEnvio(msg) {
    const chatId = msg.chat.id;
    const caption = (msg.caption || '').trim();
    const info = msg.photo
      ? { fileId: msg.photo[msg.photo.length - 1].file_id, nombre: 'foto.jpg' }
      : { fileId: msg.document.file_id, nombre: path.basename(msg.document.file_name || `documento_${Date.now()}`) };

    if (caption) {
      if (!parsearPagoCuota(caption)) return false;
      let archivo;
      try {
        archivo = await guardarRespaldo(info.fileId, info.nombre);
      } catch (error) {
        errorBD('Error al guardar el respaldo', error);
        await enviar(chatId, 'No pude guardar el archivo, así que no registré el pago. Intenta de nuevo.');
        return true;
      }
      return iniciarPagoCuota(chatId, caption, archivo);
    }

    // Sin caption solo se pregunta por fotos (un documento sin caption sigue el flujo de cartolas)
    if (!msg.photo) return false;
    const compras = await listarCompras();
    if (compras.length === 0) return false;

    const key = `${chatId}_${Date.now()}`;
    fotosPendientes.set(key, { info, msg });
    caducar(fotosPendientes, key);
    await enviar(chatId, 'Recibí una foto. ¿Es el comprobante de una cuota? Elige la compra:', {
      reply_markup: {
        inline_keyboard: [
          ...compras.map(c => [{
            text: `${c.alias} (${c.acreedor}) - cuota ${c.cuotas_pagadas + 1}/${c.total_cuotas}`.slice(0, 50),
            callback_data: `cqf_${key}_${c.id}`
          }]),
          [{ text: 'No, solo guardar la foto', callback_data: `cqo_${key}` }]
        ]
      }
    });
    return true;
  }

  // -------------------------------------------------------------------------
  // Consultas sin comando
  // -------------------------------------------------------------------------

  /** "cuánto le debo a mi tía", "cuántas cuotas me quedan del mac". true si respondió. */
  async function responderConsulta(chatId, consulta) {
    const compras = await listarCompras();
    if (compras.length === 0) return false;

    const termino = consulta.termino ? normalizar(consulta.termino) : null;
    const coinciden = compras.filter(c => {
      if (!termino) return true;
      const campo = normalizar(consulta.tipo === 'acreedor' ? c.acreedor : c.alias);
      return termino.split(' ').every(t => campo.includes(t));
    });
    if (coinciden.length === 0) return false;

    const hoy = fechaHoySantiago();
    const total = coinciden.reduce((suma, c) => suma + resumenCompra(c, hoy).montoPendiente, 0);
    const lineas = coinciden.map(c => lineaCompra(c, hoy, '- '));

    if (consulta.tipo === 'acreedor') {
      const nombre = esc(coinciden[0].acreedor);
      await enviar(chatId, `<b>Le debes ${nombre}: ${dinero(total)}</b>\n\n${lineas.join('\n')}`);
    } else {
      await enviar(chatId, `${lineas.join('\n')}\n\nPendiente: ${dinero(total)}`);
    }
    return true;
  }

  /**
   * Mensaje de texto libre: pago de cuota, alta de compra en cuotas o consulta.
   * true si lo atendió (entonces no se registra como gasto).
   */
  async function intentarMensaje(msg) {
    const chatId = msg.chat.id;
    const texto = msg.text;

    try {
      if (parsearPagoCuota(texto)) return await iniciarPagoCuota(chatId, texto);
      if (detectarAltaCuotas(texto)) {
        await iniciarAlta(chatId, texto);
        return true;
      }
      const consulta = detectarConsultaCuotas(texto);
      if (consulta) return await responderConsulta(chatId, consulta);
    } catch (error) {
      errorBD('Error en cuotas', error);
      await enviar(chatId, 'Ocurrió un error al procesar las cuotas.');
      return true;
    }
    return false;
  }

  // -------------------------------------------------------------------------
  // Transferencias a terceros que parecen un pago de cuota (cartola)
  // -------------------------------------------------------------------------

  /**
   * Tras guardar una transferencia a terceros, si su texto calza con el alias de la cartola
   * de una compra en cuotas, pregunta (con botones) si es un pago de cuota y de cuál compra.
   * Nunca la asigna sola. `movimiento` = { id, descripcion }.
   */
  async function ofrecerPagoPorCartola(chatId, movimiento) {
    try {
      const calces = await buscarCuotasPorCartola(movimiento.descripcion);
      if (calces.length === 0) return;

      const lineas = calces.map(({ compra, resumen }) =>
        `- ${esc(compra.alias)} (${esc(compra.acreedor)}): siguiente cuota ${resumen.proximaCuota} de ${resumen.total}`
      );
      await enviar(chatId,
        `Esta transferencia se parece a un pago de cuota. ¿Es la cuota de alguna de estas compras?\n\n${lineas.join('\n')}`,
        {
          reply_markup: {
            inline_keyboard: [
              ...calces.map(({ compra, resumen }) => [{
                text: `${compra.alias} - cuota ${resumen.proximaCuota}/${resumen.total}`.slice(0, 50),
                callback_data: `cqv_${movimiento.id}_${compra.id}`
              }]),
              [{ text: 'No, es otro gasto', callback_data: 'cqn_x' }]
            ]
          }
        }
      );
    } catch (error) {
      errorBD('Error al buscar cuotas por cartola', error);
    }
  }

  // -------------------------------------------------------------------------
  // Botones y comandos
  // -------------------------------------------------------------------------

  /** Botones de este módulo. Devuelve true si el callback era suyo. */
  async function manejarCallback(cb, chatId, data) {
    if (!/^cq[a-z]_/.test(data)) return false;
    const messageId = cb.message.message_id;
    let m;

    try {
      // Alta
      if (data.startsWith('cqg_')) {
        const key = data.replace('cqg_', '');
        const pendiente = pendientesAlta.get(key);
        if (!pendiente) {
          await responderCallback(cb.id, { text: 'Solicitud expirada' });
          return true;
        }
        const r = await crearCompra(pendiente.datos);
        if (!r.ok) {
          await responderCallback(cb.id, { text: r.error });
          return true;
        }
        pendientesAlta.delete(key);
        esperando.delete(chatId);
        const hoy = fechaHoySantiago();
        const compra = await obtenerCompra(r.id);
        await editar(`Compra en cuotas guardada.\n\n${lineaCompra(compra, hoy)}`, { chat_id: chatId, message_id: messageId });
        await responderCallback(cb.id, { text: 'Guardada' });
        return true;
      }
      if (data.startsWith('cqx_')) {
        const key = data.replace('cqx_', '');
        pendientesAlta.delete(key);
        esperando.delete(chatId);
        await editar('Cancelado', { chat_id: chatId, message_id: messageId });
        await responderCallback(cb.id, { text: 'Cancelado' });
        return true;
      }

      // Pago de cuota
      if (data.startsWith('cqp_')) {
        await guardarPago(cb, chatId, data.replace('cqp_', ''));
        return true;
      }
      if (data.startsWith('cqc_')) {
        await descartarPago(data.replace('cqc_', ''));
        await editar('Cancelado', { chat_id: chatId, message_id: messageId });
        await responderCallback(cb.id, { text: 'Cancelado' });
        return true;
      }
      if ((m = data.match(/^cqs_(.+)_(\d+)$/))) {
        const compra = await obtenerCompra(m[2]);
        if (!compra || !pendientesPago.has(m[1])) {
          await responderCallback(cb.id, { text: 'Solicitud expirada' });
          return true;
        }
        await editar(`Compra elegida: ${esc(compra.alias)}`, { chat_id: chatId, message_id: messageId });
        await responderCallback(cb.id, {});
        await presentarPago(chatId, m[1], compra);
        return true;
      }

      // Foto sin caption: elegir la compra o solo guardarla
      if ((m = data.match(/^cqf_(.+)_(\d+)$/))) {
        const foto = fotosPendientes.get(m[1]);
        const compra = await obtenerCompra(m[2]);
        if (!foto || !compra) {
          await responderCallback(cb.id, { text: 'Solicitud expirada' });
          return true;
        }
        fotosPendientes.delete(m[1]);
        let archivo;
        try {
          archivo = await guardarRespaldo(foto.info.fileId, foto.info.nombre);
        } catch (error) {
          errorBD('Error al guardar el respaldo', error);
          await responderCallback(cb.id, { text: 'No pude guardar la foto' });
          return true;
        }
        const key = `${chatId}_${Date.now()}`;
        pendientesPago.set(key, {
          chatId, parsed: { numero: null, total: null, monto: null, palabras: [] },
          medioPago: null, fecha: fechaHoySantiago(), archivo, compraId: null
        });
        caducar(pendientesPago, key);
        await editar(`Comprobante de: ${esc(compra.alias)}`, { chat_id: chatId, message_id: messageId });
        await responderCallback(cb.id, {});
        await presentarPago(chatId, key, compra);
        return true;
      }
      if (data.startsWith('cqo_')) {
        const foto = fotosPendientes.get(data.replace('cqo_', ''));
        fotosPendientes.delete(data.replace('cqo_', ''));
        await editar('Entendido.', { chat_id: chatId, message_id: messageId });
        await responderCallback(cb.id, {});
        if (foto) await manejarFoto(foto.msg);
        return true;
      }

      // Transferencia que parece una cuota: ligar o descartar
      if ((m = data.match(/^cqv_(\d+)_(\d+)$/))) {
        const r = await vincularMovimientoACuota(m[1], m[2]);
        if (!r.ok) {
          await responderCallback(cb.id, { text: r.error });
          return true;
        }
        const restantes = r.compra.total_cuotas - r.compra.cuotas_pagadas;
        await editar(
          `Listo: es la cuota ${r.numero} de ${r.compra.total_cuotas} de <b>${esc(r.compra.alias)}</b>.` +
          (r.compra.terminada
            ? '\nCompra terminada: ya pagaste todas las cuotas.'
            : `\nQueda por pagar: ${dinero(restantes * r.compra.monto_cuota)} (${restantes} ${restantes === 1 ? 'cuota' : 'cuotas'}).`),
          { chat_id: chatId, message_id: messageId }
        );
        await responderCallback(cb.id, { text: 'Ligada' });
        return true;
      }
      if (data === 'cqn_x') {
        await editar('Entendido: queda como un gasto normal.', { chat_id: chatId, message_id: messageId });
        await responderCallback(cb.id, {});
        return true;
      }
    } catch (error) {
      errorBD('Error en un botón de cuotas', error);
      await responderCallback(cb.id, { text: 'Error' });
      return true;
    }

    return false;
  }

  function configurarComandos() {
    // /cuotas (lista), /cuotas nueva <datos>, /cuotas cartola <compra> <alias>
    bot.onText(/^\/cuotas(?:@\w+)?(?:\s+([\s\S]+))?$/i, async (msg, match) => {
      const chatId = msg.chat.id;
      if (!esChatAutorizado(chatId)) {
        await enviar(chatId, 'No estás autorizado para usar este bot.');
        return;
      }

      const argumento = (match[1] || '').trim();
      try {
        if (!argumento) {
          await enviarLista(chatId);
          return;
        }

        if (/^nueva\b/i.test(argumento)) {
          await iniciarAlta(chatId, argumento);
          return;
        }

        const cartola = /^cartola\s+(.+)\s+(\S+)$/i.exec(argumento);
        if (cartola) {
          const calzan = buscarCompras(await listarCompras(), normalizar(cartola[1]).split(/\s+/).filter(Boolean));
          if (calzan.length !== 1) {
            await enviar(chatId, 'No encontré una única compra con ese nombre. Usa /cuotas para ver la lista.');
            return;
          }
          await fijarAliasCartola(calzan[0].id, cartola[2]);
          await enviar(chatId,
            `Listo: las transferencias que digan "${esc(normalizar(cartola[2]))}" se preguntarán como posible pago de <b>${esc(calzan[0].alias)}</b>.`
          );
          return;
        }

        await enviar(chatId,
          '<b>Compras en cuotas</b>\n\n/cuotas - Ver las compras en curso\n' +
          '/cuotas nueva mac 12 cuotas de 85 mil tía, pagadas 6 - Crear una compra\n' +
          '/cuotas cartola mac valeska - Alias con que aparece en la cartola\n\n' +
          'Paga una cuota escribiendo: pagué cuota tía mac 7/12'
        );
      } catch (error) {
        errorBD('Error en /cuotas', error);
        await enviar(chatId, 'Ocurrió un error al procesar el comando.');
      }
    });
  }

  return { configurarComandos, manejarCallback, manejarTexto, intentarMensaje, manejarEnvio, ofrecerPagoPorCartola };
}
