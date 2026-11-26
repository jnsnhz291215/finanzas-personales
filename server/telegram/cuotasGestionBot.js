/**
 * Renombrar y agrupar compras en cuotas (/renombrarcuota, /agruparcuotas y frases). Las frases se entienden en cuotasGestion.js.
 *
 * - Renombrar cambia solo el nombre con que se MUESTRA (nombre_mostrar). El nombre real (alias, alias_cartola) sigue empareando con las cartolas.
 * - Agrupar es solo visual y de totales: no cambia pagos ni el emparejamiento con cartolas (las transferencias siguen cubriendo cuotas igual).
 *
 * Botones (prefijo cg): cgn_<compra> Renombrar (desde /cuotas) · cgr_<clave>_<compra> elegir cuál renombrar · cgd_<grupo> Desagrupar ·
 * cgx_x cancelar. Toda lista lleva Cerrar.
 */

import {
  listarCompras, renombrarCompra, listarGrupos, crearGrupo, asignarGrupo, desagruparGrupo, limpiarGruposVacios, obtenerCompra
} from '../cuotas.js';
import { parsearRenombrar, parsearAgrupar, parsearCuotasPagadas, buscarPorReferencia, parsearReferencia } from './cuotasGestion.js';
import { fijarContador, textoContador } from './contadorCuotas.js';
import { nombreConReal, nombreDeCompra, normalizar } from './cuotas.js';
import { describirError } from './errores.js';
import { botonCerrar, conCerrar } from './cerrar.js';

const ESPERA_MS = 10 * 60 * 1000;

export function crearCuotasGestion(ctx) {
  const { bot, enviar, editar, responderCallback, esc, esChatAutorizado, formatearMonto } = ctx;
  const dinero = (n) => `$${formatearMonto(n)}`;

  // Renombres que esperan que se elija la compra: clave -> { chatId, nuevo, hasta }
  const pendientes = new Map();
  // Nombre nuevo que se espera escrito (botón Renombrar de /cuotas): chatId -> { compraId, hasta }
  const esperandoNombre = new Map();
  let contador = 0;

  /** "Apple ($21.749) · Valeska · 7/12" para elegir entre compras */
  const etiqueta = (c) => `${nombreConReal(c)} (${dinero(c.monto_cuota)}) · ${c.acreedor} · ${c.cuotas_pagadas}/${c.total_cuotas}`.slice(0, 60);
  const texto = (c) => `${esc(nombreConReal(c))} (${dinero(c.monto_cuota)}, ${esc(c.acreedor)}, ${c.cuotas_pagadas}/${c.total_cuotas})`;

  async function aplicarRenombre(chatId, compra, nuevo) {
    await renombrarCompra(compra.id, nuevo);
    const actual = await obtenerCompra(compra.id);
    await enviar(chatId,
      `Listo: la compra ahora se muestra como <b>${esc(nombreDeCompra(actual))}</b>.\n` +
      `Su nombre real (<b>${esc(actual.alias)}</b>) no cambió: sigue emparejando con las cartolas.`,
      { reply_markup: { inline_keyboard: [botonCerrar()] } }
    );
  }

  // -------------------------------------------------------------------------
  // Renombrar
  // -------------------------------------------------------------------------

  /** true si atendió el mensaje */
  async function renombrarPorOrden(chatId, orden) {
    const compras = await listarCompras({ incluirTerminadas: true });
    const candidatas = buscarPorReferencia(compras, orden.ref);
    // La frase corta ("la de apple de 202 mil es el Mac") solo cuenta si de verdad hay una compra así; si no, no es de cuotas
    if (candidatas.length === 0) {
      if (!orden.esComando && !/^\s*renombr/i.test(orden.textoOriginal ?? '')) return false;
      await enviar(chatId,
        `No encontré una compra en cuotas que calce con «${esc(orden.ref.nombre)}»${orden.ref.monto ? ` de ${dinero(orden.ref.monto)}` : ''}. Revisa /cuotas.`,
        { reply_markup: { inline_keyboard: [botonCerrar()] } }
      );
      return true;
    }
    if (candidatas.length === 1) {
      await aplicarRenombre(chatId, candidatas[0], orden.nuevo);
      return true;
    }
    // Ambiguo: se elige con botones (con el valor de la cuota)
    const key = `${chatId}_${Date.now()}_${contador++}`;
    pendientes.set(key, { chatId, nuevo: orden.nuevo, hasta: Date.now() + ESPERA_MS });
    setTimeout(() => pendientes.delete(key), ESPERA_MS).unref?.();
    await enviar(chatId, `Hay ${candidatas.length} compras que calzan. ¿Cuál renombro a <b>${esc(orden.nuevo)}</b>?`, {
      reply_markup: {
        inline_keyboard: [
          ...candidatas.slice(0, 20).map(c => [{ text: etiqueta(c), callback_data: `cgr_${key}_${c.id}` }]),
          [{ text: 'Cancelar', callback_data: 'cgx_x' }],
          botonCerrar()
        ]
      }
    });
    return true;
  }

  // -------------------------------------------------------------------------
  // Cuántas cuotas van pagadas (a mano, fuera de las cartolas)
  // -------------------------------------------------------------------------

  async function aplicarContador(chatId, compra, n) {
    const total = Number(compra.total_cuotas);
    if (!Number.isInteger(n) || n < 0 || n > total) {
      await enviar(chatId, `${esc(nombreDeCompra(compra))} tiene ${total} cuotas: el número de pagadas debe estar entre 0 y ${total}.`, { reply_markup: { inline_keyboard: [botonCerrar()] } });
      return;
    }
    const r = await fijarContador(compra, n);
    await enviar(chatId, textoContador(r, nombreConReal(r.compra), dinero, esc), { reply_markup: { inline_keyboard: [botonCerrar()] } });
  }

  /** true si atendió el mensaje */
  async function cuotasPagadasPorOrden(chatId, orden) {
    const compras = await listarCompras({ incluirTerminadas: true });
    const candidatas = buscarPorReferencia(compras, orden.ref);
    if (candidatas.length === 0) {
      if (!orden.esComando) return false;
      await enviar(chatId, `No encontré una compra en cuotas que calce con «${esc(orden.ref.nombre)}»${orden.ref.monto ? ` de ${dinero(orden.ref.monto)}` : ''}. Revisa /cuotas.`, { reply_markup: { inline_keyboard: [botonCerrar()] } });
      return true;
    }
    if (candidatas.length === 1) {
      await aplicarContador(chatId, candidatas[0], orden.n);
      return true;
    }
    const key = `${chatId}_${Date.now()}_${contador++}`;
    pendientes.set(key, { chatId, n: orden.n, hasta: Date.now() + ESPERA_MS });
    setTimeout(() => pendientes.delete(key), ESPERA_MS).unref?.();
    await enviar(chatId, `Hay ${candidatas.length} compras que calzan. ¿A cuál le pongo ${orden.n} cuotas pagadas?`, {
      reply_markup: {
        inline_keyboard: [
          ...candidatas.slice(0, 20).map(c => [{ text: etiqueta(c), callback_data: `cgp_${key}_${c.id}` }]),
          [{ text: 'Cancelar', callback_data: 'cgx_x' }],
          botonCerrar()
        ]
      }
    });
    return true;
  }

  // -------------------------------------------------------------------------
  // Agrupar
  // -------------------------------------------------------------------------

  /** Una referencia debe calzar con una sola compra; si no, explica cuál es el problema */
  function resolverUna(compras, ref) {
    const calzan = buscarPorReferencia(compras, ref);
    if (calzan.length === 1) return { compra: calzan[0] };
    if (calzan.length === 0) return { error: `No encontré una compra que calce con «${esc(ref.nombre)}»${ref.monto ? ` de ${dinero(ref.monto)}` : ''}.` };
    return { error: `«${esc(ref.nombre)}» calza con varias compras; di también el valor de la cuota:\n${calzan.map(c => `- ${texto(c)}`).join('\n')}` };
  }

  async function responderAgrupado(chatId, grupoId, nombre, compras) {
    await enviar(chatId,
      `Listo: agrupé ${compras.map(c => `<b>${esc(nombreDeCompra(c))}</b>`).join(' y ')} en el grupo <b>${esc(nombre)}</b>.\n` +
      'Es solo visual y de totales: las transferencias y las cartolas siguen cubriendo cada cuota igual que antes. Míralo en /cuotas.',
      { reply_markup: { inline_keyboard: [[{ text: 'Desagrupar', callback_data: `cgd_${grupoId}` }], botonCerrar()] } }
    );
  }

  async function agruparPorOrden(chatId, orden, esComando) {
    const compras = await listarCompras({ incluirTerminadas: true });

    if (orden.tipo === 'desagrupar') {
      const grupos = await listarGrupos();
      const buscado = normalizar(orden.nombre).trim();
      const grupo = grupos.find(g => normalizar(g.nombre).trim() === buscado);
      if (!grupo) {
        if (!esComando) return false;
        await enviar(chatId, `No encontré un grupo llamado «${esc(orden.nombre)}».`, { reply_markup: { inline_keyboard: [botonCerrar()] } });
        return true;
      }
      await desagruparGrupo(grupo.id);
      await enviar(chatId, `Listo: deshice el grupo <b>${esc(grupo.nombre)}</b>. Sus compras quedaron sueltas.`, { reply_markup: { inline_keyboard: [botonCerrar()] } });
      return true;
    }

    if (orden.tipo === 'agrupar') {
      const resueltas = orden.refs.map(r => resolverUna(compras, r));
      const error = resueltas.find(r => r.error);
      if (error) {
        await enviar(chatId, error.error, { reply_markup: { inline_keyboard: [botonCerrar()] } });
        return true;
      }
      const elegidas = [...new Map(resueltas.map(r => [r.compra.id, r.compra])).values()];
      if (elegidas.length < 2) {
        await enviar(chatId, 'Dijiste la misma compra dos veces; para juntarlas necesito dos compras distintas.', { reply_markup: { inline_keyboard: [botonCerrar()] } });
        return true;
      }
      if (new Set(elegidas.map(c => normalizar(c.acreedor).trim())).size > 1) {
        await enviar(chatId, 'Esas compras son de titulares distintos; solo puedo juntar compras del mismo titular.', { reply_markup: { inline_keyboard: [botonCerrar()] } });
        return true;
      }
      const grupo = await crearGrupo(orden.grupo, elegidas[0].acreedor);
      if (!grupo.ok) {
        await enviar(chatId, esc(grupo.error));
        return true;
      }
      await asignarGrupo(elegidas.map(c => c.id), grupo.id);
      await responderAgrupado(chatId, grupo.id, orden.grupo, elegidas);
      return true;
    }

    // "el AppleCare es parte del Mac": el grupo puede existir o ser otra compra
    const resuelta = resolverUna(compras, orden.ref);
    if (resuelta.error) {
      if (!esComando && buscarPorReferencia(compras, orden.ref).length === 0) return false;
      await enviar(chatId, resuelta.error, { reply_markup: { inline_keyboard: [botonCerrar()] } });
      return true;
    }
    const compra = resuelta.compra;
    const grupos = await listarGrupos();
    const buscado = normalizar(orden.grupo).trim();
    const existente = grupos.find(g => normalizar(g.nombre).trim() === buscado && normalizar(g.acreedor).trim() === normalizar(compra.acreedor).trim());
    if (existente) {
      await asignarGrupo([compra.id], existente.id);
      await responderAgrupado(chatId, existente.id, existente.nombre, [compra]);
      return true;
    }
    const otras = buscarPorReferencia(compras, parsearReferencia(orden.grupo)).filter(c => c.id !== compra.id && normalizar(c.acreedor).trim() === normalizar(compra.acreedor).trim());
    if (otras.length !== 1) {
      if (!esComando && otras.length === 0) return false;
      await enviar(chatId,
        otras.length === 0
          ? `No encontré un grupo ni una compra llamada «${esc(orden.grupo)}» del mismo titular.`
          : `«${esc(orden.grupo)}» calza con varias compras; di también el valor de la cuota:\n${otras.map(c => `- ${texto(c)}`).join('\n')}`,
        { reply_markup: { inline_keyboard: [botonCerrar()] } }
      );
      return true;
    }
    const grupo = await crearGrupo(orden.grupo, compra.acreedor);
    await asignarGrupo([compra.id, otras[0].id], grupo.id);
    await responderAgrupado(chatId, grupo.id, orden.grupo, [otras[0], compra]);
    return true;
  }

  async function listarGruposMensaje(chatId) {
    const grupos = await listarGrupos();
    const ayuda =
      '<b>Agrupar compras en cuotas</b>\n' +
      'Es solo visual y de totales (no cambia pagos ni cartolas). Ejemplos:\n' +
      '/agruparcuotas Apple 202.332 y Apple 21.749 como Mac\n' +
      '«el AppleCare es parte del Mac»\n' +
      '/agruparcuotas desagrupar Mac';
    if (grupos.length === 0) {
      await enviar(chatId, `${ayuda}\n\nTodavía no tienes grupos.`, { reply_markup: { inline_keyboard: [botonCerrar()] } });
      return;
    }
    await enviar(chatId, `${ayuda}\n\n<b>Tus grupos</b>`, {
      reply_markup: { inline_keyboard: conCerrar(grupos.map(g => [{ text: `Desagrupar ${g.nombre} (${g.acreedor})`.slice(0, 48), callback_data: `cgd_${g.id}` }])) }
    });
  }

  // -------------------------------------------------------------------------
  // Texto y comandos
  // -------------------------------------------------------------------------

  /** Mensaje de texto libre. true si lo atendió. */
  async function manejarTexto(msg) {
    const chatId = msg.chat.id;
    const t = String(msg.text ?? '').trim();
    if (!t || t.startsWith('/')) return false;

    try {
      // El nombre nuevo que se esperaba (botón Renombrar de /cuotas)
      const espera = esperandoNombre.get(chatId);
      if (espera) {
        esperandoNombre.delete(chatId);
        if (Date.now() <= espera.hasta) {
          const compra = await obtenerCompra(espera.compraId);
          if (compra) {
            if (/^(?:quitar|ninguno|borrar)$/i.test(t)) {
              await renombrarCompra(compra.id, '');
              await enviar(chatId, `Listo: la compra vuelve a mostrarse como <b>${esc(compra.alias)}</b>.`, { reply_markup: { inline_keyboard: [botonCerrar()] } });
            } else {
              await aplicarRenombre(chatId, compra, t);
            }
            return true;
          }
        }
      }

      const pagadas = parsearCuotasPagadas(t);
      if (pagadas && await cuotasPagadasPorOrden(chatId, pagadas)) return true;

      const renombre = parsearRenombrar(t);
      if (renombre && await renombrarPorOrden(chatId, { ...renombre, textoOriginal: t })) return true;

      const agrupar = parsearAgrupar(t);
      if (agrupar && await agruparPorOrden(chatId, agrupar, false)) return true;
    } catch (error) {
      await enviar(chatId, describirError(error, 'actualizar', 'las compras en cuotas').usuario);
      return true;
    }
    return false;
  }

  function configurarComandos() {
    bot.onText(/^\/(?:renombrarcuota|renombrar)(?:@\w+)?(?:\s+([\s\S]+))?$/i, async (msg, match) => {
      const chatId = msg.chat.id;
      if (!esChatAutorizado(chatId)) return enviar(chatId, 'No estás autorizado para usar este bot.');
      try {
        const orden = match[1] ? parsearRenombrar(msg.text) : null;
        if (!orden) {
          await enviar(chatId,
            '<b>Renombrar una compra en cuotas</b>\n' +
            'Cambia solo el nombre con que se muestra; el nombre real sigue emparejando con las cartolas.\n\n' +
            '/renombrarcuota Apple 21.749 a AppleCare\n' +
            '«renombra la cuota Apple de 21.749 a AppleCare»\n' +
            '«la de apple de 202 mil es el Mac»\n\n' +
            'También hay un botón Renombrar en /cuotas.',
            { reply_markup: { inline_keyboard: [botonCerrar()] } }
          );
          return;
        }
        await renombrarPorOrden(chatId, { ...orden, esComando: true });
      } catch (error) {
        await enviar(chatId, describirError(error, 'actualizar', 'la compra en cuotas').usuario);
      }
    });

    bot.onText(/^\/cuotaspagadas(?:@\w+)?(?:\s+([\s\S]+))?$/i, async (msg, match) => {
      const chatId = msg.chat.id;
      if (!esChatAutorizado(chatId)) return enviar(chatId, 'No estás autorizado para usar este bot.');
      try {
        const orden = match[1] ? parsearCuotasPagadas(msg.text) : null;
        if (!orden) {
          await enviar(chatId,
            '<b>Fijar cuántas cuotas van pagadas</b>\n' +
            'Corrige el contador de una compra a mano (por ejemplo si la app va adelantada o atrasada).\n\n' +
            '/cuotaspagadas Mac 6\n«del Mac van 6 pagadas»\n«la última cuota pagada del Mac es la 6»\n\n' +
            'Si hay varias compras con el mismo nombre, di también el valor de la cuota: /cuotaspagadas Apple 21.749 6',
            { reply_markup: { inline_keyboard: [botonCerrar()] } }
          );
          return;
        }
        await cuotasPagadasPorOrden(chatId, { ...orden, esComando: true });
      } catch (error) {
        await enviar(chatId, describirError(error, 'actualizar', 'el contador de cuotas').usuario);
      }
    });

    bot.onText(/^\/agruparcuotas(?:@\w+)?(?:\s+([\s\S]+))?$/i, async (msg, match) => {
      const chatId = msg.chat.id;
      if (!esChatAutorizado(chatId)) return enviar(chatId, 'No estás autorizado para usar este bot.');
      try {
        const orden = match[1] ? parsearAgrupar(msg.text) : null;
        if (!orden) return await listarGruposMensaje(chatId);
        await agruparPorOrden(chatId, orden, true);
      } catch (error) {
        await enviar(chatId, describirError(error, 'actualizar', 'el grupo de compras').usuario);
      }
    });
  }

  // -------------------------------------------------------------------------
  // Botones
  // -------------------------------------------------------------------------

  async function manejarCallback(cb, chatId, data) {
    const m = /^cg([nrdxp])_(.+)$/.exec(data);
    if (!m) return false;
    if (!esChatAutorizado(chatId)) {
      await responderCallback(cb.id, { text: 'No autorizado' });
      return true;
    }
    const messageId = cb.message.message_id;
    try {
      if (m[1] === 'x') {
        await responderCallback(cb.id, {});
        await editar('Cancelado.', { chat_id: chatId, message_id: messageId });
        return true;
      }

      // Botón Renombrar de /cuotas: se pide el nombre nuevo
      if (m[1] === 'n') {
        const compra = await obtenerCompra(Number(m[2]));
        if (!compra) {
          await responderCallback(cb.id, { text: 'Esa compra ya no existe' });
          return true;
        }
        await responderCallback(cb.id, {});
        esperandoNombre.set(chatId, { compraId: compra.id, hasta: Date.now() + ESPERA_MS });
        await enviar(chatId,
          `Escribe el nombre nuevo para <b>${esc(nombreConReal(compra))}</b> (${dinero(compra.monto_cuota)}). Escribe «quitar» para volver al nombre real.`,
          { reply_markup: { inline_keyboard: [[{ text: 'Cancelar', callback_data: 'cgx_x' }]] } }
        );
        return true;
      }

      // Elegir cuál de varias compras renombrar
      if (m[1] === 'r') {
        const partes = /^(.+)_(\d+)$/.exec(m[2]);
        const pendiente = partes ? pendientes.get(partes[1]) : null;
        const compra = partes ? await obtenerCompra(Number(partes[2])) : null;
        if (!pendiente || !compra) {
          await responderCallback(cb.id, { text: 'Este botón ya expiró' });
          return true;
        }
        pendientes.delete(partes[1]);
        await responderCallback(cb.id, {});
        await editar(`Compra elegida: ${texto(compra)}`, { chat_id: chatId, message_id: messageId });
        await aplicarRenombre(chatId, compra, pendiente.nuevo);
        return true;
      }

      // Elegir a cuál de varias compras fijarle las cuotas pagadas
      if (m[1] === 'p') {
        const partes = /^(.+)_(\d+)$/.exec(m[2]);
        const pendiente = partes ? pendientes.get(partes[1]) : null;
        const compra = partes ? await obtenerCompra(Number(partes[2])) : null;
        if (!pendiente || !compra) {
          await responderCallback(cb.id, { text: 'Este botón ya expiró' });
          return true;
        }
        pendientes.delete(partes[1]);
        await responderCallback(cb.id, {});
        await editar(`Compra elegida: ${texto(compra)}`, { chat_id: chatId, message_id: messageId });
        await aplicarContador(chatId, compra, pendiente.n);
        return true;
      }

      // Desagrupar
      const grupo = (await listarGrupos()).find(g => g.id === Number(m[2]));
      await responderCallback(cb.id, {});
      if (!grupo) {
        await editar('Ese grupo ya no existe.', { chat_id: chatId, message_id: messageId });
        return true;
      }
      await desagruparGrupo(grupo.id);
      await editar(`Listo: deshice el grupo <b>${esc(grupo.nombre)}</b>. Sus compras quedaron sueltas.`, { chat_id: chatId, message_id: messageId });
      return true;
    } catch (error) {
      await responderCallback(cb.id, { text: describirError(error, 'actualizar', 'las compras en cuotas').toast });
      return true;
    }
  }

  /** Cierra lo que este módulo espera del chat (un nombre, una elección). Devuelve cuántas cosas cerró. */
  function cancelarFlujo(chatId) {
    let n = esperandoNombre.delete(chatId) ? 1 : 0;
    for (const [key, p] of [...pendientes.entries()]) if (p.chatId === chatId && pendientes.delete(key)) n++;
    return n;
  }

  return { cancelarFlujo, configurarComandos, manejarTexto, manejarCallback, limpiarGruposVacios };
}
