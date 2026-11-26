/**
 * /resetcuenta (alias /limpiarcuenta): borrar las importaciones de cartolas de una cuenta, o todo lo suyo, con un período opcional.
 *
 * Flujo: cuenta (por dígitos o con botones) -> año, si el mes existe en varios -> resumen de lo que se borraría y dos opciones ->
 * segunda confirmación ("Sí, borrar") -> respaldo JSON + borrado en una transacción -> botón Deshacer por 10 minutos.
 * La cuenta, las compras en cuotas y los PDF originales no se tocan.
 *
 * Botones (prefijo rc): rcc_<sesión>_<cuenta> · rcy_<sesión>_<año> · rcm_<sesión>_<i|t> · rcb_<sesión> · rcx_<sesión> · rcz_<sesión>.
 */

import {
  interpretarResetCuenta,
  rangoDePeriodo,
  etiquetaPeriodo,
  seleccionar,
  guardarRespaldoJSON,
  borrarSeleccion,
  deshacerDesdeRespaldo
} from '../resetCuenta.js';
import { mesesDeCuenta, cuentasQueCalzan } from '../estadoCuenta.js';
import { fechaHoySantiago } from './fechas.js';

const VIDA_SESION_MS = 15 * 60 * 1000;
const VIDA_DESHACER_MS = 10 * 60 * 1000;

export function crearResetCuenta(ctx) {
  const { bot, enviar, editar, responderCallback, esc, esChatAutorizado } = ctx;

  // sesión -> { chatId, cuenta, periodo, anio, modo, respaldo, hasta }
  const sesiones = new Map();
  let contador = 0;

  function nuevaSesion(chatId, datos) {
    const id = ++contador;
    sesiones.set(id, { chatId, ...datos, hasta: Date.now() + VIDA_SESION_MS });
    setTimeout(() => sesiones.delete(id), VIDA_SESION_MS + VIDA_DESHACER_MS).unref?.();
    return id;
  }

  const vigente = (id, chatId) => {
    const s = sesiones.get(id);
    return s && s.chatId === chatId ? s : null;
  };

  async function mostrar(chatId, messageId, texto, teclado = []) {
    const opciones = { reply_markup: { inline_keyboard: teclado } };
    if (messageId) {
      const editado = await editar(texto, { chat_id: chatId, message_id: messageId, ...opciones });
      if (editado) return;
    }
    await enviar(chatId, texto, opciones);
  }

  async function cuentasActivas() {
    const { query } = await import('../db.js');
    const [filas] = await query('SELECT id, nombre, banco, tipo, titular, ultimos4, ultimos4_cuenta FROM cuentas WHERE activa = 1 ORDER BY nombre');
    return filas.map(c => ({ ...c, id: Number(c.id) }));
  }

  const etiquetaCuenta = (c) => [c.nombre, c.ultimos4 || c.ultimos4_cuenta ? `****${c.ultimos4 || c.ultimos4_cuenta}` : null].filter(Boolean).join(' ').slice(0, 56);

  // -------------------------------------------------------------------------
  // Pasos
  // -------------------------------------------------------------------------

  async function pasoCuenta(chatId, interpretacion, aviso = null, cuentas = null) {
    const todas = await cuentasActivas();
    const lista = cuentas ?? todas;
    if (lista.length === 0) return enviar(chatId, 'No tienes cuentas activas.');
    const sesion = nuevaSesion(chatId, { periodo: interpretacion?.periodo ?? null, anio: interpretacion?.periodo?.anio ?? null });
    await enviar(chatId,
      `${aviso ? `${aviso}\n\n` : ''}<b>Borrar datos de una cuenta</b>\n¿De cuál?`,
      {
        reply_markup: {
          inline_keyboard: [
            ...lista.map(c => [{ text: etiquetaCuenta(c), callback_data: `rcc_${sesion}_${c.id}` }]),
            [{ text: 'Cancelar', callback_data: `rcx_${sesion}` }]
          ]
        }
      }
    );
  }

  /** Con la cuenta elegida: si el mes existe en varios años se pregunta el año; si no, va al resumen */
  async function pasoAnio(chatId, messageId, sesionId) {
    const s = sesiones.get(sesionId);
    if (s.periodo && !s.anio) {
      const meses = await mesesDeCuenta(s.cuenta.id);
      const anios = new Set();
      for (const mes of meses.keys()) {
        const n = Number(mes.slice(5, 7));
        if (n >= s.periodo.mesDesde && n <= s.periodo.mesHasta) anios.add(mes.slice(0, 4));
      }
      if (anios.size > 1) {
        await mostrar(chatId, messageId,
          `${esc(s.cuenta.nombre)} tiene registros de ese período en más de un año. ¿De cuál?`,
          [
            ...[...anios].sort().reverse().map(a => [{ text: a, callback_data: `rcy_${sesionId}_${a}` }]),
            [{ text: 'Cancelar', callback_data: `rcx_${sesionId}` }]
          ]
        );
        return;
      }
      s.anio = Number(fechaHoySantiago().slice(0, 4));
      s.otrosAnios = [...anios].filter(a => Number(a) !== s.anio);
    }
    await pasoResumen(chatId, messageId, sesionId);
  }

  function lineasDe(sel) {
    const c = sel.conteos;
    return [
      `Movimientos: ${c.movimientos}${sel.modo === 'todo' ? ` (${c.importados} de cartolas, ${c.manuales} manuales)` : ' (los que vinieron de cartolas)'}`,
      `Cartolas importadas (registros de importación): ${c.archivos}`,
      `Cargos recordados de cartolas de terceros: ${c.cargos}`,
      `Pagos de cuotas ligados: ${c.pagosCuota}${sel.compras.length > 0 ? ` (cambian ${sel.compras.map(x => esc(x.alias)).join(', ')})` : ''}`,
      `Transferencias ligadas: ${c.transferencias}`
    ];
  }

  async function pasoResumen(chatId, messageId, sesionId) {
    const s = sesiones.get(sesionId);
    const rango = rangoDePeriodo(s.periodo, s.anio);
    const [soloImportaciones, todo] = [await seleccionar(s.cuenta.id, rango, 'importaciones'), await seleccionar(s.cuenta.id, rango, 'todo')];
    const pendientes = !s.periodo && ctx.contarPendientes ? await ctx.contarPendientes(s.cuenta.id) : 0;

    const vacio = todo.conteos.movimientos === 0 && todo.conteos.archivos === 0 && pendientes === 0;
    const encabezado = `<b>${esc(s.cuenta.nombre)}</b>${s.cuenta.titular ? ` · ${esc(s.cuenta.titular)}` : ''}\nPeríodo: ${esc(etiquetaPeriodo(s.periodo, s.anio))}`;
    if (vacio) {
      await mostrar(chatId, messageId,
        `${encabezado}\n\nNo hay nada que borrar de esa cuenta en ese período.` +
        (s.otrosAnios?.length > 0 ? ` Hay registros de ese mes en ${s.otrosAnios.join(', ')}: escribe el año para elegirlo.` : ''),
        []
      );
      return;
    }

    await mostrar(chatId, messageId,
      `${encabezado}\n\n<b>Solo importaciones de cartolas</b> borra:\n${lineasDe(soloImportaciones).join('\n')}\n\n` +
      `<b>Todo de esta cuenta</b> borra:\n${lineasDe(todo).join('\n')}\n\n` +
      (!s.periodo ? `Selecciones pendientes del lote de terceros: ${pendientes} (se descartan)\n\n` : 'Con un período no se tocan las colas pendientes.\n\n') +
      'La cuenta, las compras en cuotas y los PDF originales se conservan. Antes de borrar se guarda un respaldo.',
      [
        [{ text: 'Solo importaciones de cartolas', callback_data: `rcm_${sesionId}_i` }],
        [{ text: 'Todo de esta cuenta', callback_data: `rcm_${sesionId}_t` }],
        [{ text: 'Cancelar', callback_data: `rcx_${sesionId}` }]
      ]
    );
  }

  async function pasoConfirmar(chatId, messageId, sesionId, modo) {
    const s = sesiones.get(sesionId);
    s.modo = modo === 'i' ? 'importaciones' : 'todo';
    const sel = await seleccionar(s.cuenta.id, rangoDePeriodo(s.periodo, s.anio), s.modo);
    await mostrar(chatId, messageId,
      `<b>Confirmar el borrado</b>\n${esc(s.cuenta.nombre)} · ${esc(etiquetaPeriodo(s.periodo, s.anio))}\n` +
      `${s.modo === 'todo' ? 'Todo de esta cuenta' : 'Solo importaciones de cartolas'}:\n\n${lineasDe(sel).join('\n')}\n\n` +
      'Se guarda un respaldo y podrás deshacerlo durante 10 minutos. ¿Borro?',
      [
        [{ text: 'Sí, borrar', callback_data: `rcb_${sesionId}` }],
        [{ text: 'Cancelar', callback_data: `rcx_${sesionId}` }]
      ]
    );
  }

  async function pasoBorrar(chatId, messageId, sesionId) {
    const s = sesiones.get(sesionId);
    // Un segundo toque (el borrado ya se hizo) no vuelve a borrar ni pisa el resultado
    if (!s.modo) return;
    // Se vuelve a calcular: lo que se borra es lo que hay ahora
    const sel = await seleccionar(s.cuenta.id, rangoDePeriodo(s.periodo, s.anio), s.modo);
    try {
      // Si el respaldo falla no se borra nada
      const respaldo = await guardarRespaldoJSON(sel, { cuenta: s.cuenta.nombre, periodo: etiquetaPeriodo(s.periodo, s.anio) });
      const conteos = await borrarSeleccion(sel);
      s.respaldo = respaldo.nombre;
      s.deshacerHasta = Date.now() + VIDA_DESHACER_MS;
      s.modo = null;
      if (!s.periodo && ctx.descartarPendientes) await ctx.descartarPendientes(s.cuenta.id);

      const cuotas = sel.compras.map(c => `${esc(c.alias)}: ${c.antes} → ${c.despues} de ${c.total} cuotas pagadas`);
      await mostrar(chatId, messageId,
        `<b>Listo</b>: borré ${conteos.movimientos} movimientos y ${conteos.archivos} registros de importación de ${esc(s.cuenta.nombre)} (${esc(etiquetaPeriodo(s.periodo, s.anio))}).` +
        (cuotas.length > 0 ? `\n\nCuotas que cambiaron:\n${cuotas.join('\n')}` : '') +
        '\n\nGuardé un respaldo en la carpeta respaldos/. Los PDF originales siguen guardados.',
        [[{ text: 'Deshacer (10 min)', callback_data: `rcz_${sesionId}` }]]
      );
    } catch (error) {
      console.error('Error en /resetcuenta:', error.code ?? error.name);
      await mostrar(chatId, messageId, 'No pude borrar: no se cambió nada. Inténtalo de nuevo.', []);
    }
  }

  async function pasoDeshacer(chatId, messageId, sesionId) {
    const s = sesiones.get(sesionId);
    if (!s.respaldo || Date.now() > s.deshacerHasta) {
      return mostrar(chatId, messageId, 'Ya pasaron los 10 minutos para deshacer.', []);
    }
    try {
      await deshacerDesdeRespaldo(s.respaldo);
      s.respaldo = null;
      await mostrar(chatId, messageId, `Deshecho: devolví lo que borré de ${esc(s.cuenta.nombre)} y los contadores de cuotas a su valor anterior.`, []);
    } catch (error) {
      console.error('Error al deshacer /resetcuenta:', error.code ?? error.name);
      await mostrar(chatId, messageId, 'No pude deshacerlo (puede que ya se haya restaurado o que haya registros nuevos con los mismos datos). El respaldo sigue guardado.', []);
    }
  }

  // -------------------------------------------------------------------------
  // Entrada
  // -------------------------------------------------------------------------

  async function empezar(chatId, interpretacion) {
    if (interpretacion?.error) return enviar(chatId, esc(interpretacion.error));
    const cuentas = await cuentasActivas();
    if (interpretacion?.digitos) {
      const calzan = cuentasQueCalzan({ digitos: interpretacion.digitos }, cuentas);
      if (calzan.length === 1) {
        const sesion = nuevaSesion(chatId, { cuenta: calzan[0], periodo: interpretacion.periodo ?? null, anio: interpretacion.periodo?.anio ?? null });
        return pasoAnio(chatId, null, sesion);
      }
      if (calzan.length > 1) return pasoCuenta(chatId, interpretacion, 'Hay varias cuentas con esos dígitos.', calzan);
      return pasoCuenta(chatId, interpretacion, `No encontré una cuenta con ****${esc(interpretacion.digitos)}.`);
    }
    return pasoCuenta(chatId, interpretacion);
  }

  /** "resetea la cuenta 8263", "borra enero de la 8263", "limpia la tarjeta 8263 mes 1 a 3" */
  async function manejarTexto(msg) {
    const texto = msg.text ?? '';
    const i = interpretarResetCuenta(texto);
    // Solo si pide limpiar una cuenta: con verbo de limpiar y la cuenta (dígitos o la palabra) o con período
    if (!i || !i.verbo) return false;
    const norm = texto.toLowerCase();
    if (!i.digitos && !/\b(?:cuenta|tarjeta)\b/.test(norm)) return false;
    try {
      await empezar(msg.chat.id, i);
    } catch (error) {
      console.error('Error en /resetcuenta:', error.code ?? error.name);
      await enviar(msg.chat.id, 'No pude preparar el borrado. Inténtalo de nuevo.');
    }
    return true;
  }

  function configurarComandos() {
    bot.onText(/^\/(?:resetcuenta|limpiarcuenta)(?:@\w+)?(?:\s+([\s\S]+))?$/i, async (msg, match) => {
      const chatId = msg.chat.id;
      if (!esChatAutorizado(chatId)) {
        await enviar(chatId, 'No estás autorizado para usar este bot.');
        return;
      }
      try {
        const argumento = (match[1] || '').trim();
        const i = argumento ? interpretarResetCuenta(argumento) : null;
        if (argumento && !i) {
          await enviar(chatId, 'No entendí eso. Prueba «/resetcuenta 8263», «/resetcuenta 8263 mes 1» o «/resetcuenta 8263 enero 2026».');
          return;
        }
        await empezar(chatId, i);
      } catch (error) {
        console.error('Error en /resetcuenta:', error.code ?? error.name);
        await enviar(chatId, 'No pude preparar el borrado. Inténtalo de nuevo.');
      }
    });
  }

  async function manejarCallback(cb, chatId, data) {
    const m = /^rc([cymbxz])_(\d+)(?:_(.+))?$/.exec(data);
    if (!m) return false;
    const [, tipo, idTexto, valor] = m;
    const sesionId = Number(idTexto);
    const messageId = cb.message.message_id;

    try {
      const s = vigente(sesionId, chatId);
      if (!s || (tipo !== 'z' && Date.now() > s.hasta)) {
        await responderCallback(cb.id, { text: 'Solicitud expirada' });
        return true;
      }
      await responderCallback(cb.id, {});

      if (tipo === 'x') {
        sesiones.delete(sesionId);
        await mostrar(chatId, messageId, 'Cancelado: no borré nada.', []);
      } else if (tipo === 'c') {
        const cuenta = (await cuentasActivas()).find(c => c.id === Number(valor));
        if (!cuenta) return (await mostrar(chatId, messageId, 'Esa cuenta ya no está disponible.', []), true);
        s.cuenta = cuenta;
        await pasoAnio(chatId, messageId, sesionId);
      } else if (tipo === 'y') {
        s.anio = Number(valor);
        await pasoResumen(chatId, messageId, sesionId);
      } else if (tipo === 'm') {
        await pasoConfirmar(chatId, messageId, sesionId, valor);
      } else if (tipo === 'b') {
        if (s.borrando) return true;
        s.borrando = true;
        try {
          await pasoBorrar(chatId, messageId, sesionId);
        } finally {
          s.borrando = false;
        }
      } else if (tipo === 'z') {
        await pasoDeshacer(chatId, messageId, sesionId);
      }
    } catch (error) {
      console.error('Error en /resetcuenta:', error.code ?? error.name);
      await enviar(chatId, 'Ocurrió un error. No se borró nada nuevo.');
    }
    return true;
  }

  return { configurarComandos, manejarTexto, manejarCallback };
}
