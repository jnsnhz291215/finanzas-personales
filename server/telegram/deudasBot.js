/**
 * Deudas con abonos libres (lo que TÚ le debes a una persona y pagas en abonos de cualquier monto). Ver deudasLibres.js.
 *
 *   «le debo 300 mil a mi mamá»                                     crea la deuda
 *   «abono 20 mil a la deuda de mi mamá»                             abono
 *   «le transferí 50 mil a mi mamá de una cuota, son 50 de 300.000 que me quedan»
 *   (foto o PDF con esas frases como caption: el archivo queda de comprobante del movimiento y del abono)
 *   /deudas                                                          lo que te deben (préstamos) y, debajo, lo que debes con sus abonos
 *
 * Regla: la transferencia es el gasto (un movimiento normal, que registra el flujo de siempre con su confirmación Guardar) y el abono solo la
 * vincula a la deuda; nunca se crea un segundo movimiento, así que /plan y los gastos no cuentan doble.
 *
 * Botones (prefijo dl): dlc crear · dlo opción de deuda nueva · dlv ver abonos · dln renombrar · dla alias · dlx cerrar deuda (dly confirma) ·
 * dlb ligar a una transferencia ya registrada · dlr registrar una nueva · dlz cancelar. Toda lista lleva Cerrar.
 */

import {
  nombreDePersona, listarDeudas, obtenerDeuda, buscarDeudaDePersona, crearDeuda, registrarAbono, listarAbonos, renombrarDeuda, agregarAliasDeuda,
  cerrarDeuda, transferenciasSinAbonar
} from '../deudasLibres.js';
import { interpretarDeuda, opcionesDeudaNueva } from './deudasTexto.js';
import { formatearFechaCL, fechaHoySantiago } from './fechas.js';
import { describirError } from './errores.js';
import { botonCerrar, conCerrar } from './cerrar.js';

const ESPERA_MS = 10 * 60 * 1000;

export function crearDeudas(ctx) {
  const { bot, enviar, editar, responderCallback, esc, esChatAutorizado, formatearMonto, registrar, guardarArchivo } = ctx;
  const dinero = (n) => `$${formatearMonto(n)}`;

  // Operaciones que esperan una respuesta con botones: clave -> { chatId, msg, r, deudaId?, archivo, opciones?, hasta }
  const pendientes = new Map();
  // Texto esperado (renombrar o alias): chatId -> { accion, id, hasta }
  const esperando = new Map();
  let contador = 0;

  function guardarPendiente(datos) {
    const key = `${datos.chatId}_${Date.now()}_${contador++}`;
    pendientes.set(key, { ...datos, hasta: Date.now() + ESPERA_MS });
    setTimeout(() => pendientes.delete(key), ESPERA_MS).unref?.();
    return key;
  }

  const nombreDeuda = (d) => `${d.acreedor}${d.descripcion ? ` (${d.descripcion})` : ''}`;
  const lineaDeuda = (d) =>
    `<b>${esc(nombreDeuda(d))}</b> · total ${dinero(d.monto_total)} · abonado ${dinero(d.abonado)} · pendiente ${dinero(d.pendiente)}` +
    (d.ultimoAbono ? ` · último abono ${formatearFechaCL(d.ultimoAbono)}` : ' · sin abonos');

  // -------------------------------------------------------------------------
  // Registrar la transferencia (el gasto) con el abono ligado
  // -------------------------------------------------------------------------

  /**
   * Manda la transferencia al registro normal de movimientos (con su confirmación). Al guardarla, bot.js llama a vincularAbono. Con
   * `deuda` null la transferencia se registra sin ligarla a nada (la opción «solo pendientes»).
   */
  async function registrarTransferencia(chatId, msg, { persona, monto, deuda, archivo }) {
    await registrar(msg, {
      forzar: { monto, tipoMovimiento: 'transferencia_terceros', descripcion: `Transferencia a ${persona}${deuda ? ' (abono a deuda)' : ''}` },
      abonoDeuda: deuda ? { deudaId: deuda.id, monto, persona } : null,
      archivo
    });
  }

  /** bot.js lo llama al guardar el movimiento de una transferencia que lleva abono: liga el abono a la deuda */
  async function vincularAbono(chatId, tx, movimientoId) {
    try {
      const abono = tx.abonoDeuda;
      const r = await registrarAbono({ deudaId: abono.deudaId, movimientoId, monto: abono.monto, fecha: tx.fecha, archivo: tx.archivo_respaldo ?? null });
      if (!r.ok) {
        await enviar(chatId, `${esc(`No pude registrar el abono de ${abono.persona ?? 'la deuda'}: ${r.error}.`)}`, { reply_markup: { inline_keyboard: [botonCerrar()] } });
        return;
      }
      const deuda = await obtenerDeuda(abono.deudaId);
      await enviar(chatId,
        `<b>Abono registrado</b> a la deuda con ${esc(nombreDeuda(deuda))}: ${dinero(abono.monto)}.\n` +
        `Abonado ${dinero(deuda.abonado)} de ${dinero(deuda.monto_total)} · pendiente ${dinero(deuda.pendiente)}.\n` +
        'La transferencia es el gasto; el abono solo la vincula, así que no se cuenta dos veces.',
        { reply_markup: { inline_keyboard: [[{ text: 'Ver abonos', callback_data: `dlv_${deuda.id}` }], botonCerrar()] } }
      );
    } catch (error) {
      await enviar(chatId, describirError(error, 'guardar_bd', 'el abono de la deuda').usuario);
    }
  }

  // -------------------------------------------------------------------------
  // Interpretar lo escrito
  // -------------------------------------------------------------------------

  /** Un abono a una deuda que existe: si ya hay una transferencia igual sin abonar, se ofrece ligarla; si no, se registra una nueva */
  async function iniciarAbono(chatId, msg, r, deuda, archivo) {
    if (!r.esTransferencia) {
      const existentes = await transferenciasSinAbonar({ monto: r.monto, persona: r.persona, hoy: fechaHoySantiago() });
      if (existentes.length > 0) {
        const key = guardarPendiente({ chatId, msg, r, deudaId: deuda.id, archivo, existentes });
        await enviar(chatId,
          `Ya hay ${existentes.length === 1 ? 'una transferencia registrada' : 'transferencias registradas'} de ${dinero(r.monto)} sin abonar a ninguna deuda. ` +
          '¿La uso para este abono o registro una nueva?',
          {
            reply_markup: {
              inline_keyboard: [
                ...existentes.slice(0, 5).map(e => [{ text: `Usar la del ${formatearFechaCL(e.fecha)} · ${e.descripcion}`.slice(0, 60), callback_data: `dlb_${key}_${e.id}` }]),
                [{ text: 'Registrar una nueva', callback_data: `dlr_${key}` }],
                [{ text: 'Cancelar', callback_data: `dlz_${key}` }]
              ]
            }
          }
        );
        return;
      }
    }
    await registrarTransferencia(chatId, msg, { persona: deuda.acreedor, monto: r.monto, deuda, archivo });
  }

  async function procesarTexto(msg, texto, archivo = null) {
    const chatId = msg.chat.id;
    const r = interpretarDeuda(texto);
    if (!r) return false;

    if (r.tipo === 'crear') {
      const existente = await buscarDeudaDePersona(r.persona);
      if (existente) {
        await enviar(chatId,
          `Ya tienes una deuda con <b>${esc(existente.acreedor)}</b>: ${dinero(existente.monto_total)} en total, pendiente ${dinero(existente.pendiente)}. ` +
          'Abónale con «abono 20 mil a la deuda de ' + esc(existente.acreedor.toLowerCase()) + '».',
          { reply_markup: { inline_keyboard: [botonCerrar()] } }
        );
        return true;
      }
      const key = guardarPendiente({ chatId, msg, r, archivo });
      await enviar(chatId, `¿Creo la deuda con <b>${esc(r.persona)}</b> por <b>${dinero(r.total)}</b>?`, {
        reply_markup: { inline_keyboard: [[{ text: `Crear deuda con ${r.persona} por ${dinero(r.total)}`.slice(0, 60), callback_data: `dlc_${key}` }, { text: 'Cancelar', callback_data: `dlz_${key}` }]] }
      });
      return true;
    }

    // Abono
    const deuda = await buscarDeudaDePersona(r.persona);
    if (deuda) {
      await iniciarAbono(chatId, msg, r, deuda, archivo);
      return true;
    }
    const opciones = opcionesDeudaNueva(r);
    if (opciones.length === 0) {
      await enviar(chatId,
        `No tengo una deuda con <b>${esc(r.persona)}</b>. Créala con «le debo 300 mil a ${esc(r.persona.toLowerCase())}» y vuelve a mandar el abono.`,
        { reply_markup: { inline_keyboard: [botonCerrar()] } }
      );
      return true;
    }
    const key = guardarPendiente({ chatId, msg, r, archivo, opciones });
    const textoOpcion = (o) => (o.abonar
      ? `Crear deuda con ${r.persona} por ${dinero(o.total)} (${r.antes ? `${dinero(r.antes)} que quedaban` : `${dinero(r.despues)} pendientes + este abono`})`
      : `Solo ${dinero(o.total)} pendientes${r.despues ? ' después de este abono' : ''}`).slice(0, 64);
    await enviar(chatId,
      `No tengo una deuda con <b>${esc(r.persona)}</b>. Abonaste ${dinero(r.monto)}` +
      (r.antes ? ` y dices que quedaban ${dinero(r.antes)}.` : ` y dices que quedan ${dinero(r.despues)}, pero no sé si es antes o después de este abono.`) +
      ' ¿Cómo la creo?',
      {
        reply_markup: {
          inline_keyboard: [
            ...opciones.map(o => [{ text: textoOpcion(o), callback_data: `dlo_${key}_${o.id}` }]),
            [{ text: 'Cancelar', callback_data: `dlz_${key}` }]
          ]
        }
      }
    );
    return true;
  }

  /** Texto libre. true si lo atendió. */
  async function manejarTexto(msg) {
    const chatId = msg.chat.id;
    const t = String(msg.text ?? '').trim();
    if (!t || t.startsWith('/')) return false;
    try {
      const espera = esperando.get(chatId);
      if (espera) {
        esperando.delete(chatId);
        if (Date.now() <= espera.hasta) {
          const ok = espera.accion === 'alias' ? await agregarAliasDeuda(espera.id, t) : await renombrarDeuda(espera.id, t);
          await enviar(chatId,
            ok ? (espera.accion === 'alias' ? `Listo: también reconoceré «${esc(nombreDePersona(t))}» como esa persona.` : `Listo: la deuda ahora se llama <b>${esc(t)}</b>.`) : 'Esa deuda ya no existe.',
            { reply_markup: { inline_keyboard: [botonCerrar()] } }
          );
          return true;
        }
      }
      return await procesarTexto(msg, t);
    } catch (error) {
      await enviar(chatId, describirError(error, 'procesar', 'la deuda').usuario);
      return true;
    }
  }

  /** Foto o documento con un caption de deuda: el archivo queda de comprobante. true si lo atendió. */
  async function manejarEnvio(msg) {
    const caption = String(msg.caption ?? '').trim();
    if (!caption || !interpretarDeuda(caption)) return false;
    const chatId = msg.chat.id;
    const info = msg.photo
      ? { fileId: msg.photo[msg.photo.length - 1].file_id, nombre: 'comprobante.jpg' }
      : { fileId: msg.document.file_id, nombre: msg.document.file_name || 'comprobante.pdf' };
    let archivo;
    try {
      archivo = await guardarArchivo(info.fileId, info.nombre);
    } catch (error) {
      await enviar(chatId, `${describirError(error, 'guardar_archivo', info.nombre).usuario} No registré nada; reenvía el comprobante.`);
      return true;
    }
    try {
      return await procesarTexto({ ...msg, text: caption }, caption, archivo);
    } catch (error) {
      await enviar(chatId, describirError(error, 'procesar', 'la deuda').usuario);
      return true;
    }
  }

  // -------------------------------------------------------------------------
  // /deudas (la parte de lo que debes)
  // -------------------------------------------------------------------------

  /** Manda la lista de lo que debes. Devuelve true si había algo que mostrar (la parte de «te deben» la manda admin.js). */
  async function enviarDeudas(chatId) {
    const deudas = await listarDeudas();
    if (deudas.length === 0) return false;
    const total = deudas.reduce((s, d) => s + d.pendiente, 0);
    const filas = deudas.flatMap((d, i) => [
      [{ text: `Ver abonos ${i + 1}`, callback_data: `dlv_${d.id}` }, { text: `Renombrar ${i + 1}`, callback_data: `dln_${d.id}` }],
      [{ text: `Alias ${i + 1}`, callback_data: `dla_${d.id}` }, { text: `Cerrar deuda ${i + 1}`, callback_data: `dlx_${d.id}` }]
    ]);
    await enviar(chatId,
      '<b>Lo que debes (con abonos libres):</b>\n\n' + deudas.map((d, i) => `${i + 1}. ${lineaDeuda(d)}`).join('\n') +
      `\n\nTotal pendiente: ${dinero(total)}`,
      { reply_markup: { inline_keyboard: conCerrar(filas) } }
    );
    return true;
  }

  async function verAbonos(chatId, deudaId) {
    const deuda = await obtenerDeuda(deudaId);
    if (!deuda) {
      await enviar(chatId, 'Esa deuda ya no existe.');
      return;
    }
    const abonos = await listarAbonos(deudaId);
    await enviar(chatId,
      `<b>Abonos a ${esc(nombreDeuda(deuda))}</b>\nTotal ${dinero(deuda.monto_total)} · abonado ${dinero(deuda.abonado)} · pendiente ${dinero(deuda.pendiente)}\n\n` +
      (abonos.length === 0
        ? 'Todavía no hay abonos.'
        : abonos.map(a => `${formatearFechaCL(a.fecha)} · ${dinero(a.monto)}${a.conArchivo ? ' · con comprobante' : ''}${a.movimiento_id ? '' : ' · sin transferencia ligada'}`).join('\n')),
      { reply_markup: { inline_keyboard: [botonCerrar()] } }
    );
  }

  // -------------------------------------------------------------------------
  // Botones
  // -------------------------------------------------------------------------

  async function manejarCallback(cb, chatId, data) {
    const m = /^dl([cobvnaxybrz])_(.+)$/.exec(data);
    if (!m) return false;
    if (!esChatAutorizado(chatId)) {
      await responderCallback(cb.id, { text: 'No autorizado' });
      return true;
    }
    const messageId = cb.message.message_id;
    const [, tipo, valor] = m;

    try {
      if (tipo === 'z') {
        pendientes.delete(valor);
        await responderCallback(cb.id, { text: 'Cancelado' });
        await editar('Cancelado.', { chat_id: chatId, message_id: messageId });
        return true;
      }

      if (tipo === 'v') {
        await responderCallback(cb.id, {});
        await verAbonos(chatId, Number(valor));
        return true;
      }
      if (tipo === 'n' || tipo === 'a') {
        const deuda = await obtenerDeuda(Number(valor));
        if (!deuda) {
          await responderCallback(cb.id, { text: 'Esa deuda ya no existe' });
          return true;
        }
        await responderCallback(cb.id, {});
        esperando.set(chatId, { accion: tipo === 'a' ? 'alias' : 'renombrar', id: deuda.id, hasta: Date.now() + ESPERA_MS });
        await enviar(chatId,
          tipo === 'a'
            ? `Escribe otro nombre con que le dices a <b>${esc(deuda.acreedor)}</b> (por ejemplo «Mamá Rosa»).`
            : `Escribe el nombre nuevo de la deuda con <b>${esc(deuda.acreedor)}</b> (por ejemplo «Préstamo del auto»).`,
          { reply_markup: { inline_keyboard: [[{ text: 'Cancelar', callback_data: 'dlz_x' }]] } }
        );
        return true;
      }
      if (tipo === 'x') {
        const deuda = await obtenerDeuda(Number(valor));
        if (!deuda) {
          await responderCallback(cb.id, { text: 'Esa deuda ya no existe' });
          return true;
        }
        await responderCallback(cb.id, {});
        await enviar(chatId,
          `¿Cerrar la deuda con <b>${esc(nombreDeuda(deuda))}</b>? Pendiente ${dinero(deuda.pendiente)}. Deja de aparecer en /deudas; los abonos se conservan.`,
          { reply_markup: { inline_keyboard: [[{ text: 'Sí, cerrar', callback_data: `dly_${deuda.id}` }, { text: 'Cancelar', callback_data: 'dlz_x' }]] } }
        );
        return true;
      }
      if (tipo === 'y') {
        const ok = await cerrarDeuda(Number(valor));
        await responderCallback(cb.id, {});
        await editar(ok ? 'Deuda cerrada. Los abonos se conservan.' : 'Esa deuda ya estaba cerrada.', { chat_id: chatId, message_id: messageId });
        return true;
      }

      // Las que siguen usan una operación pendiente
      const partes = /^(.+?)_([a-z0-9]+)$/.exec(valor);
      const key = tipo === 'c' || tipo === 'r' ? valor : partes?.[1];
      const pendiente = key ? pendientes.get(key) : null;
      if (!pendiente || pendiente.chatId !== chatId || Date.now() > pendiente.hasta) {
        await responderCallback(cb.id, { text: 'Este botón ya expiró' });
        return true;
      }
      pendientes.delete(key);
      await responderCallback(cb.id, {});
      const { msg, r, archivo } = pendiente;

      // Crear la deuda (frase «le debo ...»)
      if (tipo === 'c') {
        const creada = await crearDeuda({ acreedor: r.persona, montoTotal: r.total, fecha: fechaHoySantiago() });
        await editar(
          creada.ok ? `Listo: creé la deuda con <b>${esc(creada.acreedor)}</b> por ${dinero(r.total)}. Mírala en /deudas.` : esc(creada.error),
          { chat_id: chatId, message_id: messageId, reply_markup: { inline_keyboard: [botonCerrar()] } }
        );
        return true;
      }

      // Deuda nueva a partir de un abono: opción a (con abono) o b (solo pendientes)
      if (tipo === 'o') {
        const opcion = pendiente.opciones.find(o => o.id === partes?.[2]);
        if (!opcion) return true;
        const creada = await crearDeuda({ acreedor: r.persona, montoTotal: opcion.total, fecha: fechaHoySantiago() });
        if (!creada.ok) {
          await editar(esc(creada.error), { chat_id: chatId, message_id: messageId });
          return true;
        }
        await editar(
          `Listo: creé la deuda con <b>${esc(creada.acreedor)}</b> por ${dinero(opcion.total)}` +
          (opcion.abonar ? `; con este abono quedan ${dinero(opcion.pendiente)} pendientes.` : ` (pendientes ${dinero(opcion.pendiente)}; este abono no se descuenta de ella).`) +
          ' Ahora registro la transferencia.',
          { chat_id: chatId, message_id: messageId, reply_markup: { inline_keyboard: [botonCerrar()] } }
        );
        const deuda = opcion.abonar ? await obtenerDeuda(creada.id) : null;
        await registrarTransferencia(chatId, msg, { persona: creada.acreedor, monto: r.monto, deuda, archivo });
        return true;
      }

      // Registrar una transferencia nueva para este abono
      if (tipo === 'r') {
        const deuda = await obtenerDeuda(pendiente.deudaId);
        await editar('Registro una transferencia nueva.', { chat_id: chatId, message_id: messageId });
        if (deuda) await registrarTransferencia(chatId, msg, { persona: deuda.acreedor, monto: r.monto, deuda, archivo });
        return true;
      }

      // Usar una transferencia que ya estaba registrada
      if (tipo === 'b') {
        const existente = pendiente.existentes.find(e => e.id === Number(partes?.[2]));
        if (!existente) return true;
        const ab = await registrarAbono({ deudaId: pendiente.deudaId, movimientoId: existente.id, monto: existente.monto, fecha: existente.fecha, archivo });
        const deuda = await obtenerDeuda(pendiente.deudaId);
        await editar(
          ab.ok
            ? `Listo: vinculé la transferencia del ${formatearFechaCL(existente.fecha)} como abono de ${dinero(existente.monto)} a la deuda con <b>${esc(deuda.acreedor)}</b>. Pendiente ${dinero(deuda.pendiente)}.`
            : esc(describirError(new Error(ab.error), 'vincular', 'el abono', { registrar: false }).plano),
          { chat_id: chatId, message_id: messageId, reply_markup: { inline_keyboard: [botonCerrar()] } }
        );
        return true;
      }
    } catch (error) {
      await responderCallback(cb.id, { text: describirError(error, 'procesar', 'la deuda').toast });
    }
    return true;
  }

  /** Cierra lo que este módulo espera del chat (un nombre, un alias, una elección con botones). Devuelve cuántas cosas cerró. */
  function cancelarFlujo(chatId) {
    let n = esperando.delete(chatId) ? 1 : 0;
    for (const [key, p] of [...pendientes.entries()]) if (p.chatId === chatId && pendientes.delete(key)) n++;
    return n;
  }

  return { cancelarFlujo, manejarTexto, manejarEnvio, manejarCallback, enviarDeudas, vincularAbono };
}
