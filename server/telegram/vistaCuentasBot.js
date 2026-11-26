/**
 * /cuentas (alias /datosguardados, "qué cuentas tengo", "qué datos tienes guardados"): en un mensaje
 * muestra lo que la app tiene registrado y, sobre todo, cómo está vinculado: por cada cuenta, su
 * titular, banco y tipo, la tarjeta terminada en XXXX vinculada a la cuenta terminada en YYYY, si es
 * la cuenta por defecto y cuántos movimientos y cartolas tiene. Debajo, las cuotas activas, el
 * titular por defecto, las categorías en uso y los totales de movimientos.
 *
 * Se corrige respondiendo al mensaje en lenguaje natural ("la tarjeta 1234 es de la cuenta 5678",
 * "esta es de Valeska", "la 2 es de Valeska"); siempre con confirmación por botones.
 *
 * Privacidad: solo se muestran y se aceptan los 4 últimos dígitos; un número más largo se rechaza.
 * Si en la BD quedó un número completo guardado, no se muestra y la vista lo avisa.
 *
 * Los textos de la BD (nombres, titulares) se escapan siempre. No usa Gemini.
 */

import { cargarResumen, fijarTitular, fijarDigitos } from '../resumenDatos.js';
import { ETIQUETAS_TIPO_DB, normalizar, valorTitular } from './cuentas.js';
import { buscarCuentaPorTexto } from './intenciones.js';
import { buscarBanco } from './cuentas.js';
import { resumenCompra, lineasPorTitular } from './cuotas.js';
import { fechaHoySantiago, formatearFechaCL } from './fechas.js';

const LIMITE_MENSAJE = 3800;
const VIGENCIA_VISTA_MS = 6 * 60 * 60 * 1000;
const ESPERA_CONFIRMACION_MS = 10 * 60 * 1000;

const TIPOS_CON_TARJETA = ['tarjeta_credito', 'tarjeta_debito'];
const TIPOS_CON_NUMERO = ['cuenta_corriente', 'cuenta_vista', 'cuenta_ahorro', 'tarjeta_debito'];

// ---------------------------------------------------------------------------
// Texto de la vista (funciones puras)
// ---------------------------------------------------------------------------

const dinero = (n) => `$${Math.round(Number(n)).toLocaleString('es-CL')}`;

/** Avisos de una cuenta: sin titular, vínculo que falta o datos que no se pueden mostrar */
export function avisosDeCuenta(c) {
  const avisos = [];
  if (c.tipo !== 'efectivo' && !c.titular) avisos.push('sin titular');
  if (c.numeroCompleto) avisos.push('hay un número completo guardado en cuentas.numero_cuenta; no lo muestro, hay que borrarlo');
  if (c.digitosInvalidos) avisos.push('los dígitos guardados no son exactamente 4; no los muestro');
  return avisos;
}

/** "Tarjeta terminada en X vinculada a la cuenta terminada en Y", o lo que falte (con Aviso si se esperaba) */
export function lineaVinculo(c) {
  if (c.tipo === 'efectivo') return 'Efectivo: no lleva tarjeta ni número de cuenta';
  const { ultimos4: tarjeta, ultimos4_cuenta: cuenta } = c;
  if (tarjeta && cuenta) return `Tarjeta terminada en ${tarjeta} vinculada a la cuenta terminada en ${cuenta}`;

  const sinTarjeta = TIPOS_CON_TARJETA.includes(c.tipo) ? 'Aviso: sin tarjeta vinculada' : 'sin tarjeta vinculada';
  const sinNumero = TIPOS_CON_NUMERO.includes(c.tipo) ? 'Aviso: sin número de cuenta vinculado' : 'sin número de cuenta vinculado';
  return [
    tarjeta ? `Tarjeta terminada en ${tarjeta}` : sinTarjeta,
    cuenta ? `Cuenta terminada en ${cuenta}` : sinNumero
  ].join(' · ');
}

/** Bloque de una cuenta (HTML ya escapado) */
export function bloqueCuenta(c, indice, { esDefecto = false } = {}, esc = (t) => t) {
  const lineas = [
    `<b>${indice}. ${esc(c.nombre)}</b>${esDefecto ? ' (cuenta por defecto)' : ''}`,
    `Titular: ${c.titular ? esc(c.titular) : 'sin titular'}`,
    `${c.banco ? `${esc(c.banco)} · ` : ''}${esc(ETIQUETAS_TIPO_DB[c.tipo] ?? c.tipo)}`,
    esc(lineaVinculo(c)),
    `Movimientos: ${c.movimientos} · Cartolas: ${c.cartolas}`
  ];
  for (const aviso of avisosDeCuenta(c)) lineas.push(`Aviso: ${esc(aviso)}`);
  return lineas.join('\n');
}

/** Línea de una compra en cuotas: descripción, titular, cuota actual de total, monto y próxima fecha */
export function lineaCuota(compra, hoy, esc = (t) => t) {
  const r = resumenCompra(compra, hoy);
  const cuota = r.proximaCuota ? `cuota ${r.proximaCuota} de ${r.total}` : `${r.total} cuotas, todas pagadas`;
  const proxima = r.proximaFecha ? `, próxima el ${formatearFechaCL(r.proximaFecha)}` : '';
  return `• <b>${esc(compra.alias)}</b> (titular: ${esc(compra.acreedor)}): ${cuota} (${r.pagadas} pagadas), ` +
    `${dinero(r.montoCuota)} por cuota${proxima}`;
}

/**
 * Arma los mensajes de la vista. `resumen` viene de cargarResumen(). Devuelve
 * [{ texto, cuentas: [{ indice, id }] }]: normalmente uno solo; si no cabe en un mensaje de
 * Telegram, varios en orden (la numeración de las cuentas sigue entre ellos).
 */
export function formatearVista(resumen, { defectoId = null, hoy = fechaHoySantiago(), titularDefecto = null } = {}, esc = (t) => t) {
  const activas = resumen.cuentas.filter(c => c.activa);
  const inactivas = resumen.cuentas.filter(c => !c.activa);

  if (activas.length === 0 && resumen.cuotas.length === 0) {
    return [{ texto: 'Todavía no tengo cuentas ni cuotas guardadas. Crea una cuenta con /savecard.', cuentas: [] }];
  }

  const mensajes = [];
  let actual = { partes: [], cuentas: [] };
  const largo = (m) => m.partes.join('\n\n').length;
  const cerrar = () => {
    if (actual.partes.length > 0) mensajes.push({ texto: actual.partes.join('\n\n'), cuentas: actual.cuentas });
    actual = { partes: [], cuentas: [] };
  };
  const agregar = (texto, cuenta = null) => {
    if (largo(actual) + texto.length + 2 > LIMITE_MENSAJE) cerrar();
    actual.partes.push(texto);
    if (cuenta) actual.cuentas.push(cuenta);
  };

  if (activas.length > 0) {
    agregar('<b>Cuentas y vínculos</b>');
    activas.forEach((c, i) => {
      agregar(bloqueCuenta(c, i + 1, { esDefecto: c.id === defectoId }, esc), { indice: i + 1, id: c.id, nombre: c.nombre });
    });
  } else {
    agregar('<b>Cuentas</b>\nTodavía no tengo cuentas guardadas.');
  }
  if (inactivas.length > 0) {
    agregar(`Desactivadas: ${inactivas.map(c => esc(c.nombre)).join(', ')}`);
  }

  if (resumen.cuotas.length > 0) {
    agregar(`<b>Cuotas activas</b>\n${resumen.cuotas.map(c => lineaCuota(c, hoy, esc)).join('\n')}`);
  } else {
    agregar('<b>Cuotas activas</b>\nTodavía no tengo cuotas guardadas.');
  }

  if ((resumen.titularesMes ?? []).length > 0) {
    agregar(`<b>Cuotas de este mes, por titular</b>\n${lineasPorTitular(resumen.titularesMes, dinero, esc).join('\n')}`);
  }

  const t = resumen.totales;
  agregar(
    '<b>Otros datos</b>\n' +
    `Titular por defecto: ${titularDefecto ? esc(titularDefecto) : 'sin definir'}\n` +
    `Categorías en uso: ${resumen.categorias.length > 0 ? resumen.categorias.map(n => esc(n)).join(', ') : 'ninguna todavía'}\n` +
    `Movimientos: ${t.movimientos}` +
    (t.primero ? ` (el primero del ${formatearFechaCL(t.primero)}, el último del ${formatearFechaCL(t.ultimo)})` : '')
  );

  if (activas.length > 0) {
    agregar(
      'Para corregir un dato, toca Editar o responde a este mensaje, por ejemplo: «la 2 es de Valeska», «cámbiale el nombre a X» ' +
      'o «la tarjeta 1234 es de la cuenta 5678». Solo los 4 últimos dígitos.'
    );
  }
  cerrar();
  return mensajes;
}

// ---------------------------------------------------------------------------
// Corrección en lenguaje natural (funciones puras)
// ---------------------------------------------------------------------------

const SEPARADOR_TITULAR = /\s+(?:es|era|pertenece|son)\s+(?:de|a)\s+/i;

/**
 * Interpreta lo que se responde a la vista. Devuelve:
 *   { accion: 'vincular', tarjeta, cuenta }                 "la tarjeta 1234 es de la cuenta 5678"
 *   { accion: 'titular', referencia, titular }              "esta es de Valeska", "la 2 es de Valeska"
 *   { accion: 'campo', campo: 'nombre'|'banco', referencia, valor }   "cámbiale el nombre a X", "la 2 es del banco de chile"
 *   { error: 'largo' }                                      se escribió un número de más de 4 dígitos
 *   null                                                    no se entendió
 * `referencia`: { tipo: 'esta' } | { tipo: 'indice', valor } | { tipo: 'digitos', valor, de: 'tarjeta'|'cuenta' }
 *               | { tipo: 'nombre', valor }
 */
export function interpretarCorreccionCuenta(texto) {
  const original = String(texto ?? '').trim();
  if (!original || original.startsWith('/')) return null;

  // Nunca se aceptan números largos (de tarjeta, cuenta o RUT): solo 4 dígitos
  if (/\d{5,}/.test(original.replace(/(?<=\d)[\s.-](?=\d)/g, ''))) return { error: 'largo' };

  const norm = normalizar(original).replace(/[¿?¡!.,;:«»"]/g, ' ').replace(/\s+/g, ' ').trim();

  // Vínculo tarjeta-cuenta, en cualquiera de los dos órdenes
  const prefijoT = '(?:la\\s+)?tarjeta\\s+(?:terminada\\s+en\\s+)?(\\d{4})';
  const prefijoC = '(?:la\\s+)?cuenta\\s+(?:terminada\\s+en\\s+)?(\\d{4})';
  const union = '(?:es\\s+de|va\\s+con|pertenece\\s+a|esta\\s+(?:ligada|vinculada)\\s+a|es\\s+la\\s+de|tiene|con)';
  let m = new RegExp(`^${prefijoT}\\s+${union}\\s+${prefijoC}$`).exec(norm);
  if (m) return { accion: 'vincular', tarjeta: m[1], cuenta: m[2] };
  m = new RegExp(`^${prefijoC}\\s+${union}\\s+${prefijoT}$`).exec(norm);
  if (m) return { accion: 'vincular', tarjeta: m[2], cuenta: m[1] };

  // Cambiar el nombre o el banco: "cámbiale el nombre a X", "cambia el nombre de la 2 a X", "la 2 es del banco de chile"
  const renombrar = /^\s*(?:cambia(?:le)?|c[aá]mbiale|pon(?:le)?|ponle)\s+(?:el\s+)?nombre\s+(?:(?:de|a)\s+(.+?)\s+)?(?:a|por|como)\s+(.+)$/i.exec(original);
  if (renombrar) {
    const nombre = renombrar[2].replace(/[¿?¡!.,;:]+$/g, '').trim();
    if (!nombre) return null;
    return { accion: 'campo', campo: 'nombre', referencia: referenciaDe(renombrar[1] ? limpiarIzquierda(renombrar[1]) : 'esta'), valor: nombre };
  }
  const esDelBanco = /^\s*(.+?)\s+es\s+(?:del?\s+|el\s+)?(banco\s+.+|.+)$/i.exec(original);
  if (esDelBanco) {
    const valor = esDelBanco[2].replace(/[¿?¡!.,;:]+$/g, '').trim();
    if (/^banco\b/i.test(valor) || buscarBanco(normalizar(valor))) {
      return { accion: 'campo', campo: 'banco', referencia: referenciaDe(limpiarIzquierda(esDelBanco[1])), valor };
    }
  }

  // Titular: "<cuál> es de <nombre>" o "titular <nombre>"
  const conTitular = /^(?:el\s+)?titular\s+(?:es\s+)?(.+)$/i.exec(original);
  let izquierda = null;
  let derecha = null;
  if (conTitular) {
    izquierda = 'esta';
    derecha = conTitular[1];
  } else {
    const partes = original.split(SEPARADOR_TITULAR);
    if (partes.length === 2) {
      izquierda = normalizar(partes[0]).replace(/[¿?¡!.,;:«»"]/g, ' ').replace(/\s+/g, ' ').trim();
      derecha = partes[1];
    }
  }
  if (izquierda === null || !derecha) return null;

  const titular = derecha.replace(/[¿?¡!.,;:«»"]/g, ' ').replace(/\s+/g, ' ').trim();
  if (!titular || /\d/.test(titular) || titular.length > 60) return null;

  const referencia = referenciaDe(izquierda);
  if (!referencia) return null;
  return { accion: 'titular', referencia, titular: valorTitular(titular) };
}

function limpiarIzquierda(texto) {
  return normalizar(texto).replace(/[¿?¡!.,;:«»"]/g, ' ').replace(/\s+/g, ' ').trim();
}

/** De qué cuenta se habla: "esta", "la 2", "la tarjeta 8263" o su nombre. null si no queda nada. */
function referenciaDe(izquierda) {
  let m;
  if (/^(?:esta|este|esa|ese)$/.test(izquierda)) return { tipo: 'esta' };
  if ((m = /^(?:la\s+)?(tarjeta|cuenta)\s+(?:terminada\s+en\s+)?(\d{4})$/.exec(izquierda))) return { tipo: 'digitos', valor: m[2], de: m[1] };
  if ((m = /^(?:la\s+)?(?:numero\s+)?(\d{1,2})$/.exec(izquierda))) return { tipo: 'indice', valor: Number(m[1]) };
  const nombre = izquierda.replace(/^(?:la|el|mi)\s+/, '').replace(/^(?:tarjeta|cuenta)\s+/, '').trim();
  return nombre ? { tipo: 'nombre', valor: nombre } : null;
}

/**
 * Qué cuenta nombra la referencia. `enVista` son las cuentas del mensaje respondido ({ indice, id });
 * `cuentas` todas las activas (con nombre, banco, tipo y dígitos). Devuelve { cuenta } | { ambiguas } | { error }.
 */
export function resolverReferencia(referencia, enVista, cuentas) {
  const porId = (id) => cuentas.find(c => c.id === id);
  if (referencia.tipo === 'esta') {
    if (enVista.length === 1) return { cuenta: porId(enVista[0].id) };
    return { error: 'Hay varias cuentas en ese mensaje: dime cuál, por ejemplo «la 2 es de Valeska» o «la FAN es de Valeska».' };
  }
  if (referencia.tipo === 'indice') {
    const en = enVista.find(v => v.indice === referencia.valor);
    return en ? { cuenta: porId(en.id) } : { error: `No hay una cuenta número ${referencia.valor} en ese mensaje.` };
  }
  if (referencia.tipo === 'digitos') {
    const campo = referencia.de === 'tarjeta' ? 'ultimos4' : 'ultimos4_cuenta';
    const halladas = cuentas.filter(c => c[campo] === referencia.valor);
    if (halladas.length === 1) return { cuenta: halladas[0] };
    return halladas.length > 1
      ? { ambiguas: halladas }
      : { error: `No encuentro una ${referencia.de} terminada en ${referencia.valor}.` };
  }
  const r = buscarCuentaPorTexto(referencia.valor, cuentas);
  if (r?.cuenta) return { cuenta: r.cuenta };
  if (r?.ambiguas) return { ambiguas: r.ambiguas };
  return { error: `No encuentro una cuenta que calce con «${referencia.valor.slice(0, 40)}».` };
}

/**
 * Qué cambiaría un vínculo "la tarjeta T es de la cuenta C". Devuelve { cambio: { cuenta, tipo, digitos } }
 * o { error }. Nunca fusiona dos cuentas distintas.
 */
export function planVinculo(tarjeta, cuentaDigitos, cuentas) {
  const dueñaDeLaCuenta = cuentas.find(c => c.ultimos4_cuenta === cuentaDigitos);
  const dueñaDeLaTarjeta = cuentas.find(c => c.ultimos4 === tarjeta);

  if (dueñaDeLaCuenta && dueñaDeLaTarjeta) {
    if (dueñaDeLaCuenta.id === dueñaDeLaTarjeta.id) return { error: 'Ya están vinculadas en la misma cuenta.' };
    return {
      error: `La tarjeta terminada en ${tarjeta} está en «${dueñaDeLaTarjeta.nombre}» y la cuenta terminada en ${cuentaDigitos} en ` +
        `«${dueñaDeLaCuenta.nombre}»: son cuentas distintas con sus propios movimientos y no las uno solo. ` +
        'Desactiva una (/borrarcuenta) y vuelve a intentarlo.'
    };
  }
  if (dueñaDeLaCuenta) return { cambio: { cuenta: dueñaDeLaCuenta, tipo: 'tarjeta', digitos: tarjeta } };
  if (dueñaDeLaTarjeta) return { cambio: { cuenta: dueñaDeLaTarjeta, tipo: 'cuenta', digitos: cuentaDigitos } };
  return { error: `No encuentro ninguna cuenta con tarjeta terminada en ${tarjeta} ni con número de cuenta terminado en ${cuentaDigitos}.` };
}

// ---------------------------------------------------------------------------
// Bot
// ---------------------------------------------------------------------------

export function crearVistaCuentas(ctx) {
  const { enviar, editar, responderCallback, esc } = ctx;
  // Cómo se elige la cuenta por defecto al registrar un gasto (la usa bot.js): (cuentasActivas) => cuenta | null
  const cuentaPorDefecto = ctx.cuentaPorDefecto ?? (async (cuentas) => cuentas[0] ?? null);

  // Mensajes de la vista a los que se puede responder: "chatId:messageId" -> { cuentas: [{ indice, id }], hasta }
  const vistas = new Map();
  // Correcciones esperando confirmación: clave -> { accion, ... }
  const pendientes = new Map();
  let contador = 0;

  const clave = (chatId, messageId) => `${chatId}:${messageId}`;

  function errorBD(contexto, error) {
    console.error(`${contexto}:`, error.code ?? error.name);
  }

  /** Cuentas activas con lo necesario para resolver nombres y dígitos */
  async function cuentasActivas() {
    return (await cargarResumen()).cuentas.filter(c => c.activa);
  }

  /** /cuentas: la vista completa */
  async function responder(chatId) {
    try {
      const resumen = await cargarResumen();
      const activas = resumen.cuentas.filter(c => c.activa);
      const defecto = activas.length > 0 ? await cuentaPorDefecto(activas) : null;
      const titularDefecto = (process.env.TITULAR_POR_DEFECTO || '').trim() || null;

      const mensajes = formatearVista(resumen, { defectoId: defecto?.id ?? null, titularDefecto }, esc);
      for (const m of mensajes) {
        // Un botón Editar por cada cuenta del mensaje (lo atiende /editarcuenta)
        const teclado = m.cuentas.length > 0
          ? { reply_markup: { inline_keyboard: m.cuentas.slice(0, 30).map(c => [{ text: `Editar ${c.indice}. ${c.nombre}`.slice(0, 40), callback_data: `ecs_${c.id}` }]) } }
          : undefined;
        const enviado = await enviar(chatId, m.texto, teclado);
        if (enviado?.message_id && m.cuentas.length > 0) {
          vistas.set(clave(chatId, enviado.message_id), { cuentas: m.cuentas, hasta: Date.now() + VIGENCIA_VISTA_MS });
        }
      }
    } catch (error) {
      errorBD('Error al armar la vista de cuentas', error);
      await enviar(chatId, 'No pude leer las cuentas. Inténtalo de nuevo.');
    }
    return true;
  }

  function pedirConfirmacion(chatId, datos, texto) {
    const key = `${chatId}_${Date.now()}_${contador++}`;
    pendientes.set(key, datos);
    setTimeout(() => pendientes.delete(key), ESPERA_CONFIRMACION_MS);
    return enviar(chatId, texto, {
      reply_markup: {
        inline_keyboard: [[
          { text: 'Guardar', callback_data: `cvg_${key}` },
          { text: 'Cancelar', callback_data: `cvx_${key}` }
        ]]
      }
    });
  }

  /**
   * Respuesta (reply) a un mensaje de la vista. Devuelve true si era un mensaje de la vista (aunque no
   * se haya entendido); false si no, para que el resto del bot siga como siempre.
   */
  async function manejarReply(msg) {
    const chatId = msg.chat.id;
    const respondido = msg.reply_to_message;
    if (!respondido || typeof msg.text !== 'string') return false;

    const k = clave(chatId, respondido.message_id);
    const vista = vistas.get(k);
    if (!vista) return false;
    if (Date.now() > vista.hasta) {
      vistas.delete(k);
      return false;
    }

    try {
      const r = interpretarCorreccionCuenta(msg.text);
      if (r?.error === 'largo') {
        await enviar(chatId, 'Solo necesito los 4 últimos dígitos, nunca el número completo. Escríbelos de nuevo con solo 4.');
        return true;
      }
      if (!r) {
        await enviar(chatId,
          'No entendí. Responde, por ejemplo: «la 2 es de Valeska», «esta es de Valeska» o «la tarjeta 1234 es de la cuenta 5678».'
        );
        return true;
      }

      const cuentas = await cuentasActivas();

      if (r.accion === 'vincular') {
        const plan = planVinculo(r.tarjeta, r.cuenta, cuentas);
        if (plan.error) {
          await enviar(chatId, esc(plan.error));
          return true;
        }
        const { cuenta, tipo, digitos } = plan.cambio;
        const actual = tipo === 'tarjeta' ? cuenta.ultimos4 : cuenta.ultimos4_cuenta;
        await pedirConfirmacion(chatId, { accion: 'digitos', cuentaId: cuenta.id, tipo, digitos },
          `¿Guardo ${tipo === 'tarjeta' ? 'la tarjeta' : 'el número de cuenta'} terminado en <b>${esc(digitos)}</b> en ` +
          `<b>${esc(cuenta.nombre)}</b>? Así queda la tarjeta terminada en ${esc(r.tarjeta)} vinculada a la cuenta terminada en ${esc(r.cuenta)}.` +
          (actual ? ` Reemplaza a •${esc(actual)}.` : '')
        );
        return true;
      }

      const resuelta = resolverReferencia(r.referencia, vista.cuentas, cuentas);
      if (r.accion === 'campo') {
        if (resuelta.error || resuelta.ambiguas) {
          await enviar(chatId, resuelta.error ? esc(resuelta.error) : `Hay varias cuentas que calzan: ${resuelta.ambiguas.map(c => esc(c.nombre)).join(', ')}. Usa el número de la lista, por ejemplo «cambia el nombre de la 2 a X».`);
          return true;
        }
        // El cambio se valida y se confirma con Guardar y Cancelar en /editarcuenta (mismo flujo y mismas reglas)
        await ctx.proponerCambioCuenta(chatId, resuelta.cuenta.id, r.campo, r.valor);
        return true;
      }
      if (resuelta.error) {
        await enviar(chatId, esc(resuelta.error));
        return true;
      }
      if (resuelta.ambiguas) {
        await enviar(chatId, `Hay varias cuentas que calzan: ${resuelta.ambiguas.map(c => esc(c.nombre)).join(', ')}. Usa el número de la lista, por ejemplo «la 2 es de ${esc(r.titular)}».`);
        return true;
      }
      const cuenta = resuelta.cuenta;
      await pedirConfirmacion(chatId, { accion: 'titular', cuentaId: cuenta.id, titular: r.titular },
        `¿Guardo a <b>${esc(r.titular)}</b> como titular de <b>${esc(cuenta.nombre)}</b>?` +
        (cuenta.titular ? ` Reemplaza a ${esc(cuenta.titular)}.` : '')
      );
      return true;
    } catch (error) {
      errorBD('Error al corregir un vínculo de cuenta', error);
      await enviar(chatId, 'No pude procesar eso. Inténtalo de nuevo.');
      return true;
    }
  }

  /** Botones de este módulo. Devuelve true si el callback era suyo. */
  async function manejarCallback(cb, chatId, data) {
    const m = data.match(/^cv([gx])_(.+)$/);
    if (!m) return false;
    const messageId = cb.message.message_id;
    const pendiente = pendientes.get(m[2]);
    pendientes.delete(m[2]);

    if (m[1] === 'x') {
      await editar('Cancelado', { chat_id: chatId, message_id: messageId });
      await responderCallback(cb.id, { text: 'Cancelado' });
      return true;
    }
    if (!pendiente) {
      await responderCallback(cb.id, { text: 'Solicitud expirada' });
      return true;
    }

    try {
      const guardado = pendiente.accion === 'titular'
        ? await fijarTitular(pendiente.cuentaId, pendiente.titular)
        : await fijarDigitos(pendiente.cuentaId, pendiente.tipo, pendiente.digitos);
      await editar(guardado ? 'Listo, lo guardé. Escribe /cuentas para ver cómo quedó.' : 'No pude guardarlo: la cuenta ya no está activa.',
        { chat_id: chatId, message_id: messageId });
      await responderCallback(cb.id, { text: guardado ? 'Guardado' : 'Sin cambios' });
    } catch (error) {
      errorBD('Error al guardar la corrección de una cuenta', error);
      await responderCallback(cb.id, { text: 'Error al guardar' });
    }
    return true;
  }

  return { responder, manejarReply, manejarCallback };
}
