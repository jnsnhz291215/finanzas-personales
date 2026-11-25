/**
 * Importación de cartolas (CSV, Excel y PDF) desde Telegram, de una o de varias a la vez.
 *
 * Cola por chat: los archivos que llegan seguidos (un álbum con el mismo media_group_id, o con menos
 * de 10 segundos entre sí) se agrupan. Cada uno se analiza, los duplicados por hash se descartan y se
 * muestra UN resumen con una línea por archivo. Con un solo archivo el flujo es el de siempre.
 *
 * Los archivos esperan en tmp/ y pasan a cartolas/{YYYY-MM}/ solo al confirmar (los sin confirmar se
 * borran a las 24 horas, ver storage.js). Un PDF muestra antes una vista previa porque su lectura es
 * menos confiable. Las preguntas de cuotas (buscarCuotasPorCartola, siempre con botones, nunca se
 * asignan solas) se hacen al final, todas juntas.
 *
 * Cada importación pendiente tiene su propia clave: dos importaciones del mismo chat no se pisan, y
 * el análisis de un lote espera al anterior. No se registran en consola ni nombres de archivo ni
 * contenido de cartolas.
 */

import { analizarCartola, analizarPDF, calcularHashBuffer, cartolaYaImportada, registrarImportacion } from '../cartolas.js';
import { listarCuentasConBanco } from '../gestion.js';
import { listarCompras } from '../cuotas.js';
import { calzarConCartola, normalizar } from './cuotas.js';
import { guardarTemporal, confirmarTemporal, borrarTemporal } from '../storage.js';
import { interpretarMovimientosCartola } from './gemini.js';
import { formatearFechaCL } from './fechas.js';

// Tiempo que se recuerda una importación pendiente en memoria (el archivo en tmp/ dura 24 horas)
const ESPERA_MS = 2 * 60 * 60 * 1000;
// Espera tras el último archivo para agrupar los que llegan seguidos (menos de 10 segundos entre sí)
export const VENTANA_LOTE_MS = 10 * 1000;
// Los álbumes de Telegram llegan casi juntos: se cierra antes
export const VENTANA_ALBUM_MS = 3 * 1000;
// Máximo de preguntas de cuotas seguidas tras importar
const MAX_PREGUNTAS_CUOTAS = 8;
// Movimientos que se muestran en la vista previa de un PDF
const FILAS_VISTA_PREVIA = 8;

/**
 * Cuenta que probablemente corresponde a un banco detectado en la cartola (por ejemplo "Falabella").
 * Solo si hay exactamente una coincidencia; si no, null (se pregunta sin sugerir).
 */
export function sugerirCuenta(banco, cuentas) {
  if (!banco) return null;
  const clave = normalizar(banco).replace(/\b(banco|de)\b/g, ' ').replace(/\s+/g, ' ').trim();
  if (clave.length < 3) return null;

  const coincidencias = cuentas.filter(c => {
    const delBanco = normalizar(c.banco ?? '');
    return (delBanco && (delBanco.includes(clave) || clave.includes(delBanco))) || normalizar(c.nombre).includes(clave);
  });
  return coincidencias.length === 1 ? coincidencias[0] : null;
}

export function crearCartolas(ctx) {
  const { enviar, editar, responderCallback, esc, formatearMonto, ofrecerPagoPorCartola, guardarNoLeido } = ctx;

  // Archivos que van llegando: chatId -> { items, timer }
  const colas = new Map();
  // Análisis en curso por chat (un lote espera al anterior): chatId -> Promise
  const tareas = new Map();
  // Un solo archivo pendiente de confirmar: clave -> { tmp, hash, movimientos, esPDF, origen }
  const pendientes = new Map();
  // Varios archivos pendientes: clave -> lote
  const lotes = new Map();
  let contador = 0;

  const nuevaClave = (chatId) => `${chatId}_${Date.now()}_${contador++}`;
  const dinero = (n) => `$${formatearMonto(n)}`;

  // -------------------------------------------------------------------------
  // Texto
  // -------------------------------------------------------------------------

  function totales(movimientos) {
    const cargos = movimientos.filter(m => m.tipo === 'cargo');
    const abonos = movimientos.filter(m => m.tipo === 'abono');
    const suma = (lista) => lista.reduce((total, m) => total + m.monto, 0);
    const fechas = movimientos.map(m => m.fecha).sort();
    return {
      cargos: cargos.length,
      abonos: abonos.length,
      sumaCargos: suma(cargos),
      sumaAbonos: suma(abonos),
      desde: fechas[0],
      hasta: fechas[fechas.length - 1]
    };
  }

  function resumenTexto(movimientos) {
    const t = totales(movimientos);
    return (
      `Movimientos: ${movimientos.length} (del ${formatearFechaCL(t.desde)} al ${formatearFechaCL(t.hasta)})\n` +
      `Cargos: ${t.cargos} por ${dinero(t.sumaCargos)}\n` +
      `Abonos: ${t.abonos} por ${dinero(t.sumaAbonos)}`
    );
  }

  function vistaPrevia(movimientos) {
    const filas = movimientos.slice(0, FILAS_VISTA_PREVIA).map(m => {
      const descripcion = m.descripcion.length > 30 ? `${m.descripcion.slice(0, 29)}...` : m.descripcion;
      return `${formatearFechaCL(m.fecha)} - ${esc(descripcion)} - ${m.tipo === 'cargo' ? '-' : '+'}${dinero(m.monto)}`;
    });
    const resto = movimientos.length - filas.length;
    return filas.join('\n') + (resto > 0 ? `\n... y ${resto} más` : '');
  }

  const etiquetaFuente = (item) => (item.esPDF ? 'PDF' : item.ext === '.csv' ? 'CSV' : 'Excel');

  /** Una línea por archivo: formato o banco, rango de fechas, movimientos y totales */
  function lineaArchivo(numero, item) {
    const t = totales(item.movimientos);
    return (
      `${numero}. ${esc(item.formato)} (${etiquetaFuente(item)}) - ${formatearFechaCL(t.desde)} al ${formatearFechaCL(t.hasta)} - ` +
      `${item.movimientos.length} mov. - cargos ${dinero(t.sumaCargos)}, abonos ${dinero(t.sumaAbonos)}` +
      (item.cuentaSugerida ? ` - cuenta sugerida: ${esc(item.cuentaSugerida.nombre)}` : '')
    );
  }

  // -------------------------------------------------------------------------
  // Cuenta: botones con la sugerida primero
  // -------------------------------------------------------------------------

  function botonesCuentas(cuentas, sugerida, prefijo) {
    const ordenadas = sugerida
      ? [sugerida, ...cuentas.filter(c => c.id !== sugerida.id)]
      : cuentas;
    return ordenadas.map(c => [{
      text: `Importar en ${c.nombre}${sugerida && c.id === sugerida.id ? ' (sugerida)' : ''}`.slice(0, 44),
      callback_data: `${prefijo}_${c.id}`
    }]);
  }

  // -------------------------------------------------------------------------
  // Análisis
  // -------------------------------------------------------------------------

  /** Lee un archivo. Devuelve { estado: 'ok'|'escaneado'|'ilegible', movimientos, origen, banco, formato } */
  async function analizarArchivo({ buffer, ext }) {
    try {
      if (ext === '.pdf') {
        const r = await analizarPDF(buffer, { interpretarConIA: interpretarMovimientosCartola });
        if (r.escaneado) return { estado: 'escaneado' };
        if (r.movimientos.length === 0) return { estado: 'ilegible' };
        return {
          estado: 'ok',
          movimientos: r.movimientos,
          origen: r.origen,
          banco: r.banco,
          formato: r.banco ?? 'PDF sin banco reconocido'
        };
      }

      const r = await analizarCartola(buffer, ext);
      if (r.esManual || r.movimientos.length === 0) return { estado: 'ilegible' };
      const nombre = r.formato?.banco;
      const reconocido = nombre && !['Genérico', 'Manual'].includes(nombre) ? nombre : null;
      return { estado: 'ok', movimientos: r.movimientos, origen: null, banco: reconocido, formato: nombre ?? 'Formato genérico' };
    } catch {
      return { estado: 'ilegible' };
    }
  }

  // -------------------------------------------------------------------------
  // Cola por chat
  // -------------------------------------------------------------------------

  /**
   * Recibe un archivo ya descargado. Lo agrupa con los que lleguen seguidos y, cuando pasa la
   * ventana sin más archivos, analiza el lote completo.
   */
  async function recibirArchivo(chatId, { nombre, buffer, ext, mediaGroupId = null }) {
    let cola = colas.get(chatId);
    const primero = !cola;
    if (!cola) {
      cola = { items: [], timer: null };
      colas.set(chatId, cola);
    }
    cola.items.push({ nombre, buffer, ext, mediaGroupId });

    clearTimeout(cola.timer);
    const esAlbum = cola.items.every(i => i.mediaGroupId && i.mediaGroupId === cola.items[0].mediaGroupId);
    cola.timer = setTimeout(() => cerrarCola(chatId), esAlbum ? VENTANA_ALBUM_MS : VENTANA_LOTE_MS);

    if (primero) {
      await enviar(chatId, 'Recibí el archivo. Si mandas más seguidos los agrupo en un solo resumen.');
    }
  }

  function cerrarCola(chatId) {
    const cola = colas.get(chatId);
    if (!cola) return;
    colas.delete(chatId);

    // Un lote espera al anterior del mismo chat: nunca se pisan
    const previa = tareas.get(chatId) ?? Promise.resolve();
    const tarea = previa
      .then(() => procesarLote(chatId, cola.items))
      .catch(error => console.error('Error al procesar cartolas:', error.code ?? error.name))
      .finally(() => {
        if (tareas.get(chatId) === tarea) tareas.delete(chatId);
      });
    tareas.set(chatId, tarea);
  }

  async function procesarLote(chatId, archivos) {
    const unico = archivos.length === 1;
    const vistos = new Set();
    const avisos = [];
    const validos = [];

    for (let i = 0; i < archivos.length; i++) {
      const archivo = archivos[i];
      const prefijo = unico ? '' : `Archivo ${i + 1}: `;
      const hash = calcularHashBuffer(archivo.buffer);

      if (vistos.has(hash)) {
        avisos.push(`${prefijo}está repetido en este envío, lo descarté.`);
        continue;
      }
      vistos.add(hash);

      if (await cartolaYaImportada(hash)) {
        avisos.push(unico
          ? 'Esta cartola ya fue importada antes, así que no la importé de nuevo.'
          : `${prefijo}ya fue importada antes, la descarté.`);
        continue;
      }

      const analisis = await analizarArchivo(archivo);
      if (analisis.estado !== 'ok') {
        // No se pudo leer de ninguna forma: queda guardada en cartolas/{YYYY-MM}/
        await guardarNoLeido(archivo.nombre, archivo.buffer);
        avisos.push(
          analisis.estado === 'escaneado'
            ? `${prefijo}este PDF parece escaneado y no tiene texto, mándame la cartola descargada desde el banco. Dejé el archivo guardado.`
            : `${prefijo}no pude leer los movimientos${archivo.ext === '.pdf' ? ' de este PDF (no reconozco su formato)' : ''}. Dejé el archivo guardado.`
        );
        continue;
      }

      const tmp = await guardarTemporal(archivo.nombre, archivo.buffer);
      validos.push({
        tmp: tmp.ruta,
        hash,
        ext: archivo.ext,
        esPDF: archivo.ext === '.pdf',
        origen: analisis.origen,
        banco: analisis.banco,
        formato: analisis.formato,
        movimientos: analisis.movimientos,
        estado: 'pendiente',
        importados: 0,
        cuentaNombre: null
      });
    }

    if (validos.length === 0) {
      if (avisos.length > 0) await enviar(chatId, avisos.map(a => esc(a)).join('\n'));
      return;
    }

    const cuentas = await listarCuentasConBanco();
    if (cuentas.length === 0) {
      for (const item of validos) await borrarTemporal(item.tmp);
      await enviar(chatId, 'No tienes cuentas activas. Crea una con /savecard y vuelve a enviar la cartola.');
      return;
    }
    for (const item of validos) item.cuentaSugerida = sugerirCuenta(item.banco, cuentas);

    if (validos.length === 1) {
      if (avisos.length > 0) await enviar(chatId, avisos.map(a => esc(a)).join('\n'));
      await ofrecerUno(chatId, validos[0], cuentas);
      return;
    }

    await ofrecerLote(chatId, validos, avisos, cuentas);
  }

  // -------------------------------------------------------------------------
  // Un solo archivo (flujo de siempre)
  // -------------------------------------------------------------------------

  async function pedirCuentaUno(chatId, key, encabezado, cuentas, sugerida, messageId = null) {
    const texto = `${encabezado}\n\n¿En qué cuenta los importo?`;
    const opciones = {
      reply_markup: {
        inline_keyboard: [
          ...botonesCuentas(cuentas, sugerida, `cai_${key}`),
          [{ text: 'Cancelar', callback_data: `cax_${key}` }]
        ]
      }
    };
    const editado = messageId ? await editar(texto, { chat_id: chatId, message_id: messageId, ...opciones }) : null;
    if (!editado) await enviar(chatId, texto, opciones);
  }

  async function ofrecerUno(chatId, item, cuentas) {
    const key = nuevaClave(chatId);
    pendientes.set(key, { ...item, cuentas });
    setTimeout(async () => {
      if (pendientes.delete(key)) await borrarTemporal(item.tmp);
    }, ESPERA_MS);

    if (!item.esPDF) {
      await pedirCuentaUno(
        chatId, key,
        `<b>Cartola recibida</b>\n\nFormato detectado: ${esc(item.formato)}\n${resumenTexto(item.movimientos)}`,
        cuentas, item.cuentaSugerida
      );
      return;
    }

    // PDF: lectura menos confiable, se muestra una vista previa y se pide confirmar antes de elegir cuenta
    await enviar(chatId,
      '<b>Cartola en PDF leída</b>\n\n' +
      `Lectura automática ${item.origen === 'ia' ? 'con ayuda de IA' : 'por reglas'}: revisa que los datos sean correctos.\n\n` +
      `${resumenTexto(item.movimientos)}\n\n<b>Primeros movimientos:</b>\n${vistaPrevia(item.movimientos)}`,
      {
        reply_markup: {
          inline_keyboard: [[
            { text: 'Importar', callback_data: `cap_${key}` },
            { text: 'Cancelar', callback_data: `cax_${key}` }
          ]]
        }
      }
    );
  }

  // -------------------------------------------------------------------------
  // Varios archivos
  // -------------------------------------------------------------------------

  async function ofrecerLote(chatId, items, avisos, cuentas) {
    const key = nuevaClave(chatId);
    const lote = { chatId, items, cuentas, modo: null, ocupado: false, registrados: [] };
    lotes.set(key, lote);
    setTimeout(async () => {
      if (lotes.delete(key)) {
        for (const item of items) if (item.estado === 'pendiente') await borrarTemporal(item.tmp);
      }
    }, ESPERA_MS);

    await enviar(chatId,
      `<b>Recibí ${items.length} cartolas</b>\n\n` +
      items.map((item, i) => lineaArchivo(i + 1, item)).join('\n') +
      (avisos.length > 0 ? `\n\n${avisos.map(a => esc(a)).join('\n')}` : '') +
      (items.some(i => i.esPDF) ? '\n\nLos PDF se leen de forma automática: con "Revisar uno por uno" ves una vista previa de cada uno.' : ''),
      {
        reply_markup: {
          inline_keyboard: [
            [
              { text: 'Importar todo', callback_data: `cab_${key}` },
              { text: 'Revisar uno por uno', callback_data: `cbr_${key}` }
            ],
            [{ text: 'Cancelar', callback_data: `cbx_${key}` }]
          ]
        }
      }
    );
  }

  /** Pregunta la cuenta de un archivo del lote (con vista previa si es PDF) */
  async function preguntarItem(chatId, key, lote, indice) {
    const item = lote.items[indice];
    const encabezado =
      `<b>Archivo ${indice + 1} de ${lote.items.length}</b>\n\n${esc(item.formato)} (${etiquetaFuente(item)})\n` +
      resumenTexto(item.movimientos) +
      (item.esPDF ? `\n\n<b>Primeros movimientos:</b>\n${vistaPrevia(item.movimientos)}` : '');

    await enviar(chatId, `${encabezado}\n\n¿En qué cuenta lo importo?`, {
      reply_markup: {
        inline_keyboard: [
          ...botonesCuentas(lote.cuentas, item.cuentaSugerida, `cbi_${key}_${indice}`),
          [
            { text: 'Omitir este archivo', callback_data: `cbo_${key}_${indice}` },
            { text: 'Cancelar todo', callback_data: `cbx_${key}` }
          ]
        ]
      }
    });
  }

  /** Mueve el archivo a cartolas/{YYYY-MM}/ y registra sus movimientos en la cuenta */
  async function importarItem(lote, item, cuenta) {
    try {
      const ruta = await confirmarTemporal(item.tmp, 'cartolas', { prefijo: 'telegram_' });
      const { importados, registrados } = await registrarImportacion({
        archivo: ruta,
        hash: item.hash,
        cuentaId: cuenta.id,
        movimientos: item.movimientos
      });
      item.estado = 'importado';
      item.importados = importados;
      item.cuentaNombre = cuenta.nombre;
      lote.registrados.push(...registrados);
    } catch (error) {
      console.error('Error al importar una cartola del lote:', error.code ?? error.name);
      item.estado = 'error';
    }
  }

  /** Importa lo que se pueda sin preguntar y se detiene en el primer archivo que necesita una respuesta */
  async function avanzarLote(chatId, key) {
    const lote = lotes.get(key);
    if (!lote) return;

    for (let i = 0; i < lote.items.length; i++) {
      const item = lote.items[i];
      if (item.estado !== 'pendiente') continue;

      if (lote.modo === 'todo' && item.cuentaSugerida) {
        await importarItem(lote, item, item.cuentaSugerida);
        continue;
      }
      await preguntarItem(chatId, key, lote, i);
      return;
    }
    await finalizarLote(chatId, key, lote);
  }

  async function finalizarLote(chatId, key, lote) {
    lotes.delete(key);

    const lineas = lote.items.map((item, i) => {
      if (item.estado === 'importado') return `${i + 1}. ${item.importados} movimientos en ${esc(item.cuentaNombre)}`;
      if (item.estado === 'error') return `${i + 1}. no se pudo importar (el archivo quedó pendiente)`;
      return `${i + 1}. omitido`;
    });
    const total = lote.items.reduce((suma, item) => suma + item.importados, 0);
    await enviar(chatId, `<b>Listo: importé ${total} movimientos</b>\n\n${lineas.join('\n')}`);

    // Las preguntas de cuotas, todas juntas y al final
    await preguntarPorCuotas(chatId, lote.registrados);
  }

  async function cancelarLote(chatId, key, messageId) {
    const lote = lotes.get(key);
    lotes.delete(key);
    if (lote) {
      for (const item of lote.items) if (item.estado === 'pendiente') await borrarTemporal(item.tmp);
    }
    await editar('Importación cancelada. Descarté los archivos pendientes.', { chat_id: chatId, message_id: messageId });
    // Lo que ya se había importado sigue su camino: se pregunta por las cuotas
    if (lote?.registrados.length > 0) await preguntarPorCuotas(chatId, lote.registrados);
  }

  // -------------------------------------------------------------------------
  // Cuotas (siempre con botones, al final)
  // -------------------------------------------------------------------------

  async function preguntarPorCuotas(chatId, registrados) {
    const compras = await listarCompras();
    if (compras.every(c => !c.alias_cartola)) return;

    const candidatos = registrados.filter(m => m.tipo === 'cargo' && calzarConCartola(m.descripcion, compras).length > 0);
    for (const m of candidatos.slice(0, MAX_PREGUNTAS_CUOTAS)) {
      await ofrecerPagoPorCartola(chatId, {
        id: m.id,
        descripcion: m.descripcion,
        detalle: `${formatearFechaCL(m.fecha)}, ${dinero(m.monto)}`
      });
    }
    if (candidatos.length > MAX_PREGUNTAS_CUOTAS) {
      await enviar(chatId,
        `Hay ${candidatos.length - MAX_PREGUNTAS_CUOTAS} transferencias más que parecen pagos de cuota. ` +
        'Búscalas con "busca" y márcalas desde su ficha.'
      );
    }
  }

  // -------------------------------------------------------------------------
  // Botones
  // -------------------------------------------------------------------------

  /** Botones de este módulo. Devuelve true si el callback era suyo. */
  async function manejarCallback(cb, chatId, data) {
    const messageId = cb.message.message_id;
    let m;

    // ---- Un solo archivo ----

    // PDF: confirmada la vista previa, se elige la cuenta
    if (data.startsWith('cap_')) {
      const key = data.replace('cap_', '');
      const pendiente = pendientes.get(key);
      if (!pendiente) {
        await responderCallback(cb.id, { text: 'Solicitud expirada' });
        return true;
      }
      await responderCallback(cb.id, {});
      await pedirCuentaUno(
        chatId, key, `<b>Cartola en PDF</b>\n\n${resumenTexto(pendiente.movimientos)}`,
        pendiente.cuentas, pendiente.cuentaSugerida, messageId
      );
      return true;
    }

    if ((m = data.match(/^cai_(.+)_(\d+)$/))) {
      const pendiente = pendientes.get(m[1]);
      if (!pendiente) {
        await responderCallback(cb.id, { text: 'Solicitud expirada' });
        return true;
      }
      const cuenta = pendiente.cuentas.find(c => String(c.id) === m[2]);
      if (!cuenta) {
        await responderCallback(cb.id, { text: 'La cuenta ya no está activa' });
        return true;
      }
      pendientes.delete(m[1]);

      try {
        const ruta = await confirmarTemporal(pendiente.tmp, 'cartolas', { prefijo: 'telegram_' });
        const { importados, registrados } = await registrarImportacion({
          archivo: ruta,
          hash: pendiente.hash,
          cuentaId: cuenta.id,
          movimientos: pendiente.movimientos
        });
        await editar(`Importé ${importados} movimientos en <b>${esc(cuenta.nombre)}</b>.`, { chat_id: chatId, message_id: messageId });
        await responderCallback(cb.id, { text: 'Importada' });
        await preguntarPorCuotas(chatId, registrados);
      } catch (error) {
        console.error('Error al importar la cartola:', error.code ?? error.name);
        await editar('El archivo venció o no se pudo importar. Envíalo de nuevo.', { chat_id: chatId, message_id: messageId });
        await responderCallback(cb.id, { text: 'Error al importar' });
      }
      return true;
    }

    if (data.startsWith('cax_')) {
      const key = data.replace('cax_', '');
      const pendiente = pendientes.get(key);
      pendientes.delete(key);
      if (pendiente) await borrarTemporal(pendiente.tmp);
      await editar('Importación cancelada. Descarté el archivo.', { chat_id: chatId, message_id: messageId });
      await responderCallback(cb.id, { text: 'Cancelada' });
      return true;
    }

    // ---- Varios archivos ----

    // Importar todo / Revisar uno por uno
    if ((m = data.match(/^(cab|cbr)_(.+)$/))) {
      const lote = lotes.get(m[2]);
      if (!lote) {
        await responderCallback(cb.id, { text: 'Solicitud expirada' });
        return true;
      }
      if (lote.ocupado || lote.modo) {
        await responderCallback(cb.id, { text: 'Ya está en curso' });
        return true;
      }
      lote.ocupado = true;
      lote.modo = m[1] === 'cab' ? 'todo' : 'uno';
      try {
        await responderCallback(cb.id, {});
        await editar(
          lote.modo === 'todo'
            ? 'Importando todo con las cuentas sugeridas. Te pregunto solo por los archivos sin cuenta sugerida.'
            : 'Vamos uno por uno.',
          { chat_id: chatId, message_id: messageId }
        );
        await avanzarLote(chatId, m[2]);
      } catch (error) {
        console.error('Error en el lote de cartolas:', error.code ?? error.name);
      } finally {
        lote.ocupado = false;
      }
      return true;
    }

    // Elegir la cuenta de un archivo del lote
    if ((m = data.match(/^cbi_(.+)_(\d+)_(\d+)$/))) {
      const lote = lotes.get(m[1]);
      const item = lote?.items[Number(m[2])];
      if (!lote || !item || item.estado !== 'pendiente') {
        await responderCallback(cb.id, { text: 'Solicitud expirada' });
        return true;
      }
      if (lote.ocupado) {
        await responderCallback(cb.id, { text: 'Ya está en curso' });
        return true;
      }
      const cuenta = lote.cuentas.find(c => String(c.id) === m[3]);
      if (!cuenta) {
        await responderCallback(cb.id, { text: 'La cuenta ya no está activa' });
        return true;
      }
      lote.ocupado = true;
      try {
        await responderCallback(cb.id, {});
        await importarItem(lote, item, cuenta);
        await editar(
          item.estado === 'importado'
            ? `Importé ${item.importados} movimientos en <b>${esc(cuenta.nombre)}</b>.`
            : 'No pude importar este archivo.',
          { chat_id: chatId, message_id: messageId }
        );
        await avanzarLote(chatId, m[1]);
      } catch (error) {
        console.error('Error en el lote de cartolas:', error.code ?? error.name);
      } finally {
        lote.ocupado = false;
      }
      return true;
    }

    // Omitir un archivo del lote
    if ((m = data.match(/^cbo_(.+)_(\d+)$/))) {
      const lote = lotes.get(m[1]);
      const item = lote?.items[Number(m[2])];
      if (!lote || !item || item.estado !== 'pendiente') {
        await responderCallback(cb.id, { text: 'Solicitud expirada' });
        return true;
      }
      if (lote.ocupado) {
        await responderCallback(cb.id, { text: 'Ya está en curso' });
        return true;
      }
      lote.ocupado = true;
      try {
        item.estado = 'omitido';
        await borrarTemporal(item.tmp);
        await responderCallback(cb.id, {});
        await editar('Archivo omitido.', { chat_id: chatId, message_id: messageId });
        await avanzarLote(chatId, m[1]);
      } catch (error) {
        console.error('Error en el lote de cartolas:', error.code ?? error.name);
      } finally {
        lote.ocupado = false;
      }
      return true;
    }

    // Cancelar el lote entero
    if (data.startsWith('cbx_')) {
      await responderCallback(cb.id, { text: 'Cancelada' });
      await cancelarLote(chatId, data.replace('cbx_', ''), messageId);
      return true;
    }

    return false;
  }

  return { recibirArchivo, manejarCallback };
}
