/**
 * Importación de cartolas (CSV, Excel y PDF) desde Telegram.
 *
 * Flujo: el archivo se guarda como pendiente en tmp/ (no en cartolas/); se detectan los
 * movimientos y, solo cuando se confirma la importación, se mueve a cartolas/{YYYY-MM}/.
 * Los pendientes sin confirmar se borran solos a las 24 horas (storage.js).
 *
 *  - CSV y Excel: resumen y elegir la cuenta.
 *  - PDF (menos confiable): lectura con reglas y, si no alcanzan, con Gemini usando solo el texto
 *    extraído con números de cuenta y RUT enmascarados. Muestra una vista previa y pide
 *    confirmación (Importar, Cancelar) antes de elegir la cuenta.
 *
 * Después se hace el chequeo de duplicados por hash, la autocategorización y las preguntas de
 * cuotas (buscarCuotasPorCartola, siempre con botones). No se registran en consola ni nombres
 * de archivo ni contenido de cartolas.
 */

import { analizarCartola, analizarPDF, calcularHashBuffer, cartolaYaImportada, registrarImportacion } from '../cartolas.js';
import { listarCuentasActivas } from '../gestion.js';
import { listarCompras } from '../cuotas.js';
import { calzarConCartola } from './cuotas.js';
import { guardarTemporal, confirmarTemporal, borrarTemporal } from '../storage.js';
import { interpretarMovimientosCartola } from './gemini.js';
import { formatearFechaCL } from './fechas.js';

// Tiempo que se recuerda una importación pendiente en memoria (el archivo en tmp/ dura 24 horas)
const ESPERA_MS = 2 * 60 * 60 * 1000;
// Máximo de preguntas de cuotas seguidas tras una importación
const MAX_PREGUNTAS_CUOTAS = 5;
// Movimientos que se muestran en la vista previa de un PDF
const FILAS_VISTA_PREVIA = 8;

export function crearCartolas(ctx) {
  const { enviar, editar, responderCallback, esc, formatearMonto, ofrecerPagoPorCartola } = ctx;

  // Importaciones pendientes: clave -> { tmp, hash, movimientos, esPDF, origen }
  const pendientes = new Map();

  const dinero = (n) => `$${formatearMonto(n)}`;

  function resumenTexto(movimientos) {
    const cargos = movimientos.filter(m => m.tipo === 'cargo');
    const abonos = movimientos.filter(m => m.tipo === 'abono');
    const fechas = movimientos.map(m => m.fecha).sort();
    const suma = (lista) => lista.reduce((total, m) => total + m.monto, 0);
    return (
      `Movimientos: ${movimientos.length} (del ${formatearFechaCL(fechas[0])} al ${formatearFechaCL(fechas[fechas.length - 1])})\n` +
      `Cargos: ${cargos.length} por ${dinero(suma(cargos))}\n` +
      `Abonos: ${abonos.length} por ${dinero(suma(abonos))}`
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

  /** Pregunta en qué cuenta importar (edita el mensaje dado o envía uno nuevo) */
  async function pedirCuenta(chatId, key, encabezado, messageId = null) {
    const cuentas = await listarCuentasActivas();
    if (cuentas.length === 0) {
      const pendiente = pendientes.get(key);
      pendientes.delete(key);
      if (pendiente) await borrarTemporal(pendiente.tmp);
      await enviar(chatId, 'No tienes cuentas activas. Crea una con /savecard y vuelve a enviar la cartola.');
      return;
    }

    const texto = `${encabezado}\n\n¿En qué cuenta los importo?`;
    const opciones = {
      reply_markup: {
        inline_keyboard: [
          ...cuentas.map(c => [{ text: `Importar en ${c.nombre}`.slice(0, 40), callback_data: `cai_${key}_${c.id}` }]),
          [{ text: 'Cancelar', callback_data: `cax_${key}` }]
        ]
      }
    };
    const editado = messageId ? await editar(texto, { chat_id: chatId, message_id: messageId, ...opciones }) : null;
    if (!editado) await enviar(chatId, texto, opciones);
  }

  /**
   * Analiza una cartola recibida y ofrece importarla. El archivo se guarda en tmp/ solo si hay
   * movimientos que importar. Devuelve 'ofrecida', 'duplicada', 'escaneado' (PDF sin texto) o
   * 'ilegible' (no se pudieron leer movimientos): en los dos últimos casos quien llama decide qué
   * hacer con el archivo.
   */
  async function ofrecerImportacion(chatId, { nombre, buffer, ext }) {
    const hash = calcularHashBuffer(buffer);
    if (await cartolaYaImportada(hash)) {
      await enviar(chatId, 'Esta cartola ya fue importada antes, así que no la importé de nuevo.');
      return 'duplicada';
    }

    const esPDF = ext === '.pdf';
    let movimientos = [];
    let origen = null;
    let formato = null;
    try {
      if (esPDF) {
        const r = await analizarPDF(buffer, { interpretarConIA: interpretarMovimientosCartola });
        if (r.escaneado) return 'escaneado';
        movimientos = r.movimientos;
        origen = r.origen;
      } else {
        const r = await analizarCartola(buffer, ext);
        movimientos = r.esManual ? [] : r.movimientos;
        formato = r.formato?.banco ?? null;
      }
    } catch {
      return 'ilegible';
    }
    if (movimientos.length === 0) return 'ilegible';

    const tmp = await guardarTemporal(nombre, buffer);
    const key = `${chatId}_${Date.now()}`;
    pendientes.set(key, { tmp: tmp.ruta, hash, movimientos, esPDF, origen });
    setTimeout(async () => {
      if (pendientes.delete(key)) await borrarTemporal(tmp.ruta);
    }, ESPERA_MS);

    if (!esPDF) {
      await pedirCuenta(chatId, key, `<b>Cartola recibida</b>\n\nFormato detectado: ${esc(formato ?? 'desconocido')}\n${resumenTexto(movimientos)}`);
      return 'ofrecida';
    }

    // PDF: lectura menos confiable, se muestra una vista previa y se pide confirmar antes de elegir cuenta
    await enviar(chatId,
      '<b>Cartola en PDF leída</b>\n\n' +
      `Lectura automática ${origen === 'ia' ? 'con ayuda de IA' : 'por reglas'}: revisa que los datos sean correctos.\n\n` +
      `${resumenTexto(movimientos)}\n\n<b>Primeros movimientos:</b>\n${vistaPrevia(movimientos)}`,
      {
        reply_markup: {
          inline_keyboard: [[
            { text: 'Importar', callback_data: `cap_${key}` },
            { text: 'Cancelar', callback_data: `cax_${key}` }
          ]]
        }
      }
    );
    return 'ofrecida';
  }

  /** Tras importar: pregunta por las transferencias que calzan con el alias de una compra en cuotas */
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
        'Búscalas con /buscar y márcalas desde su ficha.'
      );
    }
  }

  /** Botones de este módulo. Devuelve true si el callback era suyo. */
  async function manejarCallback(cb, chatId, data) {
    const messageId = cb.message.message_id;
    let m;

    // PDF: confirmada la vista previa, se elige la cuenta
    if (data.startsWith('cap_')) {
      const key = data.replace('cap_', '');
      const pendiente = pendientes.get(key);
      if (!pendiente) {
        await responderCallback(cb.id, { text: 'Solicitud expirada' });
        return true;
      }
      await responderCallback(cb.id, {});
      await pedirCuenta(chatId, key, `<b>Cartola en PDF</b>\n\n${resumenTexto(pendiente.movimientos)}`, messageId);
      return true;
    }

    if ((m = data.match(/^cai_(.+)_(\d+)$/))) {
      const pendiente = pendientes.get(m[1]);
      if (!pendiente) {
        await responderCallback(cb.id, { text: 'Solicitud expirada' });
        return true;
      }
      try {
        const cuenta = (await listarCuentasActivas()).find(c => String(c.id) === m[2]);
        if (!cuenta) {
          await responderCallback(cb.id, { text: 'La cuenta ya no está activa' });
          return true;
        }
        pendientes.delete(m[1]);

        // Recién ahora el archivo pasa de tmp/ a cartolas/{YYYY-MM}/
        let ruta;
        try {
          ruta = await confirmarTemporal(pendiente.tmp, 'cartolas', { prefijo: 'telegram_' });
        } catch {
          await editar('El archivo venció antes de confirmar. Envíalo de nuevo.', { chat_id: chatId, message_id: messageId });
          await responderCallback(cb.id, { text: 'Archivo vencido' });
          return true;
        }

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

    return false;
  }

  return { ofrecerImportacion, manejarCallback };
}
