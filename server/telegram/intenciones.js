/**
 * Enrutador de intenciones: entiende un mensaje libre (sin /comando) y lo manda a la función que
 * ya existe. Primero reglas rápidas (sin tildes ni mayúsculas) y, si no alcanzan, Gemini con un
 * prompt corto. Los comandos siguen funcionando como respaldo.
 *
 * Intenciones: registrar, pagar_cuota, nueva_compra_cuotas, consultar_gastos, plan,
 * datos_transferencia, cuentas, cuotas_pendientes, buscar y ayuda.
 *
 * Privacidad: a Gemini nunca viaja nada de datos de transferencia, RUT, correos ni números de
 * cuenta. Si el mensaje parece contener algo así, ni siquiera se consulta (puedeEnviarseAGemini).
 * Guardar cuentas y datos de transferencia sigue siendo solo por comando (/savecard, /savetrans).
 *
 * Si la intención es ambigua o falta un dato, el bot pregunta con botones en vez de adivinar. Lo que
 * escribe en la BD siempre pasa por una confirmación; cuando la confianza es baja (la intención la
 * dedujo Gemini) esa confirmación agrega el botón "Corregir".
 */

import { analizarMonto, parsearMontoExacto } from './parser.js';
import { detectarConsultaDatos, terminoDesdeTexto } from './datosTransferencia.js';
import { detectarConsultaPlan } from '../planAhorro.js';
import { parsearPagoCuota, detectarAltaCuotas, detectarConsultaCuotas } from './cuotas.js';
import { normalizar } from './cuentas.js';
import { interpretarIntencion, geminiDisponible } from './gemini.js';

const ESPERA_MS = 10 * 60 * 1000;

// Códigos cortos para callback_data
const CODIGOS = {
  registrar: 're',
  pagar_cuota: 'pc',
  nueva_compra_cuotas: 'nc',
  consultar_gastos: 'cg',
  plan: 'pl',
  datos_transferencia: 'dt',
  cuentas: 'ct',
  cuotas_pendientes: 'cp',
  buscar: 'bs',
  ayuda: 'ay'
};
const INTENCION_POR_CODIGO = Object.fromEntries(Object.entries(CODIGOS).map(([i, c]) => [c, i]));

const ETIQUETAS = {
  registrar: 'Registrar un gasto o ingreso',
  consultar_gastos: 'Ver mis gastos del mes',
  plan: 'Ver cuánto puedo gastar',
  cuotas_pendientes: 'Ver mis cuotas',
  cuentas: 'Ver mis cuentas',
  ayuda: 'Qué puedes hacer'
};

// ---------------------------------------------------------------------------
// Reglas rápidas (funciones puras)
// ---------------------------------------------------------------------------

// Palabras de relleno al buscar movimientos ("busca uber de octubre" -> "uber octubre")
const RELLENO_BUSQUEDA = new Set([
  'de', 'del', 'en', 'el', 'la', 'los', 'las', 'mis', 'mi', 'movimientos', 'movimiento', 'gastos', 'gasto',
  'compras', 'pagos', 'que', 'dicen', 'digan', 'con', 'por', 'favor'
]);

/** Quita palabras de relleno de una búsqueda libre y deja el texto y el mes */
export function limpiarBusqueda(texto) {
  return String(texto ?? '')
    .split(/\s+/)
    .filter(p => p && !RELLENO_BUSQUEDA.has(normalizar(p)))
    .join(' ')
    .trim();
}

/**
 * Clasifica un mensaje con reglas. Devuelve { intencion, datos, confianza: 'alta', origen: 'reglas' }
 * o null si ninguna regla alcanza. Función pura.
 */
export function clasificarPorReglas(texto) {
  const original = String(texto ?? '').trim();
  if (!original || original.startsWith('/')) return null;

  const norm = normalizar(original).replace(/[¿?¡!]/g, ' ').replace(/\s+/g, ' ').trim();
  const hayMonto = Boolean(analizarMonto(original));
  const resultado = (intencion, datos = {}) => ({ intencion, datos, confianza: 'alta', origen: 'reglas' });

  // Pedidos sin monto
  if (!hayMonto) {
    if (/\b(que puedes hacer|que sabes hacer|para que sirves|como te uso|como funciona|que haces|ayuda|help)\b/.test(norm)) {
      return resultado('ayuda');
    }
    if (/\b(?:que|cuales)\s+cuentas\s+(?:tengo|hay|activas)\b|\bmis\s+cuentas\b|\bcuentas\s+(?:activas|que\s+tengo)\b|\b(?:lista(?:me)?|muestrame|ver)\s+(?:las\s+|mis\s+)?cuentas\b/.test(norm)) {
      return resultado('cuentas');
    }
  }

  const consultaDatos = detectarConsultaDatos(original);
  if (consultaDatos) return resultado('datos_transferencia', { termino: consultaDatos.termino });

  if (detectarConsultaPlan(original)) return resultado('plan');

  if (parsearPagoCuota(original)) return resultado('pagar_cuota', { texto: original });
  if (detectarAltaCuotas(original)) return resultado('nueva_compra_cuotas', { texto: original });
  if (detectarConsultaCuotas(original)) return resultado('cuotas_pendientes', { texto: original });
  if (!hayMonto && /\b(?:mis\s+cuotas|cuotas\s+pendientes|que\s+cuotas\s+(?:tengo|debo|me\s+quedan)|compras\s+en\s+cuotas)\b/.test(norm)) {
    return resultado('cuotas_pendientes', { lista: true });
  }

  if (!hayMonto) {
    const buscar = /^(?:busca(?:me)?|buscar|encuentra(?:me)?|muestrame(?:\s+los)?\s+movimientos(?:\s+de)?)\s+(.+)$/.exec(norm);
    if (buscar) {
      // Se conserva el texto original (con tildes) sin el verbo del comienzo
      const sinVerbo = original.replace(/^\s*(?:busca(?:me)?|buscar|encuentra(?:me)?|mu[eé]strame(?:\s+los)?\s+movimientos(?:\s+de)?)\s+/i, '');
      return resultado('buscar', { texto: limpiarBusqueda(sinVerbo) });
    }

    if (
      /\bcuanto\s+(?:he\s+|hemos\s+)?(?:gaste|gastado|gastamos|llevo|llevamos)\b/.test(norm) ||
      /\b(?:mis\s+)?gastos\s+(?:del?\s+)?(?:este\s+)?mes\b|\btotal\s+de\s+gastos\b/.test(norm)
    ) {
      return resultado('consultar_gastos', { texto: original });
    }
  }

  // Un monto sin ninguna otra intención: un gasto o un ingreso
  if (hayMonto) return resultado('registrar');

  return null;
}

/**
 * ¿Se puede mandar este mensaje a Gemini sin riesgo? Nunca si parece traer datos de transferencia,
 * RUT, correos o números de cuenta.
 */
export function puedeEnviarseAGemini(texto) {
  const t = String(texto ?? '');
  const norm = normalizar(t);
  if (/@/.test(t)) return false;
  if (/\b(rut|r\.u\.t|titular|datos de transferencia|savetrans|numero de cuenta|n[°º]\s*de\s*cuenta)\b/.test(norm)) return false;
  if (/\bcuenta\s+(?:corriente|vista|rut|de\s+ahorro)\b/.test(norm)) return false;
  if (/\b\d{1,2}(?:\.\d{3}){2}-[\dkK]\b|\b\d{7,8}-[\dkK]\b/.test(t)) return false;
  if (/\d(?:[ -]?\d){12,18}/.test(t) || /\d{9,}/.test(t)) return false;
  return true;
}

// ---------------------------------------------------------------------------
// Enrutador
// ---------------------------------------------------------------------------

export function crearIntenciones(ctx) {
  const { enviar, editar, responderCallback, esc } = ctx;

  // Mensajes que esperan que el usuario elija la intención: clave -> { texto }
  const preguntas = new Map();
  // Chat al que se le pidió el monto de un gasto: chatId -> { texto, hasta }
  const esperandoMonto = new Map();
  let contador = 0;

  const nuevaClave = (chatId) => `${chatId}_${Date.now()}_${contador++}`;

  /** Pregunta con botones qué quiso hacer el usuario (nunca se adivina) */
  async function preguntarIntencion(chatId, texto, sugerida = null) {
    const key = nuevaClave(chatId);
    preguntas.set(key, { texto });
    setTimeout(() => preguntas.delete(key), ESPERA_MS);

    const candidatas = Object.keys(ETIQUETAS);
    if (sugerida && ETIQUETAS[sugerida]) {
      candidatas.splice(candidatas.indexOf(sugerida), 1);
      candidatas.unshift(sugerida);
    }

    await enviar(chatId, 'No estoy seguro de qué quieres hacer con ese mensaje. ¿Qué prefieres?', {
      reply_markup: {
        inline_keyboard: [
          ...candidatas.map(i => [{ text: ETIQUETAS[i], callback_data: `inte_${key}_${CODIGOS[i]}` }]),
          [{ text: 'Cancelar', callback_data: `intx_${key}` }]
        ]
      }
    });
    return true;
  }

  /** Falta el monto de un gasto o ingreso: se pregunta y se espera la respuesta */
  async function preguntarMonto(chatId, texto) {
    esperandoMonto.set(chatId, { texto, hasta: Date.now() + ESPERA_MS });
    await enviar(chatId, '¿De cuánto fue? Escribe el monto (por ejemplo 5.500 o 5 lucas).', {
      reply_markup: { inline_keyboard: [[{ text: 'Cancelar', callback_data: 'intm_x' }]] }
    });
    return true;
  }

  /** Ejecuta una intención ya decidida. Devuelve true si el mensaje quedó atendido. */
  async function ejecutar(r, msg) {
    const chatId = msg.chat.id;
    const texto = msg.text.trim();
    const datos = r.datos ?? {};

    switch (r.intencion) {
      case 'registrar':
        // Sin monto no se adivina: se pregunta
        if (!analizarMonto(texto)) return preguntarMonto(chatId, texto);
        await ctx.registrar(msg, { confianzaBaja: r.confianza === 'baja' });
        return true;

      case 'pagar_cuota':
      case 'nueva_compra_cuotas':
      case 'cuotas_pendientes': {
        if (datos.lista) {
          await ctx.cuotasLista(chatId);
          return true;
        }
        // El texto canónico (lo que reescribió Gemini) se prueba primero; si no sirve, el original
        const candidatos = [datos.texto, texto].filter((t, i, todos) => t && todos.indexOf(t) === i);
        for (const candidato of candidatos) {
          if (await ctx.cuotasMensaje({ ...msg, text: candidato })) return true;
        }
        if (r.intencion === 'cuotas_pendientes') {
          await ctx.cuotasLista(chatId);
          return true;
        }
        return preguntarIntencion(chatId, texto);
      }

      case 'consultar_gastos':
        await ctx.consultarGastos(chatId, datos.texto ?? texto);
        return true;

      case 'plan':
        await ctx.plan(chatId);
        return true;

      case 'datos_transferencia': {
        // Solo el nombre de la cuenta o institución; la búsqueda y la respuesta son locales
        const termino = datos.termino !== undefined ? datos.termino : (terminoDesdeTexto(datos.texto ?? '') || null);
        await ctx.datos(chatId, termino);
        return true;
      }

      case 'cuentas':
        await ctx.cuentas(chatId);
        return true;

      case 'buscar':
        await ctx.buscar(chatId, limpiarBusqueda(datos.texto ?? texto));
        return true;

      case 'ayuda':
        await ctx.ayuda(chatId);
        return true;

      default:
        return preguntarIntencion(chatId, texto);
    }
  }

  /**
   * Atiende un mensaje de texto libre (sin comando). Siempre lo resuelve: lo ejecuta o pregunta.
   * Devuelve true.
   */
  async function manejarTexto(msg) {
    const chatId = msg.chat.id;
    const texto = msg.text.trim();

    // Respuesta al "¿De cuánto fue?"
    const espera = esperandoMonto.get(chatId);
    if (espera) {
      esperandoMonto.delete(chatId);
      if (Date.now() <= espera.hasta && parsearMontoExacto(texto)) {
        await ctx.registrar({ ...msg, text: `${espera.texto} ${texto}` }, { confianzaBaja: false });
        return true;
      }
    }

    // 1. Reglas rápidas
    const porReglas = clasificarPorReglas(texto);
    if (porReglas) return ejecutar(porReglas, msg);

    // 2. Gemini, solo con mensajes que no traen datos sensibles
    if (geminiDisponible() && puedeEnviarseAGemini(texto)) {
      const ia = await interpretarIntencion(texto);
      if (ia && ia.intencion !== 'desconocida') {
        const datos = ia.intencion === 'datos_transferencia' ? { texto: ia.texto } : { texto: ia.texto ?? undefined };
        // La intención la dedujo un modelo: confianza media como máximo
        const confianza = ia.confianza === 'baja' ? 'baja' : 'media';

        // Lo que escribe en la BD con confianza baja se confirma con "Corregir"; con las demás
        // intenciones de baja confianza se pregunta antes de ejecutar
        if (confianza === 'baja' && ia.intencion !== 'registrar') return preguntarIntencion(chatId, texto, ia.intencion);
        return ejecutar({ intencion: ia.intencion, datos, confianza, origen: 'gemini' }, msg);
      }
    }

    // 3. Nada alcanzó: se pregunta
    return preguntarIntencion(chatId, texto);
  }

  /** Botones de este módulo. Devuelve true si el callback era suyo. */
  async function manejarCallback(cb, chatId, data) {
    const messageId = cb.message.message_id;
    let m;

    if (data === 'intm_x') {
      esperandoMonto.delete(chatId);
      await editar('Cancelado', { chat_id: chatId, message_id: messageId });
      await responderCallback(cb.id, { text: 'Cancelado' });
      return true;
    }

    if (data.startsWith('intx_')) {
      preguntas.delete(data.replace('intx_', ''));
      await editar('Cancelado', { chat_id: chatId, message_id: messageId });
      await responderCallback(cb.id, { text: 'Cancelado' });
      return true;
    }

    if ((m = data.match(/^inte_(.+)_([a-z]{2})$/))) {
      const pregunta = preguntas.get(m[1]);
      const intencion = INTENCION_POR_CODIGO[m[2]];
      if (!pregunta || !intencion) {
        await responderCallback(cb.id, { text: 'Solicitud expirada' });
        return true;
      }
      preguntas.delete(m[1]);
      await editar(esc(ETIQUETAS[intencion] ?? 'Listo'), { chat_id: chatId, message_id: messageId });
      await responderCallback(cb.id, {});

      // El usuario eligió: se ejecuta con confianza alta
      await ejecutar(
        { intencion, datos: intencion === 'consultar_gastos' ? { texto: pregunta.texto } : {}, confianza: 'alta', origen: 'boton' },
        { chat: { id: chatId }, text: pregunta.texto }
      );
      return true;
    }

    return false;
  }

  return { manejarTexto, manejarCallback };
}
