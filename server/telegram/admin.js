/**
 * Administración desde Telegram de lo que antes solo se hacía en la web:
 * movimientos (/ultimos y /buscar con botones para editar o borrar), categorías y reglas,
 * deudas, y la configuración del plan de ahorro y sus gastos fijos.
 *
 * Se crea con crearAdmin(ctx): ctx trae el bot y los envoltorios seguros de bot.js
 * (enviar, editar, responderCallback), esc, esChatAutorizado y formatearMonto.
 * Los errores de BD se registran solo con su código.
 */

import { parsearMontoExacto, analizarMonto } from './parser.js';
import { fechaHoySantiago, formatearFechaCL } from './fechas.js';
import { normalizar } from './cuentas.js';
import { TIPOS_MOVIMIENTO, ETIQUETAS_TIPO, requiereDestino } from '../tiposMovimiento.js';
import {
  ultimosMovimientos,
  buscarMovimientos,
  interpretarBusqueda,
  obtenerMovimiento,
  actualizarMovimiento,
  borrarMovimiento,
  listarCategorias,
  listarCuentasActivas,
  crearCategoria,
  separarReglaYCategoria,
  listarReglas,
  crearRegla,
  borrarRegla,
  gastosDelMes
} from '../gestion.js';
import { resumenDeudas, registrarPagoDeuda, canonizarPersona } from '../deudas.js';
import {
  cargarPlan,
  guardarPlan,
  validarPorcentajes,
  listarGastosFijos,
  actualizarGastoFijo,
  desactivarGastoFijo,
  validarGastoFijo,
  listaPalabrasClave
} from '../planAhorro.js';

const ESPERA_MS = 5 * 60 * 1000;

// Códigos cortos de tipo de movimiento para callback_data
const CODIGOS_TIPO = {
  compra: 'cp',
  pago_tarjeta: 'pt',
  transferencia_propia: 'tp',
  transferencia_terceros: 'tt',
  ingreso: 'in',
  otro: 'ot'
};
const TIPO_POR_CODIGO = Object.fromEntries(Object.entries(CODIGOS_TIPO).map(([tipo, codigo]) => [codigo, tipo]));

const NOMBRES_CAMPO_FIJO = { m: 'el monto', d: 'el día de pago', p: 'las palabras clave', n: 'el nombre' };

export function crearAdmin(ctx) {
  const { bot, enviar, editar, responderCallback, esc, esChatAutorizado, formatearMonto } = ctx;

  // Texto que se espera de un chat: chatId -> { accion, ..., hasta }
  const esperando = new Map();
  // Pagos de deudas pendientes de confirmar: clave -> { persona, monto }
  const pagosPendientes = new Map();

  const dinero = (n) => `${n < 0 ? '-' : ''}$${formatearMonto(Math.abs(n))}`;
  const noAutorizado = (chatId) => enviar(chatId, 'No estás autorizado para usar este bot.');
  const botonCancelar = { reply_markup: { inline_keyboard: [[{ text: 'Cancelar', callback_data: 'admx' }]] } };

  function esperar(chatId, datos) {
    esperando.set(chatId, { ...datos, hasta: Date.now() + ESPERA_MS });
  }

  function errorBD(contexto, error) {
    console.error(`${contexto}:`, error.code ?? error.name);
  }

  // -------------------------------------------------------------------------
  // Movimientos
  // -------------------------------------------------------------------------

  function textoMovimiento(m) {
    return [
      '<b>Movimiento</b>',
      '',
      `Fecha: ${formatearFechaCL(m.fecha)}`,
      `Descripción: ${esc(m.descripcion)}`,
      `Monto: ${dinero(Number(m.monto))}`,
      `Tipo: ${esc(ETIQUETAS_TIPO[m.tipo_movimiento] ?? m.tipo_movimiento)}`,
      `Categoría: ${m.categoria_nombre ? esc(m.categoria_nombre) : 'sin categoría'}`,
      `Cuenta: ${m.cuenta_nombre ? esc(m.cuenta_nombre) : 'sin indicar'}`,
      ...(m.cuenta_destino_nombre ? [`Cuenta destino: ${esc(m.cuenta_destino_nombre)}`] : []),
      ...(esPrestamo(m) ? [`Préstamo a: ${esc(m.persona_prestamo)}`] : [])
    ].join('\n');
  }

  const esPrestamo = (m) => Number(m.es_prestamo) === 1 && Boolean(m.persona_prestamo);

  function tecladoMovimiento(m) {
    const id = m.id;
    return {
      reply_markup: {
        inline_keyboard: [
          [
            { text: 'Editar monto', callback_data: `mvm_${id}` },
            { text: 'Editar categoría', callback_data: `mvc_${id}` }
          ],
          [
            { text: 'Editar cuenta', callback_data: `mvu_${id}` },
            { text: 'Editar tipo', callback_data: `mvt_${id}` }
          ],
          [
            esPrestamo(m)
              ? { text: 'Quitar préstamo', callback_data: `mvq_${id}` }
              : { text: 'Marcar como préstamo', callback_data: `mvl_${id}` },
            { text: 'Borrar', callback_data: `mvb_${id}` }
          ]
        ]
      }
    };
  }

  /** Vuelve a dibujar la ficha de un movimiento en el mensaje indicado */
  async function refrescarMovimiento(chatId, messageId, id, aviso = '') {
    const movimiento = await obtenerMovimiento(id);
    if (!movimiento) {
      await editar('El movimiento ya no existe.', { chat_id: chatId, message_id: messageId });
      return;
    }
    await editar(textoMovimiento(movimiento) + aviso, {
      chat_id: chatId,
      message_id: messageId,
      ...tecladoMovimiento(movimiento)
    });
  }

  async function enviarListaMovimientos(chatId, titulo, filas) {
    if (filas.length === 0) {
      await enviar(chatId, 'No encontré movimientos.');
      return;
    }

    const lineas = filas.map((m, i) =>
      `${i + 1}. ${formatearFechaCL(m.fecha)} - ${esc(m.descripcion)} - ${m.tipo === 'cargo' ? '-' : '+'}${dinero(Number(m.monto))}\n` +
      `   ${esc(m.categoria_nombre || 'sin categoría')} | ${esc(m.cuenta_nombre || 'sin cuenta')}` +
      (esPrestamo(m) ? ` | préstamo: ${esc(m.persona_prestamo)}` : '')
    );
    await enviar(chatId, `<b>${esc(titulo)}</b>\n\n${lineas.join('\n')}\n\nToca un movimiento para editarlo o borrarlo.`, {
      reply_markup: {
        inline_keyboard: filas.map((m, i) => [{
          text: `${i + 1}. ${dinero(Number(m.monto))} ${m.descripcion}`.slice(0, 48),
          callback_data: `mvo_${m.id}`
        }])
      }
    });
  }

  async function mostrarUltimos(chatId) {
    try {
      await enviarListaMovimientos(chatId, 'Últimos 10 movimientos', await ultimosMovimientos(10));
    } catch (error) {
      errorBD('Error al obtener últimos movimientos', error);
      await enviar(chatId, 'Error al obtener los movimientos.');
    }
  }

  async function filaCuentasBotones(prefijo, excluirId = null) {
    const cuentas = (await listarCuentasActivas()).filter(c => Number(c.id) !== Number(excluirId));
    const filas = [];
    for (let i = 0; i < cuentas.length; i += 2) {
      filas.push(cuentas.slice(i, i + 2).map(c => ({ text: String(c.nombre).slice(0, 30), callback_data: `${prefijo}_${c.id}` })));
    }
    return filas;
  }

  async function manejarCallbackMovimientos(cb, chatId, data) {
    const messageId = cb.message.message_id;
    const partes = (patron) => data.match(patron);
    let m;

    // Abrir la ficha de un movimiento
    if ((m = partes(/^mvo_(\d+)$/))) {
      const movimiento = await obtenerMovimiento(m[1]);
      if (!movimiento) {
        await responderCallback(cb.id, { text: 'El movimiento ya no existe' });
        return true;
      }
      await enviar(chatId, textoMovimiento(movimiento), tecladoMovimiento(movimiento));
      await responderCallback(cb.id, {});
      return true;
    }

    // Editar monto: se espera un texto
    if ((m = partes(/^mvm_(\d+)$/))) {
      esperar(chatId, { accion: 'mov_monto', id: m[1], messageId });
      await enviar(chatId, 'Escribe el nuevo monto (por ejemplo 12.500 o 5 lucas).', botonCancelar);
      await responderCallback(cb.id, {});
      return true;
    }

    // Editar categoría
    if ((m = partes(/^mvc_(\d+)$/))) {
      const categorias = await listarCategorias();
      const filas = [];
      for (let i = 0; i < categorias.length; i += 2) {
        filas.push(categorias.slice(i, i + 2).map(c => ({ text: c.nombre, callback_data: `mvcs_${m[1]}_${c.id}` })));
      }
      filas.push([{ text: 'Sin categoría', callback_data: `mvcs_${m[1]}_0` }]);
      await editar('Elige la categoría:', { chat_id: chatId, message_id: messageId, reply_markup: { inline_keyboard: filas } });
      await responderCallback(cb.id, {});
      return true;
    }
    if ((m = partes(/^mvcs_(\d+)_(\d+)$/))) {
      const r = await actualizarMovimiento(m[1], { categoria_id: Number(m[2]) || null });
      await responderCallback(cb.id, { text: r.ok ? 'Categoría actualizada' : r.error });
      await refrescarMovimiento(chatId, messageId, m[1]);
      return true;
    }

    // Editar cuenta (origen)
    if ((m = partes(/^mvu_(\d+)$/))) {
      const filas = await filaCuentasBotones(`mvus_${m[1]}`);
      await editar('Elige la cuenta:', { chat_id: chatId, message_id: messageId, reply_markup: { inline_keyboard: filas } });
      await responderCallback(cb.id, {});
      return true;
    }
    if ((m = partes(/^mvus_(\d+)_(\d+)$/))) {
      const r = await actualizarMovimiento(m[1], { cuenta_id: Number(m[2]) });
      await responderCallback(cb.id, { text: r.ok ? 'Cuenta actualizada' : r.error });
      await refrescarMovimiento(chatId, messageId, m[1]);
      return true;
    }

    // Editar tipo
    if ((m = partes(/^mvt_(\d+)$/))) {
      const filas = [];
      for (let i = 0; i < TIPOS_MOVIMIENTO.length; i += 2) {
        filas.push(TIPOS_MOVIMIENTO.slice(i, i + 2).map(t => ({
          text: ETIQUETAS_TIPO[t],
          callback_data: `mvts_${m[1]}_${CODIGOS_TIPO[t]}`
        })));
      }
      await editar('Elige el tipo:', { chat_id: chatId, message_id: messageId, reply_markup: { inline_keyboard: filas } });
      await responderCallback(cb.id, {});
      return true;
    }
    if ((m = partes(/^mvts_(\d+)_([a-z]{2})$/))) {
      const tipo = TIPO_POR_CODIGO[m[2]];
      if (!tipo) return true;

      if (requiereDestino(tipo)) {
        // Pagos de tarjeta y transferencias propias necesitan la cuenta destino
        const movimiento = await obtenerMovimiento(m[1]);
        const filas = await filaCuentasBotones(`mvds_${m[1]}_${m[2]}`, movimiento?.cuenta_id);
        await editar('Elige la cuenta destino:', { chat_id: chatId, message_id: messageId, reply_markup: { inline_keyboard: filas } });
        await responderCallback(cb.id, {});
        return true;
      }

      const r = await actualizarMovimiento(m[1], { tipo_movimiento: tipo });
      await responderCallback(cb.id, { text: r.ok ? 'Tipo actualizado' : r.error });
      await refrescarMovimiento(chatId, messageId, m[1]);
      return true;
    }
    if ((m = partes(/^mvds_(\d+)_([a-z]{2})_(\d+)$/))) {
      const tipo = TIPO_POR_CODIGO[m[2]];
      const r = tipo
        ? await actualizarMovimiento(m[1], { tipo_movimiento: tipo, cuenta_destino_id: Number(m[3]) })
        : { ok: false, error: 'Tipo no válido' };
      await responderCallback(cb.id, { text: r.ok ? 'Tipo actualizado' : r.error });
      await refrescarMovimiento(chatId, messageId, m[1]);
      return true;
    }

    // Marcar como préstamo: se espera el nombre de la persona
    if ((m = partes(/^mvl_(\d+)$/))) {
      esperar(chatId, { accion: 'mov_prestamo', id: m[1], messageId });
      await enviar(chatId, 'Escribe el nombre de la persona a quien le prestaste.', botonCancelar);
      await responderCallback(cb.id, {});
      return true;
    }
    if ((m = partes(/^mvq_(\d+)$/))) {
      const r = await actualizarMovimiento(m[1], { es_prestamo: 0, persona_prestamo: null });
      await responderCallback(cb.id, { text: r.ok ? 'Ya no es préstamo' : r.error });
      await refrescarMovimiento(chatId, messageId, m[1]);
      return true;
    }

    // Borrar con confirmación
    if ((m = partes(/^mvb_(\d+)$/))) {
      const movimiento = await obtenerMovimiento(m[1]);
      if (!movimiento) {
        await responderCallback(cb.id, { text: 'El movimiento ya no existe' });
        return true;
      }
      await editar(`¿Eliminar este movimiento?\n\n${textoMovimiento(movimiento)}`, {
        chat_id: chatId,
        message_id: messageId,
        reply_markup: {
          inline_keyboard: [[
            { text: 'Sí, eliminar', callback_data: `mvby_${m[1]}` },
            { text: 'Cancelar', callback_data: `mvbn_${m[1]}` }
          ]]
        }
      });
      await responderCallback(cb.id, {});
      return true;
    }
    if ((m = partes(/^mvby_(\d+)$/))) {
      const borrado = await borrarMovimiento(m[1]);
      await editar(borrado ? 'Movimiento eliminado.' : 'El movimiento ya no existe.', { chat_id: chatId, message_id: messageId });
      await responderCallback(cb.id, { text: borrado ? 'Eliminado' : 'No existe' });
      return true;
    }
    if ((m = partes(/^mvbn_(\d+)$/))) {
      await refrescarMovimiento(chatId, messageId, m[1]);
      await responderCallback(cb.id, { text: 'Cancelado' });
      return true;
    }

    return false;
  }

  // -------------------------------------------------------------------------
  // Categorías y reglas
  // -------------------------------------------------------------------------

  async function enviarReglas(chatId) {
    const reglas = await listarReglas();
    if (reglas.length === 0) {
      await enviar(chatId,
        'No hay reglas de autocategorización.\n\nCrea una con /regla <texto> <categoría>, por ejemplo: /regla uber transporte'
      );
      return;
    }
    await enviar(chatId,
      '<b>Reglas de autocategorización:</b>\n\n' +
      reglas.map((r, i) => `${i + 1}. "${esc(r.texto_buscar)}" - ${esc(r.categoria_nombre)}`).join('\n') +
      '\n\nToca una regla para eliminarla.',
      {
        reply_markup: {
          inline_keyboard: reglas.map((r, i) => [{
            text: `${i + 1}. ${r.texto_buscar} - ${r.categoria_nombre}`.slice(0, 48),
            callback_data: `rgd_${r.id}`
          }])
        }
      }
    );
  }

  async function manejarCallbackReglas(cb, chatId, data) {
    const messageId = cb.message.message_id;
    let m;

    if ((m = data.match(/^rgd_(\d+)$/))) {
      const regla = (await listarReglas()).find(r => String(r.id) === m[1]);
      if (!regla) {
        await responderCallback(cb.id, { text: 'La regla ya no existe' });
        return true;
      }
      await editar(`¿Eliminar la regla "${esc(regla.texto_buscar)}" (${esc(regla.categoria_nombre)})?`, {
        chat_id: chatId,
        message_id: messageId,
        reply_markup: {
          inline_keyboard: [[
            { text: 'Sí, eliminar', callback_data: `rgdy_${m[1]}` },
            { text: 'Cancelar', callback_data: 'admx' }
          ]]
        }
      });
      await responderCallback(cb.id, {});
      return true;
    }

    if ((m = data.match(/^rgdy_(\d+)$/))) {
      const borrada = await borrarRegla(m[1]);
      await editar(borrada ? 'Regla eliminada.' : 'La regla ya no existe.', { chat_id: chatId, message_id: messageId });
      await responderCallback(cb.id, { text: borrada ? 'Eliminada' : 'No existe' });
      return true;
    }

    return false;
  }

  // -------------------------------------------------------------------------
  // Deudas
  // -------------------------------------------------------------------------

  async function pedirConfirmacionPago(chatId, argumento) {
    const analisis = analizarMonto(argumento);
    const nombre = analisis
      ? `${argumento.slice(0, analisis.inicio)} ${argumento.slice(analisis.fin)}`.replace(/\s+/g, ' ').trim()
      : '';
    if (!analisis || !nombre) {
      await enviar(chatId, '<b>Registrar un pago</b>\n\nEscribe la persona y el monto, por ejemplo:\n/pago Pedro 20 mil');
      return;
    }

    const resumen = await resumenDeudas();
    const buscado = normalizar(nombre);
    const persona =
      resumen.find(r => normalizar(r.persona) === buscado) ||
      resumen.find(r => normalizar(r.persona).includes(buscado));
    if (!persona) {
      const conocidas = resumen.map(r => `- ${esc(r.persona)}`).join('\n');
      await enviar(chatId, `No encontré a "${esc(nombre)}" entre tus deudas.${conocidas ? `\n\nPersonas:\n${conocidas}` : ''}`);
      return;
    }

    const key = `${chatId}_${Date.now()}`;
    pagosPendientes.set(key, { persona: persona.persona, monto: analisis.monto });
    setTimeout(() => pagosPendientes.delete(key), ESPERA_MS);

    await enviar(chatId,
      `<b>Confirmar pago</b>\n\nPersona: ${esc(persona.persona)}\nMonto: ${dinero(analisis.monto)}\n` +
      `Saldo actual: ${dinero(persona.saldo)}`,
      {
        reply_markup: {
          inline_keyboard: [[
            { text: 'Guardar', callback_data: `pgs_${key}` },
            { text: 'Cancelar', callback_data: `pgx_${key}` }
          ]]
        }
      }
    );
  }

  async function manejarCallbackPagos(cb, chatId, data) {
    const messageId = cb.message.message_id;

    if (data.startsWith('pgs_')) {
      const key = data.replace('pgs_', '');
      const pago = pagosPendientes.get(key);
      if (!pago) {
        await responderCallback(cb.id, { text: 'Solicitud expirada' });
        return true;
      }
      try {
        await registrarPagoDeuda({ persona: pago.persona, monto: pago.monto, fecha: fechaHoySantiago() });
        pagosPendientes.delete(key);
        const nuevo = (await resumenDeudas()).find(r => r.persona === pago.persona);
        await editar(
          `Pago registrado: ${dinero(pago.monto)} de <b>${esc(pago.persona)}</b>.` +
          (nuevo ? `\nSaldo pendiente: ${dinero(nuevo.saldo)}` : ''),
          { chat_id: chatId, message_id: messageId }
        );
        await responderCallback(cb.id, { text: 'Guardado' });
      } catch (error) {
        errorBD('Error al registrar pago', error);
        await responderCallback(cb.id, { text: 'Error al guardar' });
      }
      return true;
    }

    if (data.startsWith('pgx_')) {
      pagosPendientes.delete(data.replace('pgx_', ''));
      await editar('Cancelado', { chat_id: chatId, message_id: messageId });
      await responderCallback(cb.id, { text: 'Cancelado' });
      return true;
    }

    return false;
  }

  // -------------------------------------------------------------------------
  // Plan de ahorro: configuración y gastos fijos
  // -------------------------------------------------------------------------

  async function mostrarConfigPlan(chatId) {
    const plan = await cargarPlan();
    await enviar(chatId,
      '<b>Configuración del plan de ahorro</b>\n\n' +
      `Ingreso base: ${plan.ingreso_base === null ? 'sin definir (se usan los ingresos reales del mes)' : dinero(plan.ingreso_base)}\n` +
      `Porcentajes: fijos ${plan.pct_fijos}%, libres ${plan.pct_libres}%, ahorro ${plan.pct_ahorro}%\n\n` +
      'También puedes escribir:\n/plan ingreso 1.200.000\n/plan 50 30 20',
      {
        reply_markup: {
          inline_keyboard: [
            [
              { text: 'Ingreso base', callback_data: 'plb_x' },
              { text: 'Porcentajes', callback_data: 'plp_x' }
            ],
            [{ text: 'Usar ingresos reales', callback_data: 'plr_x' }]
          ]
        }
      }
    );
  }

  /** Guarda el ingreso base ("real" lo borra). Devuelve true si se guardó. */
  async function aplicarIngresoBase(chatId, texto) {
    const plan = await cargarPlan();
    let ingresoBase;
    if (/^(?:real|reales|auto|automatico|borrar|ninguno|sin)$/.test(normalizar(texto).trim())) {
      ingresoBase = null;
    } else {
      ingresoBase = parsearMontoExacto(texto);
      if (!ingresoBase) {
        await enviar(chatId, 'No entendí el monto. Ejemplo: /plan ingreso 1.200.000');
        return false;
      }
    }
    await guardarPlan({ ...plan, ingreso_base: ingresoBase });
    await mostrarConfigPlan(chatId);
    return true;
  }

  /** Guarda los tres porcentajes (fijos, libres, ahorro) si suman 100. true si se guardó. */
  async function aplicarPorcentajes(chatId, fijos, libres, ahorro) {
    const validacion = validarPorcentajes({ pct_fijos: fijos, pct_libres: libres, pct_ahorro: ahorro });
    if (!validacion.ok) {
      await enviar(chatId, esc(validacion.error));
      return false;
    }
    const plan = await cargarPlan();
    await guardarPlan({ ...plan, ...validacion.valores });
    await mostrarConfigPlan(chatId);
    return true;
  }

  /** /plan con argumentos: config, ingreso <monto> o tres porcentajes */
  async function planConArgumentos(chatId, argumento) {
    const texto = argumento.trim();
    try {
      if (/^config(?:uracion)?$/i.test(normalizar(texto))) {
        await mostrarConfigPlan(chatId);
        return;
      }

      const ingreso = /^ingreso\b\s*(.*)$/i.exec(texto);
      if (ingreso) {
        await aplicarIngresoBase(chatId, ingreso[1]);
        return;
      }

      const porcentajes = /^(\d+(?:[.,]\d+)?)\s+(\d+(?:[.,]\d+)?)\s+(\d+(?:[.,]\d+)?)$/.exec(texto);
      if (porcentajes) {
        const [, a, b, c] = porcentajes.map(v => v.replace(',', '.'));
        await aplicarPorcentajes(chatId, a, b, c);
        return;
      }

      await enviar(chatId,
        '<b>Plan de ahorro</b>\n\n/plan - Resumen del mes\n/plan config - Ver y editar la configuración\n' +
        '/plan ingreso 1.200.000 - Definir el ingreso base\n/plan 50 30 20 - Porcentajes de fijos, libres y ahorro'
      );
    } catch (error) {
      errorBD('Error en /plan', error);
      await enviar(chatId, 'Error al guardar la configuración del plan.');
    }
  }

  function lineaFijo(f, prefijo = '') {
    return `${prefijo}<b>${esc(f.nombre)}</b> - ${dinero(f.monto)}` +
      `${f.dia_pago ? ` - día ${f.dia_pago}` : ''}` +
      `${f.destinatario ? ` - se paga a ${esc(f.destinatario)}` : ''}` +
      `${f.palabras_clave ? ` - palabras: ${esc(f.palabras_clave)}` : ''}`;
  }

  async function listarFijos(chatId) {
    const fijos = await listarGastosFijos();
    if (fijos.length === 0) {
      await enviar(chatId, 'No tienes gastos fijos. Agrega uno con /fijo arriendo 350 mil el 5.');
      return;
    }
    const total = fijos.reduce((suma, f) => suma + f.monto, 0);
    await enviar(chatId,
      '<b>Tus gastos fijos:</b>\n\n' + fijos.map((f, i) => lineaFijo(f, `${i + 1}. `)).join('\n') +
      `\n\nTotal: ${dinero(total)}`,
      {
        reply_markup: {
          inline_keyboard: fijos.map((f, i) => [
            { text: `Editar ${i + 1}. ${f.nombre}`.slice(0, 30), callback_data: `fje_${f.id}` },
            { text: `Desactivar ${i + 1}`, callback_data: `fjd_${f.id}` }
          ])
        }
      }
    );
  }

  async function manejarCallbackPlan(cb, chatId, data) {
    const messageId = cb.message.message_id;
    let m;

    if (data === 'plb_x') {
      esperar(chatId, { accion: 'plan_ingreso' });
      await enviar(chatId, 'Escribe el ingreso base (por ejemplo 1.200.000).', botonCancelar);
      await responderCallback(cb.id, {});
      return true;
    }
    if (data === 'plp_x') {
      esperar(chatId, { accion: 'plan_pct' });
      await enviar(chatId, 'Escribe tres porcentajes que sumen 100: fijos, libres y ahorro (por ejemplo 50 30 20).', botonCancelar);
      await responderCallback(cb.id, {});
      return true;
    }
    if (data === 'plr_x') {
      await aplicarIngresoBase(chatId, 'real');
      await responderCallback(cb.id, { text: 'Se usarán los ingresos reales' });
      return true;
    }

    // Editar un gasto fijo: elegir qué campo
    if ((m = data.match(/^fje_(\d+)$/))) {
      const fijo = (await listarGastosFijos()).find(f => String(f.id) === m[1]);
      if (!fijo) {
        await responderCallback(cb.id, { text: 'Ya no está activo' });
        return true;
      }
      await enviar(chatId, `Editar <b>${esc(fijo.nombre)}</b>. ¿Qué quieres cambiar?`, {
        reply_markup: {
          inline_keyboard: [
            [
              { text: 'Monto', callback_data: `fjf_${m[1]}_m` },
              { text: 'Día de pago', callback_data: `fjf_${m[1]}_d` }
            ],
            [
              { text: 'Palabras clave', callback_data: `fjf_${m[1]}_p` },
              { text: 'Nombre', callback_data: `fjf_${m[1]}_n` }
            ]
          ]
        }
      });
      await responderCallback(cb.id, {});
      return true;
    }
    if ((m = data.match(/^fjf_(\d+)_([mdpn])$/))) {
      esperar(chatId, { accion: 'fijo', id: m[1], campo: m[2] });
      const pista = m[2] === 'd' || m[2] === 'p' ? ' Escribe "sin" para quitarlo.' : '';
      await enviar(chatId, `Escribe ${NOMBRES_CAMPO_FIJO[m[2]]}.${pista}`, botonCancelar);
      await responderCallback(cb.id, {});
      return true;
    }

    // Desactivar un gasto fijo, con confirmación
    if ((m = data.match(/^fjd_(\d+)$/))) {
      const fijo = (await listarGastosFijos()).find(f => String(f.id) === m[1]);
      if (!fijo) {
        await responderCallback(cb.id, { text: 'Ya no está activo' });
        return true;
      }
      await enviar(chatId, `¿Desactivar el gasto fijo <b>${esc(fijo.nombre)}</b>?`, {
        reply_markup: {
          inline_keyboard: [[
            { text: 'Sí, desactivar', callback_data: `fjdy_${m[1]}` },
            { text: 'Cancelar', callback_data: 'admx' }
          ]]
        }
      });
      await responderCallback(cb.id, {});
      return true;
    }
    if ((m = data.match(/^fjdy_(\d+)$/))) {
      const hecho = await desactivarGastoFijo(m[1]);
      await editar(hecho ? 'Gasto fijo desactivado.' : 'El gasto fijo ya no existe.', { chat_id: chatId, message_id: messageId });
      await responderCallback(cb.id, { text: hecho ? 'Desactivado' : 'No existe' });
      return true;
    }

    return false;
  }

  // -------------------------------------------------------------------------
  // Texto esperado
  // -------------------------------------------------------------------------

  /** Atiende un mensaje de texto si el chat tiene una respuesta pendiente. true si lo consumió. */
  async function manejarTexto(msg) {
    const chatId = msg.chat.id;
    const espera = esperando.get(chatId);
    if (!espera) return false;
    if (Date.now() > espera.hasta) {
      esperando.delete(chatId);
      return false;
    }

    const texto = msg.text.trim();

    try {
      if (espera.accion === 'mov_monto') {
        const monto = parsearMontoExacto(texto);
        if (!monto) {
          await enviar(chatId, 'No entendí el monto. Escríbelo de nuevo (por ejemplo 12.500).', botonCancelar);
          return true;
        }
        const r = await actualizarMovimiento(espera.id, { monto });
        esperando.delete(chatId);
        if (!r.ok) {
          await enviar(chatId, esc(r.error));
          return true;
        }
        await refrescarMovimiento(chatId, espera.messageId, espera.id, '\n\nMonto actualizado.');
        return true;
      }

      if (espera.accion === 'mov_prestamo') {
        const persona = await canonizarPersona(texto.slice(0, 100));
        const r = await actualizarMovimiento(espera.id, { es_prestamo: 1, persona_prestamo: persona });
        esperando.delete(chatId);
        if (!r.ok) {
          await enviar(chatId, esc(r.error));
          return true;
        }
        await refrescarMovimiento(chatId, espera.messageId, espera.id, `\n\nMarcado como préstamo a ${esc(persona)}.`);
        return true;
      }

      if (espera.accion === 'plan_ingreso') {
        if (await aplicarIngresoBase(chatId, texto)) esperando.delete(chatId);
        return true;
      }

      if (espera.accion === 'plan_pct') {
        const numeros = texto.split(/[\s,]+/).filter(Boolean).map(v => v.replace(',', '.'));
        if (numeros.length !== 3) {
          await enviar(chatId, 'Escribe exactamente tres números, por ejemplo 50 30 20.', botonCancelar);
          return true;
        }
        if (await aplicarPorcentajes(chatId, numeros[0], numeros[1], numeros[2])) esperando.delete(chatId);
        return true;
      }

      if (espera.accion === 'fijo') {
        const fijo = (await listarGastosFijos()).find(f => String(f.id) === String(espera.id));
        if (!fijo) {
          esperando.delete(chatId);
          await enviar(chatId, 'El gasto fijo ya no está activo.');
          return true;
        }

        const quitar = /^(?:sin|ninguno|ninguna|borrar)$/.test(normalizar(texto));
        const cambios = {};
        if (espera.campo === 'm') {
          const monto = parsearMontoExacto(texto);
          if (!monto) {
            await enviar(chatId, 'No entendí el monto. Escríbelo de nuevo (por ejemplo 350 mil).', botonCancelar);
            return true;
          }
          cambios.monto = monto;
        } else if (espera.campo === 'd') {
          cambios.dia_pago = quitar ? null : texto;
        } else if (espera.campo === 'p') {
          cambios.palabras_clave = quitar ? null : listaPalabrasClave(texto).join(', ');
        } else if (espera.campo === 'n') {
          cambios.nombre = texto;
        }

        const validado = validarGastoFijo({
          nombre: fijo.nombre,
          monto: fijo.monto,
          dia_pago: fijo.dia_pago,
          categoria_id: fijo.categoria_id,
          cuenta_id: fijo.cuenta_id,
          palabras_clave: fijo.palabras_clave,
          ...cambios
        });
        if (!validado.ok) {
          await enviar(chatId, `${esc(validado.error)}. Escríbelo de nuevo.`, botonCancelar);
          return true;
        }

        await actualizarGastoFijo(fijo.id, validado.valores, fijo.activo);
        esperando.delete(chatId);
        await enviar(chatId, `Gasto fijo actualizado:\n${lineaFijo(validado.valores)}`);
        return true;
      }
    } catch (error) {
      errorBD('Error al aplicar el cambio', error);
      esperando.delete(chatId);
      await enviar(chatId, 'Error al guardar el cambio.');
      return true;
    }

    esperando.delete(chatId);
    return false;
  }

  // -------------------------------------------------------------------------
  // Callbacks y comandos
  // -------------------------------------------------------------------------

  /** Botones de este módulo. Devuelve true si el callback era suyo. */
  async function manejarCallback(cb, chatId, data) {
    try {
      if (data === 'admx') {
        esperando.delete(chatId);
        await editar('Cancelado', { chat_id: chatId, message_id: cb.message.message_id });
        await responderCallback(cb.id, { text: 'Cancelado' });
        return true;
      }
      if (/^mv[a-z]*_/.test(data)) return await manejarCallbackMovimientos(cb, chatId, data);
      if (/^rgdy?_/.test(data)) return await manejarCallbackReglas(cb, chatId, data);
      if (/^pg[sx]_/.test(data)) return await manejarCallbackPagos(cb, chatId, data);
      if (/^(?:pl[bpr]_x|fje_|fjf_|fjdy?_)/.test(data)) return await manejarCallbackPlan(cb, chatId, data);
    } catch (error) {
      errorBD('Error en un botón', error);
      await responderCallback(cb.id, { text: 'Error' });
      return true;
    }
    return false;
  }

  /**
   * Busca movimientos por texto y/o mes ("uber", "noviembre", "uber octubre 2026") y los lista con
   * botones. Sirve para /buscar y para las frases libres ("busca uber de octubre").
   */
  async function buscar(chatId, argumento) {
    const criterio = interpretarBusqueda(argumento, fechaHoySantiago());
    if (!criterio.texto && !criterio.desde) {
      await enviar(chatId,
        '<b>Buscar movimientos</b>\n\nEscribe un texto o un mes, por ejemplo:\nbusca uber\nbusca noviembre\nbusca uber octubre 2026'
      );
      return;
    }
    const filas = await buscarMovimientos(criterio, 15);
    const titulo = `Resultados (${filas.length})${criterio.etiquetaMes ? ` - ${criterio.etiquetaMes}` : ''}`;
    await enviarListaMovimientos(chatId, titulo, filas);
  }

  /** Gastos de un mes (fecha YYYY-MM-DD de cualquier día de ese mes) por categoría y uso de tarjetas */
  async function enviarGastosDelMes(chatId, fecha) {
    const r = await gastosDelMes(fecha);
    const mesNombre = new Date(r.anio, r.mes - 1).toLocaleString('es-CL', { month: 'long' });

    const lineas = [`<b>Gastos de ${esc(mesNombre)} ${r.anio}</b>`, '', `Total: ${dinero(r.total)}`];
    if (r.categorias.length === 0) {
      lineas.push('', 'Todavía no hay gastos este mes.');
    } else {
      lineas.push('', '<b>Por categoría:</b>');
      for (const c of r.categorias) {
        const pct = r.total > 0 ? Math.round(c.total / r.total * 100) : 0;
        lineas.push(`${esc(c.categoria)}: ${dinero(c.total)} (${pct}%)`);
      }
    }

    if (r.tarjetas.length > 0) {
      lineas.push('', '<b>Tarjetas de crédito (uso del mes):</b>');
      for (const t of r.tarjetas) {
        lineas.push(
          t.cupo === null
            ? `${esc(t.nombre)}: usado ${dinero(t.usado)} (sin cupo definido)`
            : `${esc(t.nombre)}: usado ${dinero(t.usado)} de ${dinero(t.cupo)} (${t.porcentaje}%), disponible ${dinero(t.disponible)}`
        );
      }
    }

    await enviar(chatId, lineas.join('\n'));
  }

  /**
   * "cuánto gasté este mes", "cuánto llevo en comida", "cuánto gasté en octubre". Si el texto
   * nombra una categoría, responde solo con ese total; si no, con el resumen del mes.
   */
  async function consultarGastos(chatId, texto) {
    const hoy = fechaHoySantiago();
    const criterio = interpretarBusqueda(texto, hoy);
    const fechaMes = criterio.desde ?? hoy;

    const norm = normalizar(texto);
    const categorias = (await listarCategorias())
      .filter(c => normalizar(c.nombre).length >= 3)
      .sort((a, b) => b.nombre.length - a.nombre.length);
    const categoria = categorias.find(c => new RegExp(`\\b${normalizar(c.nombre).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`).test(norm));

    if (!categoria) {
      await enviarGastosDelMes(chatId, fechaMes);
      return;
    }

    const r = await gastosDelMes(fechaMes);
    const fila = r.categorias.find(c => normalizar(c.categoria) === normalizar(categoria.nombre));
    const mesNombre = new Date(r.anio, r.mes - 1).toLocaleString('es-CL', { month: 'long' });
    const total = fila ? fila.total : 0;
    const pct = r.total > 0 ? Math.round(total / r.total * 100) : 0;
    await enviar(chatId,
      `En <b>${esc(categoria.nombre)}</b> llevas ${dinero(total)} en ${esc(mesNombre)} ${r.anio}` +
      (r.total > 0 ? ` (${pct}% de tus gastos del mes, ${dinero(r.total)} en total).` : '.')
    );
  }

  function configurarComandos() {
    // Ejecuta un comando solo para chats autorizados y sin dejar caer el servidor
    const comando = (regex, accion) => {
      bot.onText(regex, async (msg, match) => {
        const chatId = msg.chat.id;
        if (!esChatAutorizado(chatId)) {
          await noAutorizado(chatId);
          return;
        }
        try {
          await accion(chatId, (match[1] || '').trim());
        } catch (error) {
          errorBD('Error en un comando', error);
          await enviar(chatId, 'Ocurrió un error al procesar el comando.');
        }
      });
    };

    // /buscar <texto o mes>
    comando(/^\/buscar(?:@\w+)?(?:\s+([\s\S]+))?$/i, buscar);

    // /categorias
    comando(/^\/categorias(?:@\w+)?\s*$/i, async (chatId) => {
      const categorias = await listarCategorias();
      await enviar(chatId,
        categorias.length === 0
          ? 'No hay categorías. Crea una con /categoria nueva <nombre>.'
          : '<b>Categorías:</b>\n\n' + categorias.map((c, i) => `${i + 1}. ${esc(c.nombre)}`).join('\n') +
            '\n\nCrea una con /categoria nueva <nombre>.'
      );
    });

    // /categoria nueva <nombre>
    comando(/^\/categoria(?:@\w+)?(?:\s+([\s\S]+))?$/i, async (chatId, argumento) => {
      const nueva = /^nueva\s+(.+)$/i.exec(argumento);
      if (!nueva) {
        await enviar(chatId, '<b>Crear una categoría</b>\n\n/categoria nueva Mascotas');
        return;
      }
      const r = await crearCategoria(nueva[1]);
      await enviar(chatId, r.ok ? `Categoría creada: <b>${esc(r.categoria.nombre)}</b>.` : esc(r.error));
    });

    // /regla <texto> <categoría>  (sin argumentos: lista las reglas)
    comando(/^\/regla(?:@\w+)?(?:\s+([\s\S]+))?$/i, async (chatId, argumento) => {
      if (!argumento) {
        await enviarReglas(chatId);
        return;
      }

      const categorias = await listarCategorias();
      const { texto, categoria } = separarReglaYCategoria(argumento, categorias);
      if (!categoria || !texto) {
        await enviar(chatId,
          '<b>Crear una regla</b>\n\nEscribe el texto y la categoría, por ejemplo:\n/regla uber transporte\n\n' +
          `Categorías: ${categorias.map(c => esc(c.nombre)).join(', ')}`
        );
        return;
      }
      const r = await crearRegla(texto, categoria.id);
      await enviar(chatId,
        r.ok
          ? `Regla creada: los mensajes que contengan "${esc(texto.toLowerCase())}" se asignan a <b>${esc(categoria.nombre)}</b>.`
          : esc(r.error)
      );
    });

    // /gastos: gastos del mes por categoría y uso de cupo de las tarjetas de crédito
    comando(/^\/gastos(?:@\w+)?\s*$/i, (chatId) => enviarGastosDelMes(chatId, fechaHoySantiago()));

    // /deudas
    comando(/^\/deudas(?:@\w+)?\s*$/i, async (chatId) => {
      const pendientes = (await resumenDeudas()).filter(r => Math.abs(r.saldo) > 0.5).sort((a, b) => b.saldo - a.saldo);
      if (pendientes.length === 0) {
        await enviar(chatId, 'No tienes deudas pendientes.');
        return;
      }
      await enviar(chatId,
        '<b>Deudas pendientes:</b>\n\n' +
        pendientes
          .map(r => `${esc(r.persona)}: ${r.saldo > 0 ? 'te debe' : 'le debes'} ${dinero(Math.abs(r.saldo))}`)
          .join('\n') +
        '\n\nRegistra un pago con /pago <persona> <monto>.'
      );
    });

    // /pago <persona> <monto>
    comando(/^\/pago(?:@\w+)?(?:\s+([\s\S]+))?$/i, pedirConfirmacionPago);

    // /fijos
    comando(/^\/fijos(?:@\w+)?\s*$/i, listarFijos);
  }

  return { configurarComandos, manejarCallback, manejarTexto, mostrarUltimos, planConArgumentos, buscar, consultarGastos };
}
