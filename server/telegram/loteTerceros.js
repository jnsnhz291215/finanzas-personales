/**
 * Lote de una tarjeta ajena: la cartola de la tarjeta de crédito de otra persona (por ejemplo la tía
 * Valeska, con la que Juan paga un Mac en 12 cuotas) y la captura del comprobante de la transferencia
 * que Juan le hace cada mes. El bot lo entiende sin comandos:
 *
 *  1. La cartola se asocia a la cuenta con ese titular (por los 4 dígitos o el banco); si no existe,
 *     pregunta si la crea con el titular de la compra en cuotas.
 *  2. En la cartola se reconoce la cuota activa (número "06/12", descripción o monto) y solo se avanza
 *     el contador si corresponde: una cuota que ya estaba registrada no se duplica.
 *  3. Los demás cargos son de la otra persona. Se listan en UN mensaje y Juan marca cuáles son suyos
 *     (botones o "el 2 y el 5 son míos"). Solo esos se guardan como gastos suyos, en esa tarjeta; los
 *     demás NO se guardan (se ignoran), así no cuentan en sus totales.
 *  4. La captura del comprobante se lee con OCR local y se registra como el pago de la cuota (monto,
 *     fecha), ligado a la compra y a la cuenta de Juan de la que salió. Es el único registro del gasto:
 *     el cargo de la cartola no se guarda aparte, así que no se cuenta dos veces.
 *  5. Si el monto del comprobante no calza con la cuota, avisa y pregunta.
 *  6. Al final, un resumen corto.
 *
 * Privacidad: el OCR es local y el texto leído no se guarda ni se manda a ningún servicio. Nada de la
 * cartola va a Gemini desde aquí.
 */

import { listarCompras, obtenerCompra, registrarPagoCuota, crearCompra, fijarCuotasPagadas } from '../cuotas.js';
import { registrarImportacion, buscarUltimos4 } from '../cartolas.js';
import { confirmarTemporal, borrarTemporal } from '../storage.js';
import { leerTextoDeImagen } from '../ocr.js';
import { registrarPagosMultiples } from '../transferencias.js';
import { parsearComprobante, mencionaNombre } from './comprobante.js';
import {
  esTitularPropio,
  comprasDeTitular,
  acreedoresDe,
  reconocerCuota,
  evaluarNumeroCuota,
  extraerNumeroCuota,
  aliasDeCargo,
  buscarCompraSimilar,
  montosCalzan,
  parsearSeleccion,
  lineaCargo,
  textoResumenLote,
  esCargoBanco,
  tieneTasaInteres,
  nombreSugerido
} from './terceros.js';
import { registrarCargosVistos, posicionesRepetidas } from '../cargosCartola.js';
import { fechaHoySantiago, formatearFechaCL } from './fechas.js';

const ESPERA_CARTOLA_SOLO_FOTO_MS = 25 * 1000;
const ESPERA_CARTOLA_CON_ARCHIVO_MS = 110 * 1000;
const VIDA_LOTE_MS = 30 * 60 * 1000;
const MAX_BOTONES = 24;

async function consulta() {
  return (await import('../db.js')).query;
}

/** Cuentas activas con titular (para reconocer la tarjeta ajena y la cuenta de origen de un pago) */
async function cuentasActivas() {
  const query = await consulta();
  const [filas] = await query(
    'SELECT id, nombre, banco, tipo, ultimos4, ultimos4_cuenta, titular FROM cuentas WHERE activa = 1 ORDER BY nombre'
  );
  return filas.map(c => ({ ...c, id: Number(c.id) }));
}

export function crearLoteTerceros(ctx) {
  const { bot, enviar, editar, responderCallback, esc, formatearMonto, guardarRespaldo, eliminarRespaldo, descargarBuffer, resolverCuentaPago } = ctx;
  const vincular = ctx.vincularRegistro ?? (async () => {});

  const dinero = (n) => `$${formatearMonto(n)}`;
  // Un lote por chat: lo que llegó (cartola, comprobante) y en qué paso va cada parte
  const lotes = new Map();
  // Cartolas que esperan saber de quién son: clave -> { chatId, item, cuentas, candidato }
  const preguntas = new Map();
  // Cartolas de tarjetas ajenas que esperan a que termine la anterior: chatId -> [{ item, detectada, compra }]
  const colaCartolas = new Map();
  let contador = 0;

  function nuevoLote(chatId) {
    const anterior = lotes.get(chatId);
    if (anterior) {
      clearTimeout(anterior.timerEspera);
      clearTimeout(anterior.timerVida);
    }
    const lote = {
      chatId,
      titular: null,
      cuenta: null,
      compra: null,
      item: null,
      cuota: null,           // { alias, total, numero, accion, montoCargo, fechaCargo, estado }
      comprobante: null,     // { archivo, monto, fecha, compraId, cuentaId, mensajeUsuarioId }
      confirmacion: null,    // pago esperando "Guardar"
      pagoEstado: 'sin',     // sin | esperando | confirmando | registrado | cancelado | duplicada
      seleccionEstado: 'sin',// sin | pendiente | listo
      lista: null,           // { messageId, otros: [{ mov }], elegidos: Set }
      gastos: 0,
      otras: [],             // otras compras en cuotas creadas o actualizadas desde la cartola
      cuotasNuevas: [],      // cuotas de la cartola sin compra registrada: se ofrece crearla o ignorarla
      banco: [],             // cargos del banco (comisión, impuestos, intereses): nunca se marcan
      archivoVisto: anterior?.archivoVisto ?? 0,
      comprobanteEn: 0,
      timerEspera: null,
      timerVida: null
    };
    lote.timerVida = setTimeout(() => descartarLote(chatId), VIDA_LOTE_MS);
    lote.timerVida.unref?.();
    lotes.set(chatId, lote);
    return lote;
  }

  /** El lote vence: lo que quedó sin guardar se limpia (archivo temporal de la cartola y respaldo del comprobante) */
  async function descartarLote(chatId) {
    const lote = lotes.get(chatId);
    if (!lote) return;
    lotes.delete(chatId);
    clearTimeout(lote.timerEspera);
    if (lote.seleccionEstado === 'pendiente' && lote.item?.tmp) await borrarTemporal(lote.item.tmp);
    if (lote.comprobante?.archivo && ['esperando', 'confirmando'].includes(lote.pagoEstado)) {
      await eliminarRespaldo(lote.comprobante.archivo);
    }
    await seguirConLaCola(chatId);
  }

  const obtenerLote = (chatId) => lotes.get(chatId) ?? null;

  /** cartolasBot avisa cuando llega un archivo: así el comprobante espera a que la cartola se analice */
  function avisarArchivo(chatId) {
    const lote = obtenerLote(chatId) ?? nuevoLote(chatId);
    lote.archivoVisto = Date.now();
  }

  // -------------------------------------------------------------------------
  // Cartola
  // -------------------------------------------------------------------------

  /**
   * cartolasBot ofrece aquí cada cartola analizada antes de preguntar la cuenta. Devuelve true si la
   * tomó (es de otra persona) y false si es una cartola normal de Juan.
   * `ofrecerNormal(item)` devuelve la cartola al flujo de siempre.
   */
  async function procesarCartola(chatId, item, cuentas, ofrecerNormal) {
    try {
      const compras = await listarCompras();
      const todas = await cuentasActivas();
      const detectada = item.cuentaSugerida ? todas.find(c => c.id === Number(item.cuentaSugerida.id)) : null;

      // a) La cuenta detectada por los 4 dígitos o el banco tiene otro titular: es de esa persona
      if (detectada) {
        if (esTitularPropio(detectada.titular)) return false;
        // Varias compras del mismo titular: se elige la que se reconoce mejor en esta cartola (un cargo por compra)
        const delTitular = comprasDeTitular(compras, detectada.titular);
        let compra = delTitular[0] ?? null;
        let mejorPuntaje = -1;
        for (const candidata of delTitular) {
          const r = reconocerCuota(item.movimientos, candidata);
          if (r && r.puntaje > mejorPuntaje) {
            compra = candidata;
            mejorPuntaje = r.puntaje;
          }
        }
        // Una cartola de otro titular ya en curso: esta espera su turno (nunca se pisan)
        if (obtenerLote(chatId)?.item) {
          const espera = colaCartolas.get(chatId) ?? [];
          espera.push({ item, detectada, compra });
          colaCartolas.set(chatId, espera);
          await enviar(chatId, `Dejé en espera otra cartola de ${esc(detectada.titular)}: sigo con ella cuando termines la actual.`);
          return true;
        }
        await iniciarSeleccion(chatId, item, detectada, compra, detectada.titular);
        return true;
      }

      // b) Sin cuenta conocida: solo se interviene si en la cartola está la cuota de una compra en cuotas
      let mejor = null;
      for (const compra of compras) {
        const r = reconocerCuota(item.movimientos, compra);
        if (r && (!mejor || r.puntaje > mejor.r.puntaje)) mejor = { compra, r };
      }
      if (!mejor) return false;

      const key = `${chatId}_${Date.now()}_${contador++}`;
      preguntas.set(key, { chatId, item, cuentas, compra: mejor.compra, ofrecerNormal });
      setTimeout(() => preguntas.delete(key), 10 * 60 * 1000).unref?.();
      const cuotaTxt = mejor.r.numero ? ` (cuota ${mejor.r.numero} de ${mejor.compra.total_cuotas})` : '';
      await enviar(chatId,
        `Esta cartola trae la cuota de <b>${esc(mejor.compra.alias)}</b>${cuotaTxt}, que le pagas a <b>${esc(mejor.compra.acreedor)}</b>. ` +
        `¿Es la tarjeta de ${esc(mejor.compra.acreedor)}? Si es así, creo una cuenta con titular ${esc(mejor.compra.acreedor)} ` +
        'para guardar ahí los cargos que sean tuyos.',
        {
          reply_markup: {
            inline_keyboard: [
              [{ text: `Sí, crear cuenta de ${mejor.compra.acreedor}`.slice(0, 60), callback_data: `lcs_${key}` }],
              [{ text: 'Es mía', callback_data: `lcn_${key}` }, { text: 'Cancelar', callback_data: `lcx_${key}` }]
            ]
          }
        }
      );
      return true;
    } catch (error) {
      console.error('Error en la cartola de una tarjeta ajena:', error.code ?? error.name);
      return false;
    }
  }

  /** Crea la cuenta de la tarjeta ajena (crédito, con el titular) y sigue con la cartola */
  async function crearCuentaYSeguir(chatId, pregunta) {
    const { item, compra } = pregunta;
    const query = await consulta();
    const digitos = (item.ultimos4 ?? []).find(u => u.tipo === 'tarjeta')?.digitos ?? null;
    const [r] = await query(
      `INSERT INTO cuentas (nombre, tipo, banco, ultimos4, titular) VALUES (?, 'tarjeta_credito', ?, ?, ?)`,
      [`Tarjeta de ${compra.acreedor}`.slice(0, 150), item.banco ?? null, digitos, compra.acreedor]
    );
    const cuenta = { id: Number(r.insertId), nombre: `Tarjeta de ${compra.acreedor}`, titular: compra.acreedor };
    await iniciarSeleccion(chatId, item, cuenta, compra, compra.acreedor);
  }

  /** Reconoce la cuota, arma la lista de los demás cargos y la manda en un solo mensaje */
  async function iniciarSeleccion(chatId, item, cuenta, compra, titular) {
    const previo = obtenerLote(chatId);
    const comprobante = previo?.comprobante ?? null;
    const lote = nuevoLote(chatId);
    Object.assign(lote, { titular, cuenta, compra, item });
    if (comprobante) {
      lote.comprobante = comprobante;
      lote.pagoEstado = previo.pagoEstado;
      lote.comprobanteEn = previo.comprobanteEn;
    }

    // La cuota de la compra dentro de la cartola
    let indiceCuota = null;
    if (compra) {
      const r = reconocerCuota(item.movimientos, compra);
      if (r) {
        const mov = item.movimientos[r.indice];
        const eva = evaluarNumeroCuota(compra, r.numero);
        indiceCuota = r.indice;
        lote.cuota = {
          alias: compra.alias,
          total: Number(compra.total_cuotas),
          numero: eva.numero,
          accion: eva.accion,
          esperada: eva.esperada ?? null,
          montoCargo: Number(mov.monto),
          fechaCargo: String(mov.fecha).slice(0, 10),
          estado: eva.accion === 'duplicada' ? 'duplicada' : 'pendiente',
          // Si la cartola no calza con el contador (número menor o salto de más de una), se pregunta antes de cambiar
          consulta: eva.accion === 'menor' || eva.accion === 'salto',
          pagadas: Number(compra.cuotas_pagadas)
        };
      }
    }

    // Los demás cargos (los abonos no son gastos de nadie). Se separan los del banco (nunca se marcan) y las cuotas
    // (con número, con "TASA INT. x%" o la misma compra de otros meses): esas se cruzan con las compras en cuotas.
    const repetidas = await posicionesRepetidas(cuenta.id, item.hash, item.movimientos).catch(() => new Set());
    const cargos = item.movimientos
      .map((mov, i) => ({ mov, i }))
      .filter(({ mov, i }) => mov.tipo === 'cargo' && i !== indiceCuota);
    const delBanco = cargos.filter(({ mov }) => esCargoBanco(mov.descripcion));
    const sinBanco = cargos.filter(c => !delBanco.includes(c));
    const esCuota = ({ mov, i }) => Boolean(mov.cuota || extraerNumeroCuota(mov.descripcion) || tieneTasaInteres(mov.descripcion) || repetidas.has(i));
    const cuotasOtras = sinBanco.filter(esCuota);
    const otros = sinBanco.filter(c => !esCuota(c));
    lote.banco = delBanco;
    lote.lista = { messageId: null, otros, elegidos: new Set() };
    await atenderCuotas(lote, cuotasOtras);

    const encabezado = [`<b>Cartola de ${esc(titular)}</b>`];
    if (lote.cuota) {
      encabezado.push(
        `Reconocí la cuota de <b>${esc(lote.cuota.alias)}</b>: cuota ${lote.cuota.numero} de ${lote.cuota.total} ` +
        `(${dinero(lote.cuota.montoCargo)}, ${formatearFechaCL(lote.cuota.fechaCargo)}). ` +
        (lote.cuota.accion === 'duplicada'
          ? 'Esa cuota ya estaba registrada: no la duplico.'
          : lote.cuota.consulta
            ? `Ojo: en la app llevas ${compra.cuotas_pagadas} pagadas y la que toca es la ${lote.cuota.esperada}; te pregunto abajo cuál usar.`
            : 'Se registra con tu transferencia, no como gasto aparte.')
      );
    } else if (compra) {
      encabezado.push(`No encontré la cuota de ${esc(compra.alias)} en esta cartola.`);
    }

    if (otros.length === 0) {
      await enviar(chatId, encabezado.join('\n') + '\n\nNo hay otros cargos que revisar.');
      await finalizarCartola(chatId, []);
    } else {
      lote.seleccionEstado = 'pendiente';
      await enviar(chatId, encabezado.join('\n')); // el detalle va en el mensaje de la lista
      // Telegram acepta ~4.000 caracteres: si la lista es muy larga se corta (los que no se ven no se pueden marcar)
      const lineas = otros.map(({ mov }, n) => esc(lineaCargo(n + 1, mov)));
      let cuerpo = '';
      let mostrados = 0;
      for (const linea of lineas) {
        if (cuerpo.length + linea.length > 3000) break;
        cuerpo += `${linea}\n`;
        mostrados++;
      }
      if (mostrados < lineas.length) cuerpo += `... y ${lineas.length - mostrados} más que no se muestran (se tratan como de ${esc(titular)}).\n`;
      if (delBanco.length > 0) {
        cuerpo += `\n<b>Cargos del banco</b> (no se marcan)\n${delBanco.map(({ mov }) => `- ${esc(String(mov.descripcion).slice(0, 45))} ${dinero(mov.monto)}`).join('\n')}`;
      }
      lote.lista.otros = otros.slice(0, mostrados);
      const texto =
        `Estos cargos son de <b>${esc(titular)}</b> por defecto. ¿Cuáles son tuyos?\n` +
        `Toca los números${otros.length > MAX_BOTONES ? ' (los primeros ' + MAX_BOTONES + ')' : ''} o responde a este mensaje, por ejemplo «el 2 y el 5 son míos». ` +
        'Solo los que marques se guardan como gastos tuyos en esa tarjeta; los demás no se guardan y no cuentan en tus totales.\n\n' +
        cuerpo;
      const enviado = await enviar(chatId, texto, tecladoLista(lote));
      lote.lista.messageId = enviado?.message_id ?? null;
    }

    // Cuotas de la cartola que no calzan con ninguna compra: crearla como mía o ignorarla
    await ofrecerCuotasNuevas(chatId, lote);

    // La cartola no calza con el contador: se pregunta antes de cambiarlo
    if (lote.cuota?.consulta) {
      await enviar(chatId,
        `La cartola muestra la cuota <b>${lote.cuota.numero} de ${lote.cuota.total}</b> de ${esc(lote.cuota.alias)}, pero en la app llevas ` +
        `${lote.cuota.pagadas} pagadas (la que toca es la ${lote.cuota.esperada}). ¿Con cuál sincronizo el contador?`,
        {
          reply_markup: {
            inline_keyboard: [
              [{ text: `Usar la ${lote.cuota.numero}/${lote.cuota.total} de la cartola`, callback_data: 'lcy_s' }],
              [{ text: `Dejarlo como está (la ${lote.cuota.esperada})`, callback_data: 'lcy_n' }]
            ]
          }
        }
      );
    }

    if (lote.comprobante && lote.pagoEstado === 'esperando') await resolverPago(chatId);
  }

  function tecladoLista(lote) {
    const { otros, elegidos } = lote.lista;
    const botones = otros.slice(0, MAX_BOTONES).map((_, n) => ({
      text: elegidos.has(n + 1) ? `${n + 1} mío` : `${n + 1}`,
      callback_data: `lct_${n + 1}`
    }));
    const filas = [];
    for (let i = 0; i < botones.length; i += 4) filas.push(botones.slice(i, i + 4));
    filas.push([{ text: `Guardar mi selección (${elegidos.size})`, callback_data: 'lcg_s' }]);
    filas.push([
      { text: 'Todos son míos', callback_data: 'lca_s' },
      { text: 'Ninguno es mío', callback_data: 'lc0_s' }
    ]);
    return { reply_markup: { inline_keyboard: filas } };
  }

  /** Guarda como gastos de Juan solo los cargos elegidos (números de la lista) y registra la importación */
  async function finalizarCartola(chatId, elegidos) {
    const lote = obtenerLote(chatId);
    if (!lote?.item) return;
    const { item, cuenta, lista } = lote;

    try {
      const movimientos = elegidos.map(n => lista.otros[n - 1].mov);
      const ruta = await confirmarTemporal(item.tmp, 'cartolas', { prefijo: 'telegram_' });
      const { importados, archivoId, registrados } = await registrarImportacion({
        archivo: ruta,
        hash: item.hash,
        cuentaId: cuenta.id,
        movimientos,
        // Lo que no se marcó como mío no se guarda: queda contado para /estadocuenta
        resumen: {
          movimientosLeidos: item.movimientos,
          cargosLeidos: item.movimientos.filter(m => m.tipo === 'cargo').length,
          marcadosMios: movimientos.length,
          // Lo no marcado y los cargos del banco
          ignorados: Math.max(0, lista.otros.length - movimientos.length) + (lote.banco?.length ?? 0)
        }
      });
      // Se recuerdan los cargos leídos (también los no marcados) para reconocer las compras que se repiten cada mes
      await registrarCargosVistos(cuenta.id, item.hash, item.movimientos).catch(() => {});
      await vincular(chatId, [item.mensajeUsuarioId, lista?.messageId], 'importacion', archivoId);
      lote.gastos = importados;
      await sincronizarOtrasCuotas(lote, movimientos, registrados);
      lote.seleccionEstado = 'listo';
    } catch (error) {
      console.error('Error al guardar la cartola de una tarjeta ajena:', error.code ?? error.name);
      lote.seleccionEstado = 'listo';
      await enviar(chatId, 'No pude guardar esa cartola. El archivo sigue pendiente; envíalo de nuevo.');
      return cerrarSiListo(chatId);
    }

    await ofrecerPagoSinComprobante(chatId);
    await cerrarSiListo(chatId);
  }

  /** Sin comprobante: se ofrece registrar la cuota con el monto de la cartola (cuando ya no hay nada por preguntar) */
  async function ofrecerPagoSinComprobante(chatId) {
    const lote = obtenerLote(chatId);
    if (!lote?.cuota || lote.cuota.consulta || lote.seleccionEstado !== 'listo') return;
    if (lote.cuota.accion === 'duplicada' || lote.comprobante || lote.pagoEstado !== 'sin') return;

    lote.pagoEstado = 'confirmando';
    lote.confirmacion = { tipo: 'sin_comprobante' };
    await enviar(chatId,
      `No recibí el comprobante de tu transferencia a ${esc(lote.titular)}. ¿Registro la cuota ${lote.cuota.numero} de ${lote.cuota.total} ` +
      `de ${esc(lote.cuota.alias)} (${dinero(lote.cuota.montoCargo)}) ahora?`,
      {
        reply_markup: {
          inline_keyboard: [[
            { text: 'Sí, registrar', callback_data: 'lcr_s' },
            { text: 'No ahora', callback_data: 'lcr_n' }
          ]]
        }
      }
    );
  }

  /**
   * Cruza cada cuota de la cartola con las compras en cuotas de ese titular (mismo total y monto, o nombre parecido) y sincroniza el
   * contador (solo hacia adelante). Las que no calzan con ninguna quedan pendientes para ofrecer crearlas o ignorarlas.
   */
  async function atenderCuotas(lote, cuotas) {
    if (cuotas.length === 0) return;
    try {
      const existentes = await listarCompras({ incluirTerminadas: true });
      const delTitular = comprasDeTitular(existentes, lote.titular);
      for (const { mov } of cuotas) {
        const nc = mov.cuota ? { actual: mov.cuota.actual, total: mov.cuota.total } : extraerNumeroCuota(mov.descripcion);
        let compra = nc ? buscarCompraSimilar(delTitular, mov.descripcion, mov.monto, nc.total) : null;
        if (!compra) {
          const iguales = delTitular.filter(c => montosCalzan(c.monto_cuota, mov.monto) && (!nc || Number(c.total_cuotas) === nc.total));
          if (iguales.length === 1) compra = iguales[0];
        }
        if (compra && compra.id === lote.compra?.id) continue;

        if (compra) {
          let estado = 'igual';
          if (nc && nc.actual > Number(compra.cuotas_pagadas)) {
            compra = await fijarCuotasPagadas(compra.id, nc.actual);
            estado = 'actualizada';
          }
          lote.otras.push({
            alias: compra.alias, actual: nc?.actual ?? Number(compra.cuotas_pagadas), total: Number(compra.total_cuotas), estado,
            terminada: Boolean(compra.terminada)
          });
        } else {
          lote.cuotasNuevas.push({ mov, nc, alias: nombreSugerido(mov.descripcion), estado: 'pendiente', ofrecida: false });
        }
      }
    } catch (error) {
      console.error('Error al cruzar las cuotas de la cartola:', error.code ?? error.name);
    }
  }

  /** Pregunta, con botones, qué hacer con cada cuota que no calza con ninguna compra (crearla como mía o ignorarla) */
  async function ofrecerCuotasNuevas(chatId, lote) {
    const pendientes = lote.cuotasNuevas.map((c, k) => ({ c, k })).filter(({ c }) => c.estado === 'pendiente' && !c.ofrecida);
    for (const { c, k } of pendientes.slice(0, 8)) {
      c.ofrecida = true;
      const etiqueta = c.nc ? `${c.alias} ${c.nc.actual}/${c.nc.total}` : c.alias;
      const botones = [];
      if (c.nc) botones.push([{ text: `Crear «${c.alias}» (${c.nc.total} cuotas de ${dinero(c.mov.monto)}) como mía`.slice(0, 64), callback_data: `lcq_${k}` }]);
      botones.push([{ text: 'Ignorarla', callback_data: `lci_${k}` }]);
      await enviar(chatId,
        `Cuota sin compra registrada: <b>${esc(etiqueta)}</b> (${dinero(c.mov.monto)}, compra del ${formatearFechaCL(String(c.mov.fecha).slice(0, 10))}). ` +
        `¿La creo como una compra en cuotas tuya o la ignoro?` +
        (c.nc ? '' : ' No trae número de cuota, así que no puedo crearla sola.'),
        { reply_markup: { inline_keyboard: botones } }
      );
    }
    // Lo que no se alcanza a ofrecer no queda pendiente para siempre
    for (const c of lote.cuotasNuevas) if (c.estado === 'pendiente' && !c.ofrecida) c.estado = 'ignorada';
  }

  /** Selecciones o cartolas en espera que pertenecen a esa cuenta (para /resetcuenta) */
  function pendientesDeCuenta(cuentaId) {
    const id = Number(cuentaId);
    let n = 0;
    for (const lote of lotes.values()) if (lote.cuenta?.id === id && lote.seleccionEstado === 'pendiente') n++;
    for (const p of preguntas.values()) if (p.item?.cuentaSugerida?.id === id) n++;
    for (const lista of colaCartolas.values()) n += lista.filter(x => x.detectada?.id === id).length;
    return n;
  }

  /** Descarta esas selecciones y cartolas en espera (borra sus archivos temporales) */
  async function descartarPendientes(cuentaId) {
    const id = Number(cuentaId);
    for (const [chatId, lote] of [...lotes.entries()]) {
      if (lote.cuenta?.id !== id || lote.seleccionEstado !== 'pendiente') continue;
      clearTimeout(lote.timerVida);
      clearTimeout(lote.timerEspera);
      lotes.delete(chatId);
      if (lote.item?.tmp) await borrarTemporal(lote.item.tmp);
    }
    for (const [clave, p] of [...preguntas.entries()]) {
      if (p.item?.cuentaSugerida?.id !== id) continue;
      preguntas.delete(clave);
      if (p.item?.tmp) await borrarTemporal(p.item.tmp);
    }
    for (const [chatId, lista] of [...colaCartolas.entries()]) {
      const quedan = [];
      for (const x of lista) {
        if (x.detectada?.id === id) {
          if (x.item?.tmp) await borrarTemporal(x.item.tmp);
        } else quedan.push(x);
      }
      if (quedan.length > 0) colaCartolas.set(chatId, quedan);
      else colaCartolas.delete(chatId);
    }
  }

  /**
   * Una cartola que ya se había importado y se vuelve a mandar: no se duplica nada, solo se sincronizan las cuotas con las compras
   * en cuotas (y se ofrece crear las que no calzan). Devuelve true si la atendió.
   */
  async function sincronizarSoloCuotas(chatId, item, cuentaId) {
    try {
      const cuenta = (await cuentasActivas()).find(c => c.id === Number(cuentaId));
      if (!cuenta || esTitularPropio(cuenta.titular)) return false;
      const cuotas = item.movimientos
        .map((mov, i) => ({ mov, i }))
        .filter(({ mov }) => mov.tipo === 'cargo' && !esCargoBanco(mov.descripcion) && (mov.cuota || extraerNumeroCuota(mov.descripcion)));
      if (cuotas.length === 0 || obtenerLote(chatId)?.item) return false;

      const lote = obtenerLote(chatId) ?? nuevoLote(chatId);
      lote.titular = cuenta.titular;
      lote.cuenta = cuenta;
      await atenderCuotas(lote, cuotas);

      const lineas = ['Esta cartola ya estaba importada: no dupliqué nada, solo sincronicé las cuotas.'];
      for (const o of lote.otras) lineas.push(`${o.alias} ${o.actual}/${o.total}: ${o.estado === 'actualizada' ? 'contador actualizado' : 'al día'}`);
      if (lote.otras.length === 0 && lote.cuotasNuevas.length === 0) lineas.push('Ninguna cuota calzó con tus compras en cuotas.');
      await enviar(chatId, lineas.map(l => esc(l)).join('\n'));
      await ofrecerCuotasNuevas(chatId, lote);
      await cerrarSiListo(chatId);
      return true;
    } catch (error) {
      console.error('Error al sincronizar las cuotas de una cartola ya importada:', error.code ?? error.name);
      return false;
    }
  }

  /**
   * Los cargos que Juan marcó como suyos y que son una compra en cuotas ("TV 3/10"): crea la compra en cuotas o
   * actualiza la que ya existe (mismo total, monto por cuota y descripción parecida), sin duplicar, y liga el
   * movimiento a ella. La cuota actual de la cartola queda como las cuotas pagadas. Una compra que llega a su
   * total queda terminada.
   */
  async function sincronizarOtrasCuotas(lote, movimientos, registrados) {
    try {
      const query = await consulta();
      for (let i = 0; i < movimientos.length; i++) {
        const mov = movimientos[i];
        const nc = extraerNumeroCuota(mov.descripcion);
        if (!nc) continue;

        const existentes = await listarCompras({ incluirTerminadas: true });
        let compra = buscarCompraSimilar(comprasDeTitular(existentes, lote.titular), mov.descripcion, mov.monto, nc.total);
        let estado = 'igual';

        if (compra) {
          if (nc.actual > Number(compra.cuotas_pagadas)) {
            compra = await fijarCuotasPagadas(compra.id, nc.actual);
            estado = 'actualizada';
          }
        } else {
          const alias = aliasDeCargo(mov.descripcion);
          const creada = await crearCompra({
            alias,
            acreedor: lote.titular,
            montoCuota: mov.monto,
            totalCuotas: nc.total,
            cuotasPagadas: nc.actual,
            diaPago: Number(String(mov.fecha).slice(8, 10)) || null,
            aliasCartola: alias
          });
          if (!creada.ok) continue;
          compra = await obtenerCompra(creada.id);
          estado = 'nueva';
        }

        if (registrados?.[i]?.id) {
          await query('UPDATE movimientos SET compra_cuota_id = ?, numero_cuota = ? WHERE id = ?', [compra.id, nc.actual, registrados[i].id]);
        }
        lote.otras.push({
          alias: compra.alias, actual: nc.actual, total: nc.total, estado,
          terminada: nc.actual >= nc.total || Boolean(compra.terminada)
        });
      }
    } catch (error) {
      console.error('Error al sincronizar las cuotas de la cartola:', error.code ?? error.name);
    }
  }

  // -------------------------------------------------------------------------
  // Comprobante (captura de la transferencia)
  // -------------------------------------------------------------------------

  /**
   * Foto sin texto: se lee con OCR local. Si es el comprobante de una transferencia a la persona de una
   * compra en cuotas, queda como el pago de la cuota. Devuelve true si la atendió; false deja el flujo
   * normal de fotos.
   */
  async function manejarFoto(msg) {
    const chatId = msg.chat.id;
    if (!msg.photo || msg.caption) return false;

    try {
      const compras = await listarCompras();
      if (compras.length === 0) return false;

      const foto = msg.photo[msg.photo.length - 1];
      const texto = await leerTextoDeImagen(await descargarBuffer(foto.file_id));
      const lectura = parsearComprobante(texto);
      if (!lectura.esTransferencia) return false;

      // A qué compra corresponde: la persona nombrada en el comprobante; si no, la cuota con ese monto
      let candidatas = compras.filter(c => mencionaNombre(texto, c.acreedor));
      if (candidatas.length === 0) candidatas = compras.filter(c => montosCalzan(c.monto_cuota, lectura.monto));
      if (candidatas.length > 1) candidatas = candidatas.filter(c => montosCalzan(c.monto_cuota, lectura.monto));
      // Si no se puede decidir, el flujo normal pregunta de cuál compra es
      if (candidatas.length !== 1) return false;
      const compra = candidatas[0];

      // Cuenta de Juan de la que salió: por los dígitos o el banco que muestra el comprobante
      const cuentas = await cuentasActivas();
      const digitos = buscarUltimos4(texto).map(u => u.digitos);
      const origen = cuentas.find(c => digitos.includes(c.ultimos4) || digitos.includes(c.ultimos4_cuenta)) ?? null;

      const archivo = await guardarRespaldo(foto.file_id, `comprobante_${Date.now()}.jpg`, 'respaldo_cuota_');

      const lote = obtenerLote(chatId) ?? nuevoLote(chatId);
      lote.comprobante = {
        archivo,
        monto: lectura.monto,
        fecha: lectura.fecha ?? fechaHoySantiago(),
        fechaLeida: Boolean(lectura.fecha),
        compraId: Number(compra.id),
        cuentaId: origen?.id ?? null,
        mensajeUsuarioId: msg.message_id
      };
      lote.pagoEstado = 'esperando';
      lote.comprobanteEn = Date.now();

      await enviar(chatId,
        `Leí el comprobante: transferencia de ${dinero(lectura.monto)} para ${esc(compra.acreedor)} (${esc(compra.alias)}).` +
        (lote.cuota && lote.item ? '' : ' Espero un momento por si mandaste también la cartola.')
      );

      if (lote.cuota) await resolverPago(chatId);
      else armarEspera(chatId);
      return true;
    } catch (error) {
      console.error('Error al leer un comprobante:', error.code ?? error.name);
      return false;
    }
  }

  /** Espera a que llegue y se analice la cartola; si no llega, el pago se confirma con lo que se leyó */
  function armarEspera(chatId) {
    const lote = obtenerLote(chatId);
    if (!lote) return;
    clearTimeout(lote.timerEspera);
    lote.timerEspera = setTimeout(async () => {
      const l = obtenerLote(chatId);
      if (!l || l.pagoEstado !== 'esperando') return;
      const hayArchivo = l.archivoVisto && Date.now() - l.archivoVisto < ESPERA_CARTOLA_CON_ARCHIVO_MS;
      if (!l.cuota && hayArchivo && Date.now() - l.comprobanteEn < ESPERA_CARTOLA_CON_ARCHIVO_MS) {
        armarEspera(chatId);
        return;
      }
      await resolverPago(chatId);
    }, ESPERA_CARTOLA_SOLO_FOTO_MS);
    lote.timerEspera.unref?.();
  }

  /** Presenta el pago de la cuota para confirmar (o avisa del descuadre de montos y pregunta) */
  async function resolverPago(chatId) {
    const lote = obtenerLote(chatId);
    if (!lote?.comprobante || lote.pagoEstado !== 'esperando') return;
    // Si hay una pregunta sin responder sobre el número de cuota, se espera la respuesta
    if (lote.cuota?.consulta) return;
    clearTimeout(lote.timerEspera);

    // Con varias compras en cuotas de la misma persona, el monto se cruza con todas sus cuotas del mes
    const comprasTitular = lote.titular && ctx.transferencias ? comprasDeTitular(await listarCompras(), lote.titular) : [];
    if (comprasTitular.length > 1 && await resolverPagoMultiple(chatId, comprasTitular)) return;

    const c = lote.comprobante;
    const compra = await obtenerCompra(c.compraId);
    if (!compra || compra.terminada || Number(compra.activa) === 0) {
      lote.pagoEstado = 'cancelado';
      await eliminarRespaldo(c.archivo);
      await enviar(chatId, 'Esa compra en cuotas ya no está en curso, así que no registré el pago.');
      return cerrarSiListo(chatId);
    }

    // Qué cuota es: la de la cartola si la hay; si no, la siguiente a la última pagada
    const delLote = lote.cuota && lote.cuota.alias === compra.alias ? lote.cuota.numero : null;
    // Si Juan eligió usar el número de la cartola, el contador se sincroniza con ese número
    const forzar = lote.cuota?.accion === 'forzar' && delLote !== null && delLote !== Number(compra.cuotas_pagadas);
    const eva = forzar ? { accion: 'registrar', numero: delLote } : evaluarNumeroCuota(compra, delLote);
    if (eva.accion === 'duplicada') {
      lote.pagoEstado = 'duplicada';
      if (lote.cuota) lote.cuota.estado = 'duplicada';
      await eliminarRespaldo(c.archivo);
      await enviar(chatId,
        `La cuota ${eva.numero} de ${esc(compra.alias)} ya estaba registrada: no la dupliqué ni la conté otra vez como gasto.`
      );
      return cerrarSiListo(chatId);
    }
    const numero = eva.accion === 'salto' ? eva.esperada : eva.numero;
    if (numero > Number(compra.total_cuotas)) {
      lote.pagoEstado = 'cancelado';
      await eliminarRespaldo(c.archivo);
      await enviar(chatId, `${esc(compra.alias)} ya tiene pagadas todas sus cuotas.`);
      return cerrarSiListo(chatId);
    }

    // Cuenta de la que salió el dinero
    const cuentas = await cuentasActivas();
    let origen = cuentas.find(x => x.id === c.cuentaId) ?? null;
    const porDefecto = !origen;
    if (!origen) {
      const def = await resolverCuentaPago(null);
      origen = def ? cuentas.find(x => x.id === Number(def.id)) ?? def : null;
    }
    if (!origen) {
      lote.pagoEstado = 'cancelado';
      await eliminarRespaldo(c.archivo);
      await enviar(chatId, 'No tienes cuentas activas desde las que registrar el pago. Crea una con /savecard.');
      return cerrarSiListo(chatId);
    }

    const montoCuota = Number(compra.monto_cuota);
    const montoCargo = lote.cuota?.montoCargo ?? null;
    const descuadre = !montosCalzan(c.monto, montoCuota) || (montoCargo !== null && !montosCalzan(c.monto, montoCargo));

    lote.confirmacion = { tipo: 'pago', numero, forzar, compraId: compra.id, cuentaId: Number(origen.id), montoCuota, montoComprobante: c.monto };
    lote.pagoEstado = 'confirmando';

    const lineas = [
      `<b>Pago a ${esc(compra.acreedor)}</b>`,
      `Cuota ${numero} de ${compra.total_cuotas} de <b>${esc(compra.alias)}</b>`,
      `Comprobante: ${dinero(c.monto)} el ${formatearFechaCL(c.fecha)}${c.fechaLeida ? '' : ' (no pude leer la fecha: pongo hoy)'}`,
      `Sale de: ${esc(origen.nombre)}${porDefecto ? ' (tu cuenta por defecto: el comprobante no la mostraba)' : ''}`
    ];
    if (forzar) lineas.push(`El contador pasa de ${compra.cuotas_pagadas}/${compra.total_cuotas} a ${numero}/${compra.total_cuotas}, como dice la cartola.`);
    if (descuadre) {
      lineas.push(
        `<b>El monto no calza:</b> el comprobante dice ${dinero(c.monto)}, la cuota de ${esc(compra.alias)} es de ${dinero(montoCuota)}` +
        (montoCargo !== null && !montosCalzan(montoCargo, montoCuota) ? ` y la cartola muestra ${dinero(montoCargo)}` : '') +
        '. ¿Con cuál monto lo registro?'
      );
    }
    lineas.push('Es el único registro del gasto: no se cuenta otra vez.');

    const botones = descuadre
      ? [
          [{ text: `Registrar ${dinero(c.monto)} (comprobante)`.slice(0, 60), callback_data: 'lcp_c' }],
          ...(montosCalzan(c.monto, montoCuota) ? [] : [[{ text: `Registrar ${dinero(montoCuota)} (la cuota)`.slice(0, 60), callback_data: 'lcp_q' }]]),
          [{ text: 'Cancelar', callback_data: 'lcp_x' }]
        ]
      : [[{ text: 'Guardar', callback_data: 'lcp_c' }, { text: 'Cancelar', callback_data: 'lcp_x' }]];
    await enviar(chatId, lineas.join('\n'), { reply_markup: { inline_keyboard: botones } });
  }

  /**
   * La persona tiene varias compras en cuotas: el monto del comprobante se cruza con la cuota de cada una (una sola,
   * la suma de varias o todas). Si no calza, muestra la diferencia y deja marcar cuáles cubre. Cada cuota registrada
   * avanza su propio contador. Devuelve true si preguntó.
   */
  async function resolverPagoMultiple(chatId, comprasTitular) {
    const lote = obtenerLote(chatId);
    const c = lote.comprobante;
    const cuentas = await cuentasActivas();
    let origen = cuentas.find(x => x.id === c.cuentaId) ?? null;
    if (!origen) {
      const def = await resolverCuentaPago(null);
      origen = def ? cuentas.find(x => x.id === Number(def.id)) ?? def : null;
    }
    if (!origen) return false;

    lote.pagoEstado = 'confirmando';
    lote.confirmacion = { tipo: 'plan' };
    const preguntado = await ctx.transferencias.ofrecerPlan(chatId, {
      monto: c.monto,
      fecha: c.fecha,
      destinatario: lote.titular,
      compras: comprasTitular,
      textoSinVincular: 'Entendido: no registro el pago.',
      alCancelar: async () => {
        lote.pagoEstado = 'cancelado';
        lote.confirmacion = null;
        await eliminarRespaldo(c.archivo);
        await cerrarSiListo(chatId);
      },
      aplicar: async (cuotas) => {
        const ids = await registrarPagosMultiples(cuotas, { cuentaId: Number(origen.id), fecha: c.fecha, archivoRespaldo: c.archivo });
        await vincular(chatId, [c.mensajeUsuarioId], 'pago_cuota', ids[0]);
        const actualizadas = [];
        for (const q of cuotas) actualizadas.push(await obtenerCompra(q.compra.id));
        lote.pagoEstado = 'registrado';
        lote.confirmacion = null;
        const [primera, ...resto] = cuotas.map((q, i) => ({
          alias: q.compra.alias, numero: q.numero, total: Number(q.compra.total_cuotas), terminada: Boolean(actualizadas[i]?.terminada)
        }));
        lote.cuotaRegistrada = primera;
        for (const r of resto) lote.otras.push({ alias: r.alias, actual: r.numero, total: r.total, estado: 'pagada', terminada: r.terminada });
        await cerrarSiListo(chatId);
        return {
          ok: true,
          texto: `Pago registrado: ${cuotas.map(q => `${esc(q.compra.alias)} cuota ${q.numero}/${q.compra.total_cuotas} (${dinero(q.montoAplicado ?? q.monto)})`).join(', ')}. Respaldo adjunto.`
        };
      }
    });
    if (!preguntado) {
      lote.pagoEstado = 'esperando';
      lote.confirmacion = null;
    }
    return preguntado;
  }

  /** Registra el pago: movimiento de la transferencia ligado a la compra, y avanza el contador una vez */
  async function guardarPago(chatId, usarMonto, messageId = null) {
    const lote = obtenerLote(chatId);
    const conf = lote?.confirmacion;
    if (!conf || conf.tipo !== 'pago') return false;

    const compra = await obtenerCompra(conf.compraId);
    if (!compra) return false;
    // Revisión final contra duplicados: si mientras tanto se registró esa cuota, no se vuelve a sumar
    if (evaluarNumeroCuota(compra, conf.numero).accion === 'duplicada' && !conf.forzar) {
      lote.pagoEstado = 'duplicada';
      await eliminarRespaldo(lote.comprobante.archivo);
      await enviar(chatId, `La cuota ${conf.numero} de ${esc(compra.alias)} ya estaba registrada: no la dupliqué.`);
      await cerrarSiListo(chatId);
      return true;
    }

    const monto = usarMonto === 'q' ? conf.montoCuota : conf.montoComprobante;
    const { movimientoId } = await registrarPagoCuota({
      compraId: compra.id,
      numero: conf.numero,
      monto,
      cuentaId: conf.cuentaId,
      fecha: lote.comprobante.fecha,
      descripcion: `Cuota ${conf.numero}/${compra.total_cuotas} ${compra.alias} (${compra.acreedor})`,
      archivoRespaldo: lote.comprobante.archivo
    });
    await vincular(chatId, [lote.comprobante.mensajeUsuarioId], 'pago_cuota', movimientoId);
    // Sincronizado con la cartola: el contador queda exactamente en ese número (también si es menor)
    const despues = conf.forzar ? await fijarCuotasPagadas(compra.id, conf.numero) : await obtenerCompra(compra.id);

    lote.pagoEstado = 'registrado';
    lote.confirmacion = null;
    lote.cuotaRegistrada = { numero: conf.numero, total: Number(compra.total_cuotas), alias: compra.alias, terminada: Boolean(despues?.terminada) };
    if (lote.cuota) lote.cuota.estado = 'registrada';
    if (messageId) {
      await editar(
        `Pago registrado: cuota ${conf.numero} de ${compra.total_cuotas} de <b>${esc(compra.alias)}</b> ` +
        `(${dinero(monto)} a ${esc(compra.acreedor)}). Respaldo adjunto.` +
        (lote.cuotaRegistrada.terminada ? `\n<b>Con esta cuota terminas de pagar ${esc(compra.alias)}.</b>` : ''),
        { chat_id: chatId, message_id: messageId }
      );
    }
    await cerrarSiListo(chatId);
    return true;
  }

  /** Registra la cuota con el monto de la cartola cuando no hubo comprobante */
  async function guardarPagoSinComprobante(chatId, messageId = null) {
    const lote = obtenerLote(chatId);
    if (!lote?.cuota || lote.confirmacion?.tipo !== 'sin_comprobante') return false;
    const compra = await obtenerCompra(lote.compra.id);
    const cuenta = await resolverCuentaPago(null);
    if (!compra || !cuenta) return false;

    const forzar = lote.cuota.accion === 'forzar' && lote.cuota.numero !== Number(compra.cuotas_pagadas);
    const eva = forzar ? { accion: 'registrar', numero: lote.cuota.numero } : evaluarNumeroCuota(compra, lote.cuota.numero);
    if (eva.accion === 'duplicada') {
      lote.pagoEstado = 'duplicada';
      await enviar(chatId, `La cuota ${eva.numero} de ${esc(compra.alias)} ya estaba registrada: no la dupliqué.`);
      return cerrarSiListo(chatId);
    }
    const { movimientoId } = await registrarPagoCuota({
      compraId: compra.id,
      numero: eva.numero,
      monto: lote.cuota.montoCargo,
      cuentaId: Number(cuenta.id),
      fecha: fechaHoySantiago(),
      descripcion: `Cuota ${eva.numero}/${compra.total_cuotas} ${compra.alias} (${compra.acreedor})`,
      archivoRespaldo: null
    });
    await vincular(chatId, [], 'pago_cuota', movimientoId);
    const despues = forzar ? await fijarCuotasPagadas(compra.id, eva.numero) : await obtenerCompra(compra.id);
    lote.pagoEstado = 'registrado';
    lote.confirmacion = null;
    lote.cuotaRegistrada = { numero: eva.numero, total: Number(compra.total_cuotas), alias: compra.alias, terminada: Boolean(despues?.terminada) };
    lote.cuota.estado = 'registrada';
    if (messageId) {
      await editar(
        `Cuota ${eva.numero} de ${compra.total_cuotas} de <b>${esc(compra.alias)}</b> registrada (${dinero(lote.cuota.montoCargo)}).` +
        (lote.cuotaRegistrada.terminada ? `\n<b>Con esta cuota terminas de pagar ${esc(compra.alias)}.</b>` : ''),
        { chat_id: chatId, message_id: messageId }
      );
    }
    await cerrarSiListo(chatId);
    return true;
  }

  // -------------------------------------------------------------------------
  // Resumen
  // -------------------------------------------------------------------------

  /** Cuando no queda nada pendiente, un resumen corto del lote (solo si hubo cartola) */
  async function cerrarSiListo(chatId) {
    const lote = obtenerLote(chatId);
    if (!lote) return;
    const pendiente = lote.seleccionEstado === 'pendiente' || lote.cuotasNuevas?.some(c => c.estado === 'pendiente') || Boolean(lote.cuota?.consulta) || ['esperando', 'confirmando'].includes(lote.pagoEstado);
    if (pendiente) return;

    if (lote.item) {
      const cuota = lote.cuotaRegistrada
        ? { estado: 'registrada', ...lote.cuotaRegistrada }
        : lote.cuota
          ? { estado: lote.cuota.estado, numero: lote.cuota.numero, total: lote.cuota.total, alias: lote.cuota.alias }
          : null;
      const pago = lote.pagoEstado === 'registrado' ? 'registrado' : lote.pagoEstado === 'cancelado' ? 'cancelado' : lote.comprobante ? 'cancelado' : 'sin';
      await enviar(chatId, esc(textoResumenLote({ titular: lote.titular, cuota, gastos: lote.gastos, pago, otras: lote.otras })));
    }
    clearTimeout(lote.timerVida);
    clearTimeout(lote.timerEspera);
    lotes.delete(chatId);
    await seguirConLaCola(chatId);
  }

  /** Termina un lote: sigue con la próxima cartola ajena que estaba esperando */
  async function seguirConLaCola(chatId) {
    const espera = colaCartolas.get(chatId);
    const siguiente = espera?.shift();
    if (espera && espera.length === 0) colaCartolas.delete(chatId);
    if (siguiente) await iniciarSeleccion(chatId, siguiente.item, siguiente.detectada, siguiente.compra, siguiente.detectada.titular);
  }

  // -------------------------------------------------------------------------
  // Respuestas y botones
  // -------------------------------------------------------------------------

  /** Responder a la lista de cargos: "el 2 y el 5 son míos", "todos", "ninguno" */
  async function manejarReply(msg) {
    const chatId = msg.chat.id;
    const lote = obtenerLote(chatId);
    if (!lote?.lista || lote.seleccionEstado !== 'pendiente' || typeof msg.text !== 'string') return false;
    if (msg.reply_to_message?.message_id !== lote.lista.messageId) return false;

    const total = lote.lista.otros.length;
    const sel = parsearSeleccion(msg.text, total);
    if (!sel) {
      await enviar(chatId, 'No entendí cuáles son tuyos. Responde, por ejemplo: «el 2 y el 5 son míos», «todos» o «ninguno».');
      return true;
    }
    if (sel.error) {
      await enviar(chatId, esc(sel.error));
      return true;
    }
    const elegidos = sel.todos ? lote.lista.otros.map((_, n) => n + 1) : sel.ninguno ? [] : sel.indices;
    await aplicarSeleccion(chatId, elegidos);
    return true;
  }

  async function aplicarSeleccion(chatId, elegidos) {
    const lote = obtenerLote(chatId);
    if (!lote?.lista) return;
    const { messageId } = lote.lista;
    await finalizarCartola(chatId, elegidos);
    if (messageId) {
      await editar(
        `Listo: guardé ${elegidos.length} ${elegidos.length === 1 ? 'cargo' : 'cargos'} como tuyos. ` +
        `Los demás son de ${esc(lote.titular ?? 'la otra persona')}: no se guardaron y no cuentan en tus totales.`,
        { chat_id: chatId, message_id: messageId }
      );
    }
  }

  /** Botones de este módulo. Devuelve true si el callback era suyo. */
  async function manejarCallback(cb, chatId, data) {
    const m = data.match(/^lc([a-z0-9])_(.+)$/);
    if (!m) return false;
    const tipo = m[1];
    const valor = m[2];
    const messageId = cb.message.message_id;

    try {
      // ¿De quién es la cartola?
      if (['s', 'n', 'x'].includes(tipo) && preguntas.has(valor)) {
        const pregunta = preguntas.get(valor);
        preguntas.delete(valor);
        if (tipo === 's') {
          await editar('Creando la cuenta...', { chat_id: chatId, message_id: messageId });
          await responderCallback(cb.id, {});
          await crearCuentaYSeguir(chatId, pregunta);
        } else if (tipo === 'n') {
          await editar('Entendido: es tuya.', { chat_id: chatId, message_id: messageId });
          await responderCallback(cb.id, {});
          await pregunta.ofrecerNormal(pregunta.item);
        } else {
          await borrarTemporal(pregunta.item.tmp);
          await editar('Cancelado. Descarté el archivo.', { chat_id: chatId, message_id: messageId });
          await responderCallback(cb.id, { text: 'Cancelado' });
        }
        return true;
      }

      const lote = obtenerLote(chatId);
      if (!lote) {
        await responderCallback(cb.id, { text: 'Solicitud expirada' });
        return true;
      }

      // Marcar o desmarcar un cargo
      if (tipo === 't' && lote.lista && lote.seleccionEstado === 'pendiente') {
        const n = Number(valor);
        if (lote.lista.elegidos.has(n)) lote.lista.elegidos.delete(n);
        else lote.lista.elegidos.add(n);
        // Solo se cambian los botones (no el texto, que ya perdió su formato al volver de Telegram)
        await bot.editMessageReplyMarkup(tecladoLista(lote).reply_markup, { chat_id: chatId, message_id: messageId }).catch(() => {});
        await responderCallback(cb.id, {});
        return true;
      }
      if ((tipo === 'g' || tipo === '0' || tipo === 'a') && lote.lista && lote.seleccionEstado === 'pendiente') {
        await responderCallback(cb.id, {});
        const todos = lote.lista.otros.map((_, n) => n + 1);
        await aplicarSeleccion(chatId, tipo === '0' ? [] : tipo === 'a' ? todos : [...lote.lista.elegidos].sort((a, b) => a - b));
        return true;
      }

      // Una cuota sin compra registrada: crearla como mía o ignorarla
      if ((tipo === 'q' || tipo === 'i') && lote.cuotasNuevas?.[Number(valor)]?.estado === 'pendiente') {
        const c = lote.cuotasNuevas[Number(valor)];
        await responderCallback(cb.id, {});
        if (tipo === 'i') {
          c.estado = 'ignorada';
          await editar(`Ignoré la cuota de ${esc(c.alias)}.`, { chat_id: chatId, message_id: messageId });
        } else {
          const creada = await crearCompra({
            alias: c.alias,
            acreedor: lote.titular,
            montoCuota: c.mov.monto,
            totalCuotas: c.nc.total,
            cuotasPagadas: c.nc.actual,
            diaPago: Number(String(c.mov.fecha).slice(8, 10)) || null,
            aliasCartola: c.alias
          });
          if (!creada.ok) {
            await editar('No pude crear la compra en cuotas.', { chat_id: chatId, message_id: messageId });
            return true;
          }
          c.estado = 'creada';
          lote.otras.push({ alias: c.alias, actual: c.nc.actual, total: c.nc.total, estado: 'nueva', terminada: c.nc.actual >= c.nc.total });
          await editar(`Creé la compra en cuotas <b>${esc(c.alias)}</b>: ${c.nc.actual} de ${c.nc.total}, cuota de ${dinero(c.mov.monto)}.`, { chat_id: chatId, message_id: messageId });
        }
        await cerrarSiListo(chatId);
        return true;
      }

      // La cartola no calza con el contador: usar su número o dejarlo como está
      if (tipo === 'y' && lote.cuota?.consulta) {
        await responderCallback(cb.id, {});
        lote.cuota.consulta = false;
        if (valor === 's') {
          lote.cuota.accion = 'forzar';
        } else {
          lote.cuota.accion = 'registrar';
          lote.cuota.numero = lote.cuota.esperada;
        }
        await editar(
          valor === 's'
            ? `Listo: el contador de ${esc(lote.cuota.alias)} se sincroniza con la cartola (${lote.cuota.numero}/${lote.cuota.total}) al registrar el pago.`
            : `Listo: dejo el contador como está y registro la cuota ${lote.cuota.numero}.`,
          { chat_id: chatId, message_id: messageId }
        );
        if (lote.comprobante && lote.pagoEstado === 'esperando') await resolverPago(chatId);
        else await ofrecerPagoSinComprobante(chatId);
        await cerrarSiListo(chatId);
        return true;
      }

      // Pago con comprobante: Guardar / otro monto / Cancelar
      if (tipo === 'p' && lote.confirmacion?.tipo === 'pago') {
        await responderCallback(cb.id, {});
        if (valor === 'x') {
          lote.pagoEstado = 'cancelado';
          lote.confirmacion = null;
          await eliminarRespaldo(lote.comprobante.archivo);
          await editar('Cancelado: no registré el pago.', { chat_id: chatId, message_id: messageId });
          await cerrarSiListo(chatId);
        } else {
          await editar('Registrando el pago...', { chat_id: chatId, message_id: messageId });
          await guardarPago(chatId, valor, messageId);
        }
        return true;
      }

      // Pago sin comprobante
      if (tipo === 'r' && lote.confirmacion?.tipo === 'sin_comprobante') {
        await responderCallback(cb.id, {});
        if (valor === 's') {
          await editar('Registrando la cuota...', { chat_id: chatId, message_id: messageId });
          await guardarPagoSinComprobante(chatId, messageId);
        } else {
          lote.pagoEstado = 'sin';
          lote.confirmacion = null;
          await editar('Entendido: la cuota queda sin registrar.', { chat_id: chatId, message_id: messageId });
          await cerrarSiListo(chatId);
        }
        return true;
      }

      await responderCallback(cb.id, { text: 'Solicitud expirada' });
      return true;
    } catch (error) {
      console.error('Error en un botón de la tarjeta ajena:', error.code ?? error.name);
      await responderCallback(cb.id, { text: 'Error' });
      return true;
    }
  }

  return { avisarArchivo, procesarCartola, sincronizarSoloCuotas, pendientesDeCuenta, descartarPendientes, manejarFoto, manejarReply, manejarCallback, acreedoresDe };
}
