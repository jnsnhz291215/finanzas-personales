/**
 * Importación de cartolas (CSV y Excel) desde Telegram. El archivo ya se guardó con storage.js
 * en cartolas/{YYYY-MM}/; aquí se detectan los movimientos, se pregunta a qué cuenta importarlos
 * y, después, se avisa de las transferencias que parecen pagos de una compra en cuotas
 * (buscarCuotasPorCartola, vía ofrecerPagoPorCartola), siempre con botones: nunca se asigna sola.
 *
 * Los PDF requieren revisión manual y no se importan desde aquí. No se registran en consola ni
 * nombres de archivo ni contenido de cartolas.
 */

import { analizarCartola, calcularHashBuffer, cartolaYaImportada, registrarImportacion } from '../cartolas.js';
import { listarCuentasActivas } from '../gestion.js';
import { listarCompras } from '../cuotas.js';
import { calzarConCartola } from './cuotas.js';
import { borrarArchivo } from '../storage.js';
import { formatearFechaCL } from './fechas.js';

const ESPERA_MS = 15 * 60 * 1000;
// Máximo de preguntas de cuotas seguidas tras una importación
const MAX_PREGUNTAS_CUOTAS = 5;

export function crearCartolas(ctx) {
  const { enviar, editar, responderCallback, esc, formatearMonto, ofrecerPagoPorCartola } = ctx;

  // Importaciones pendientes de elegir cuenta: clave -> { ruta, hash, movimientos }
  const pendientes = new Map();

  const dinero = (n) => `$${formatearMonto(n)}`;

  /**
   * Ofrece importar una cartola ya guardada. `ruta` es la ruta relativa a la raíz del
   * almacenamiento. Devuelve 'ofrecida', 'duplicada' o 'sin_movimientos' (el archivo queda guardado
   * para revisarlo en la web).
   */
  async function ofrecerImportacion(chatId, { ruta, buffer, ext }) {
    let analisis;
    try {
      analisis = await analizarCartola(buffer, ext);
    } catch {
      return 'sin_movimientos';
    }
    if (analisis.esManual || analisis.movimientos.length === 0) return 'sin_movimientos';

    const hash = calcularHashBuffer(buffer);
    if (await cartolaYaImportada(hash)) {
      await borrarArchivo(ruta);
      await enviar(chatId, 'Esta cartola ya fue importada antes, así que no la importé de nuevo.');
      return 'duplicada';
    }

    const cuentas = await listarCuentasActivas();
    if (cuentas.length === 0) {
      await enviar(chatId, 'No tienes cuentas activas. Crea una con /savecard y vuelve a enviar la cartola.');
      return 'ofrecida';
    }

    const { movimientos } = analisis;
    const cargos = movimientos.filter(m => m.tipo === 'cargo');
    const abonos = movimientos.filter(m => m.tipo === 'abono');
    const fechas = movimientos.map(m => m.fecha).sort();
    const suma = (lista) => lista.reduce((total, m) => total + m.monto, 0);

    const key = `${chatId}_${Date.now()}`;
    pendientes.set(key, { ruta, hash, movimientos });
    setTimeout(() => pendientes.delete(key), ESPERA_MS);

    await enviar(chatId,
      '<b>Cartola recibida</b>\n\n' +
      `Formato detectado: ${esc(analisis.formato?.banco ?? 'desconocido')}\n` +
      `Movimientos: ${movimientos.length} (del ${formatearFechaCL(fechas[0])} al ${formatearFechaCL(fechas[fechas.length - 1])})\n` +
      `Cargos: ${cargos.length} por ${dinero(suma(cargos))}\n` +
      `Abonos: ${abonos.length} por ${dinero(suma(abonos))}\n\n` +
      '¿En qué cuenta los importo?',
      {
        reply_markup: {
          inline_keyboard: [
            ...cuentas.map(c => [{ text: `Importar en ${c.nombre}`.slice(0, 40), callback_data: `cai_${key}_${c.id}` }]),
            [{ text: 'Cancelar', callback_data: `cax_${key}` }]
          ]
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

        const { importados, registrados } = await registrarImportacion({
          archivo: pendiente.ruta,
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
      if (pendiente) await borrarArchivo(pendiente.ruta);
      await editar('Importación cancelada. Descarté el archivo.', { chat_id: chatId, message_id: messageId });
      await responderCallback(cb.id, { text: 'Cancelada' });
      return true;
    }

    return false;
  }

  return { ofrecerImportacion, manejarCallback };
}
