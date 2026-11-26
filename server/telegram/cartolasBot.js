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

import { analizarCartola, analizarPDF, analizarTexto, calcularHashBuffer, cartolaYaImportada, registrarImportacion } from '../cartolas.js';
import { listarCuentasConBanco, guardarDigitosCuenta } from '../gestion.js';
import { listarCompras } from '../cuotas.js';
import { calzarConCartola, normalizar } from './cuotas.js';
import { guardarTemporal, confirmarTemporal, borrarTemporal } from '../storage.js';
import { interpretarMovimientosCartola } from './gemini.js';
import { formatearFechaCL } from './fechas.js';
import { buscarCuentaPorTexto } from './intenciones.js';
import { leerContextoCartola, contextoUtil, cruzarContextoConCuentas, VENTANA_CONTEXTO_MS } from './contextoCartola.js';
import { TIPO_DB, nombreAutomatico } from './cuentas.js';

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

/** Cuenta que corresponde a un banco detectado ("Falabella"); solo si hay exactamente una coincidencia */
function sugerirPorBanco(banco, cuentas) {
  if (!banco) return null;
  const clave = normalizar(banco).replace(/\b(banco|de)\b/g, ' ').replace(/\s+/g, ' ').trim();
  if (clave.length < 3) return null;

  const coincidencias = cuentas.filter(c => {
    const delBanco = normalizar(c.banco ?? '');
    return (delBanco && (delBanco.includes(clave) || clave.includes(delBanco))) || normalizar(c.nombre).includes(clave);
  });
  return coincidencias.length === 1 ? coincidencias[0] : null;
}

/**
 * Cuenta a la que corresponde una cartola. Prioridad 1: los últimos 4 dígitos que trae el archivo
 * coinciden con ultimos4 (tarjeta) o ultimos4_cuenta (cuenta) de una sola cuenta. Prioridad 2: el
 * banco detectado. Devuelve { cuenta, por: 'digitos' | 'banco', digitos } o null.
 */
export function detectarCuenta({ banco = null, ultimos4 = [] }, cuentas) {
  const porDigitos = [];
  for (const u of ultimos4) {
    for (const c of cuentas) {
      const coincide = (c.ultimos4 && c.ultimos4 === u.digitos) || (c.ultimos4_cuenta && c.ultimos4_cuenta === u.digitos);
      if (coincide && !porDigitos.some(x => x.cuenta.id === c.id)) porDigitos.push({ cuenta: c, digitos: u.digitos });
    }
  }
  // Si los dígitos calzan con dos cuentas distintas no se adivina: se cae al banco
  if (porDigitos.length === 1) return { cuenta: porDigitos[0].cuenta, por: 'digitos', digitos: porDigitos[0].digitos };

  const cuentaBanco = sugerirPorBanco(banco, cuentas);
  return cuentaBanco ? { cuenta: cuentaBanco, por: 'banco', digitos: null } : null;
}

/** Cuenta sugerida (solo la cuenta): por dígitos y, si no, por banco */
export function sugerirCuenta(banco, cuentas, ultimos4 = []) {
  return detectarCuenta({ banco, ultimos4 }, cuentas)?.cuenta ?? null;
}

/**
 * Dígitos de la cartola que no coinciden con ninguna cuenta y que la cuenta elegida todavía no
 * tiene en esa columna (tarjeta -> ultimos4, cuenta -> ultimos4_cuenta). Devuelve el primero
 * { digitos, tipo } o null: es lo que se ofrece guardar para reconocerla la próxima vez.
 */
export function candidatoDigitos(ultimos4, cuenta, cuentas) {
  for (const u of ultimos4 ?? []) {
    const yaPertenece = cuentas.some(c => c.ultimos4 === u.digitos || c.ultimos4_cuenta === u.digitos);
    const columna = u.tipo === 'cuenta' ? 'ultimos4_cuenta' : 'ultimos4';
    if (!yaPertenece && !cuenta[columna]) return { digitos: u.digitos, tipo: u.tipo };
  }
  return null;
}

/**
 * La cartola trae otro número de cuenta distinto del que la tarjeta tiene vinculado (y que no es de otra cuenta):
 * { digitos, tipo: 'cuenta', reemplaza } o null. Solo se ofrece cambiarlo, nunca se cambia solo.
 */
export function candidatoVinculo(ultimos4, cuenta, cuentas) {
  if (!cuenta?.ultimos4_cuenta) return null;
  for (const u of ultimos4 ?? []) {
    if (u.tipo !== 'cuenta' || u.digitos === cuenta.ultimos4_cuenta) continue;
    if (cuentas.some(c => c.id !== cuenta.id && (c.ultimos4 === u.digitos || c.ultimos4_cuenta === u.digitos))) continue;
    return { digitos: u.digitos, tipo: 'cuenta', reemplaza: cuenta.ultimos4_cuenta };
  }
  return null;
}

/** Texto corto de lo que dijo el mensaje: "crédito ****8263 de Valeska" */
export function describirContexto(c) {
  const tipos = { credito: 'crédito', debito: 'débito', cuenta_corriente: 'cuenta corriente', cuenta_vista: 'cuenta vista', ahorro: 'cuenta de ahorro' };
  return [tipos[c.tipo], c.digitos ? `****${c.digitos}` : null, c.titular ? `de ${c.titular}` : null].filter(Boolean).join(' ');
}

const EXT_IMAGEN = ['.jpg', '.jpeg', '.png'];

export function crearCartolas(ctx) {
  const { enviar, editar, responderCallback, esc, formatearMonto, ofrecerPagoPorCartola, guardarNoLeido } = ctx;
  // Guarda qué mensajes de Telegram crearon cada importación (para eliminarla respondiéndoles)
  const vincular = ctx.vincularRegistro ?? (async () => {});

  // Archivos que van llegando: chatId -> { items, timer }
  const colas = new Map();
  // Análisis en curso por chat (un lote espera al anterior): chatId -> Promise
  const tareas = new Map();
  // Un solo archivo pendiente de confirmar: clave -> { tmp, hash, movimientos, esPDF, origen }
  const pendientes = new Map();
  // Varios archivos pendientes: clave -> lote
  const lotes = new Map();
  // Dígitos que se ofrecen guardar en una cuenta: clave -> { cuentaId, nombre, digitos, tipo }
  const digitosPendientes = new Map();
  // Texto que llegó antes de las cartolas ("son de la tarjeta 8263"): chatId -> { contexto, hasta }
  const previos = new Map();
  // Álbumes de fotos que se declararon cartola por el caption de una de ellas: "chatId_grupo"
  const albumesCartola = new Set();
  // Preguntas de cruce de cuenta: clave -> { chatId, item, cuentas, tipo, espera, ... }
  const preguntasContexto = new Map();
  let contador = 0;

  const nuevaClave = (chatId) => `${chatId}_${Date.now()}_${contador++}`;
  const dinero = (n) => `$${formatearMonto(n)}`;
  /** " (3 ya estaban registrados de otra cartola, no los dupliqué)" o vacío */
  const textoDuplicados = (n) => (n > 0 ? ` (${n} ya ${n === 1 ? 'estaba registrado' : 'estaban registrados'} de otra cartola, no ${n === 1 ? 'lo' : 'los'} dupliqué)` : '');

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

  const etiquetaFuente = (item) => (EXT_IMAGEN.includes(item.ext) ? 'Foto' : item.esPDF ? 'PDF' : item.ext === '.csv' ? 'CSV' : 'Excel');

  /** "Falabella débito •6958" (el nombre de la cuenta y la terminación que coincidió) */
  const cuentaConDigitos = (deteccion) => `${esc(deteccion.cuenta.nombre)}${deteccion.digitos ? ` •${esc(deteccion.digitos)}` : ''}`;

  /** Línea de detección de cuenta para el resumen de un archivo (vacía si no hay nada que decir) */
  function lineaDeteccion(item) {
    if (item.notaContexto) return esc(item.notaContexto);
    if (item.deteccion?.por === 'texto') return `Cuenta según tu mensaje: ${cuentaConDigitos(item.deteccion)}`;
    if (item.deteccion?.por === 'digitos') return `Cuenta detectada: ${cuentaConDigitos(item.deteccion)}`;
    if (item.deteccion?.por === 'banco') return `Cuenta sugerida por el banco: ${esc(item.deteccion.cuenta.nombre)}`;
    if (item.ultimos4?.length > 0) return `Terminación detectada: •${esc(item.ultimos4[0].digitos)} (no coincide con ninguna de tus cuentas)`;
    return '';
  }

  /** Una línea por archivo: formato o banco, rango de fechas, movimientos y totales */
  function lineaArchivo(numero, item) {
    const t = totales(item.movimientos);
    return (
      `${numero}. ${esc(item.formato)} (${etiquetaFuente(item)}) - ${formatearFechaCL(t.desde)} al ${formatearFechaCL(t.hasta)} - ` +
      `${item.movimientos.length} mov. - cargos ${dinero(t.sumaCargos)}, abonos ${dinero(t.sumaAbonos)}` +
      (item.deteccion?.por === 'digitos' || item.deteccion?.por === 'texto'
        ? ` - cuenta detectada: ${cuentaConDigitos(item.deteccion)}`
        : item.cuentaSugerida ? ` - cuenta sugerida: ${esc(item.cuentaSugerida.nombre)}` : '')
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
      if (EXT_IMAGEN.includes(ext)) {
        // Foto de una cartola: OCR local y las mismas reglas del PDF (sin IA). Las tablas salen peor que en un PDF.
        const { leerTextoDeImagen } = await import('../ocr.js');
        const r = analizarTexto(await leerTextoDeImagen(buffer));
        if (r.movimientos.length === 0) return { estado: 'ilegible' };
        return {
          estado: 'ok', movimientos: r.movimientos, origen: 'ocr', banco: r.banco,
          ultimos4: r.ultimos4 ?? [], formato: r.banco ?? 'Foto de cartola'
        };
      }
      if (ext === '.pdf') {
        const r = await analizarPDF(buffer, { interpretarConIA: interpretarMovimientosCartola });
        if (r.escaneado) return { estado: 'escaneado' };
        if (r.movimientos.length === 0) return { estado: 'ilegible' };
        return {
          estado: 'ok',
          movimientos: r.movimientos,
          origen: r.origen,
          banco: r.banco,
          ultimos4: r.ultimos4 ?? [],
          formato: r.banco ?? 'PDF sin banco reconocido'
        };
      }

      const r = await analizarCartola(buffer, ext);
      if (r.esManual || r.movimientos.length === 0) return { estado: 'ilegible' };
      const nombre = r.formato?.banco;
      const reconocido = nombre && !['Genérico', 'Manual'].includes(nombre) ? nombre : null;
      return {
        estado: 'ok', movimientos: r.movimientos, origen: null, banco: reconocido,
        ultimos4: r.ultimos4 ?? [], formato: nombre ?? 'Formato genérico'
      };
    } catch {
      return { estado: 'ilegible' };
    }
  }

  // -------------------------------------------------------------------------
  // Cola por chat
  // -------------------------------------------------------------------------

  /** Texto sobre las cartolas que llegó hace poco (antes de los archivos), si sigue vigente */
  function contextoPrevio(chatId) {
    const previo = previos.get(chatId);
    if (!previo) return null;
    if (previo.hasta < Date.now()) {
      previos.delete(chatId);
      return null;
    }
    return previo.contexto;
  }

  /**
   * Recibe un archivo ya descargado. Lo agrupa con los que lleguen seguidos y, cuando pasa la
   * ventana sin más archivos, analiza el lote completo. `caption` es el texto con que llegó ("son de la tarjeta 8263").
   */
  async function recibirArchivo(chatId, { nombre, buffer, ext, mediaGroupId = null, mensajeId = null, caption = null }) {
    let cola = colas.get(chatId);
    const primero = !cola;
    if (!cola) {
      cola = { items: [], timer: null, contextoTexto: null };
      colas.set(chatId, cola);
    }
    const contexto = caption ? leerContextoCartola(caption) : null;
    cola.items.push({ nombre, buffer, ext, mediaGroupId, mensajeId, contexto: contextoUtil(contexto) ? contexto : null });
    // Un comprobante que llegue junto con la cartola espera a que se analice (ver loteTerceros.js)
    ctx.terceros?.avisarArchivo(chatId);

    clearTimeout(cola.timer);
    const esAlbum = cola.items.every(i => i.mediaGroupId && i.mediaGroupId === cola.items[0].mediaGroupId);
    cola.timer = setTimeout(() => cerrarCola(chatId), esAlbum ? VENTANA_ALBUM_MS : VENTANA_LOTE_MS);

    if (primero) {
      await enviar(chatId, 'Recibí el archivo. Si mandas más seguidos los agrupo en un solo resumen.');
    }
  }

  /**
   * ¿Esta foto es una cartola? Sí si su caption lo dice ("cartola de la 8263", "son de la tarjeta 8263"), si es del álbum cuyo
   * caption lo dijo o si llega sin texto justo después de un mensaje que lo dice.
   */
  function esFotoDeCartola(chatId, { caption = null, mediaGroupId = null } = {}) {
    const grupo = mediaGroupId ? `${chatId}_${mediaGroupId}` : null;
    if (caption && leerContextoCartola(caption).esCartola) {
      if (grupo) albumesCartola.add(grupo);
      return true;
    }
    if (grupo && albumesCartola.has(grupo)) return true;
    if (!caption && contextoPrevio(chatId)?.esCartola) return true;
    return false;
  }

  /** Recibe la foto de una cartola (ya descargada): se lee con OCR como una cartola más */
  async function recibirFoto(chatId, { buffer, mediaGroupId = null, mensajeId = null, caption = null }) {
    return recibirArchivo(chatId, { nombre: `foto_cartola_${Date.now()}.jpg`, buffer, ext: '.jpg', mediaGroupId, mensajeId, caption });
  }

  function cerrarCola(chatId) {
    const cola = colas.get(chatId);
    if (!cola) return;
    colas.delete(chatId);

    // El texto de un envío vale para todas sus cartolas: el de cada archivo, si no el de su álbum o el de alguno de
    // los archivos del envío, el que se escribió después y, por último, el que llegó justo antes
    const previo = contextoPrevio(chatId);
    const delEnvio = cola.items.find(i => i.contexto)?.contexto ?? null;
    for (const item of cola.items) {
      const delAlbum = item.mediaGroupId ? cola.items.find(i => i.mediaGroupId === item.mediaGroupId && i.contexto)?.contexto : null;
      item.contexto = item.contexto ?? delAlbum ?? delEnvio ?? cola.contextoTexto ?? previo ?? null;
    }
    if (previo) previos.delete(chatId);

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
        const esFoto = EXT_IMAGEN.includes(archivo.ext);
        avisos.push(
          analisis.estado === 'escaneado'
            ? `${prefijo}este PDF parece escaneado y no tiene texto, mándame la cartola descargada desde el banco. Dejé el archivo guardado.`
            : esFoto
              ? `${prefijo}no pude leer los movimientos de esta foto (las tablas se leen mal en una imagen). Mándame el PDF de la cartola. Dejé la foto guardada.`
              : `${prefijo}no pude leer los movimientos${archivo.ext === '.pdf' ? ' de este PDF (no reconozco su formato)' : ''}. Dejé el archivo guardado.`
        );
        continue;
      }

      const tmp = await guardarTemporal(archivo.nombre, archivo.buffer);
      validos.push({
        tmp: tmp.ruta,
        hash,
        ext: archivo.ext,
        esPDF: archivo.ext === '.pdf' || EXT_IMAGEN.includes(archivo.ext),
        origen: analisis.origen,
        banco: analisis.banco,
        ultimos4: analisis.ultimos4 ?? [],
        formato: analisis.formato,
        movimientos: analisis.movimientos,
        estado: 'pendiente',
        importados: 0,
        duplicados: 0,
        cuentaNombre: null,
        contexto: archivo.contexto ?? null,
        mensajeUsuarioId: archivo.mensajeId ?? null,
        archivoId: null
      });
    }

    if (validos.length === 0) {
      if (avisos.length > 0) await enviar(chatId, avisos.map(a => esc(a)).join('\n'));
      return;
    }

    const cuentas = await listarCuentasConBanco();
    if (cuentas.length === 0 && !validos.some(i => contextoUtil(i.contexto))) {
      for (const item of validos) await borrarTemporal(item.tmp);
      await enviar(chatId, 'No tienes cuentas activas. Crea una con /savecard y vuelve a enviar la cartola.');
      return;
    }
    for (const item of validos) {
      item.deteccion = detectarCuenta({ banco: item.banco, ultimos4: item.ultimos4 }, cuentas);
      item.cuentaSugerida = item.deteccion?.cuenta ?? null;
    }

    // El texto que acompañó a las cartolas se cruza con las cuentas y con lo que trae cada archivo. Si algo no calza
    // se pregunta con botones y el envío sigue cuando todo está respondido.
    const dudas = validos.filter(item => evaluarContexto(item, cuentas));
    const seguir = () => continuarLote(chatId, validos, avisos, cuentas);
    if (dudas.length === 0) {
      await seguir();
      return;
    }
    const espera = { restantes: dudas.length, seguir, timer: null };
    espera.timer = setTimeout(() => {
      if (espera.restantes > 0) {
        espera.restantes = 0;
        seguir().catch(() => {});
      }
    }, ESPERA_MS / 12);
    espera.timer.unref?.();
    for (const item of dudas) await preguntarContexto(chatId, item, cuentas, espera);
  }

  /** Lo que sigue una vez resuelta la cuenta de cada cartola: las de otra persona, y el resto al flujo de siempre */
  async function continuarLote(chatId, validos, avisos, cuentas) {
    // Cuenta con un vínculo distinto al de la cartola: se ofrece actualizarlo (nunca se cambia sin confirmar)
    for (const item of validos) {
      const cuenta = item.cuentaSugerida;
      const candidato = cuenta ? candidatoVinculo(item.ultimos4, cuenta, cuentas) : null;
      if (candidato) await preguntarGuardarDigitos(chatId, cuenta, candidato);
    }

    // Cartolas de la tarjeta de otra persona (por ejemplo la tía Valeska): flujo propio, sin importarlas
    // como gastos de Juan (loteTerceros.js). Las demás siguen el flujo de siempre.
    let propios = validos;
    if (ctx.terceros) {
      propios = [];
      for (const item of validos) {
        const tomada = await ctx.terceros.procesarCartola(chatId, item, cuentas, (it) => ofrecerUno(chatId, it, cuentas));
        if (!tomada) propios.push(item);
      }
      if (propios.length === 0) {
        if (avisos.length > 0) await enviar(chatId, avisos.map(a => esc(a)).join('\n'));
        return;
      }
    }

    if (propios.length === 1) {
      if (avisos.length > 0) await enviar(chatId, avisos.map(a => esc(a)).join('\n'));
      await ofrecerUno(chatId, propios[0], cuentas);
      return;
    }

    await ofrecerLote(chatId, propios, avisos, cuentas);
  }

  // -------------------------------------------------------------------------
  // Texto que acompaña a las cartolas
  // -------------------------------------------------------------------------

  /**
   * Cruza el texto con las cuentas. Si todo calza fija la cuenta del item (y la nota de una línea) y devuelve null; si hay
   * algo que preguntar devuelve la duda: { tipo: 'conflicto' | 'sin_cuenta', cruce }.
   */
  function evaluarContexto(item, cuentas) {
    if (!contextoUtil(item.contexto)) return null;
    const delArchivo = (item.ultimos4 ?? []).map(u => u.digitos);
    const cruce = cruzarContextoConCuentas(item.contexto, cuentas, delArchivo);

    if (cruce.estado === 'coincide' || cruce.estado === 'segun_texto') {
      const cuenta = cruce.cuenta;
      const digitos = delArchivo.find(d => d === cuenta.ultimos4 || d === cuenta.ultimos4_cuenta) ?? item.contexto.digitos ?? cuenta.ultimos4 ?? cuenta.ultimos4_cuenta ?? null;
      item.deteccion = { cuenta, por: cruce.estado === 'coincide' ? 'digitos' : 'texto', digitos };
      item.cuentaSugerida = cuenta;
      item.notaContexto = cruce.estado === 'coincide'
        ? `Cartola de ${cuenta.nombre}${digitos ? ` ****${digitos}` : ''}, los dígitos coinciden`
        : `Cartola de ${cuenta.nombre}${digitos ? ` ****${digitos}` : ''}, según tu mensaje`;
      return null;
    }
    if (cruce.estado === 'no_coincide') return (item.duda = { tipo: 'conflicto', cruce });
    if (cruce.estado === 'sin_cuenta') return (item.duda = { tipo: 'sin_cuenta', cruce });
    return null;
  }

  async function preguntarContexto(chatId, item, cuentas, espera) {
    const key = nuevaClave(chatId);
    const { tipo, cruce } = item.duda;
    const c = item.contexto;
    const delArchivo = item.ultimos4?.[0]?.digitos ?? null;
    preguntasContexto.set(key, { chatId, item, cuentas, tipo, cruce, espera });
    setTimeout(() => preguntasContexto.delete(key), ESPERA_MS).unref?.();

    const botones = [];
    let texto;
    if (tipo === 'conflicto') {
      texto =
        `Dices que la cartola es de <b>${esc(cruce.cuenta.nombre)}</b> (****${esc(c.digitos ?? cruce.cuenta.ultimos4 ?? '')}), ` +
        `pero el archivo trae ****${esc(delArchivo ?? '')}${cruce.otraCuenta ? ` (${esc(cruce.otraCuenta.nombre)})` : ''}. ¿Cuál uso?`;
      botones.push([{ text: `Usar ${cruce.cuenta.nombre}`.slice(0, 50), callback_data: `cxt_${key}` }]);
      if (cruce.otraCuenta) botones.push([{ text: `Usar ${cruce.otraCuenta.nombre}`.slice(0, 50), callback_data: `cxc_${key}` }]);
      botones.push([{ text: 'Elegir otra cuenta', callback_data: `cxo_${key}` }]);
    } else {
      const detectada = item.deteccion?.cuenta ?? null;
      texto =
        `No tengo ninguna cuenta con ****${esc(c.digitos)}. ¿Creo ${esc(describirContexto(c))}?` +
        (detectada ? `\nLa cartola calza con ${esc(detectada.nombre)}.` : '');
      botones.push([{ text: 'Crear la cuenta', callback_data: `cxn_${key}` }]);
      if (detectada) {
        botones.push([{ text: `Usar ${detectada.nombre}`.slice(0, 50), callback_data: `cxu_${key}` }]);
        // El texto habló de una cuenta (corriente, vista...) y la tarjeta detectada tiene vinculada otra
        if (String(c.tipo ?? '').startsWith('cuenta') && detectada.ultimos4_cuenta && detectada.ultimos4_cuenta !== c.digitos) {
          botones.push([{ text: `Actualizar cuenta de ${detectada.nombre} a ****${c.digitos}`.slice(0, 60), callback_data: `cxv_${key}` }]);
        }
      }
      botones.push([{ text: 'Elegir otra cuenta', callback_data: `cxo_${key}` }]);
    }
    await enviar(chatId, texto, { reply_markup: { inline_keyboard: botones } });
  }

  /** Crea la cuenta que mencionó el texto (con su titular) y la deja disponible para el envío */
  async function crearCuentaDeContexto(item, cuentas) {
    const c = item.contexto;
    const tipo = c.tipo ?? 'credito';
    const esTarjeta = tipo === 'credito' || tipo === 'debito';
    const datos = {
      tipo,
      banco: item.banco ?? null,
      titular: c.titular ?? null,
      ultimos4: esTarjeta ? c.digitos : null,
      ultimos4Cuenta: esTarjeta ? null : c.digitos
    };
    datos.nombre = nombreAutomatico({ tipo, titular: datos.titular, ultimos4: datos.ultimos4, ultimos4Cuenta: datos.ultimos4Cuenta });
    const id = await ctx.crearCuenta(datos);
    const cuenta = {
      id: Number(id), nombre: datos.nombre, banco: datos.banco, tipo: TIPO_DB[tipo], titular: datos.titular,
      ultimos4: datos.ultimos4, ultimos4_cuenta: datos.ultimos4Cuenta
    };
    cuentas.push(cuenta);
    return cuenta;
  }

  /** Una cuenta fija la detección del item: "digitos" (vino del archivo) o "texto" (la dijo el mensaje) */
  function fijarCuentaDeContexto(item, cuenta, por) {
    const digitos = cuenta.ultimos4 ?? cuenta.ultimos4_cuenta ?? null;
    item.deteccion = { cuenta, por, digitos };
    item.cuentaSugerida = cuenta;
    item.notaContexto = `Cartola de ${cuenta.nombre}${digitos ? ` ****${digitos}` : ''}, según tu mensaje`;
  }

  async function resolverContexto(cb, chatId, accion, key) {
    const messageId = cb.message.message_id;
    const pregunta = preguntasContexto.get(key);
    if (!pregunta) {
      await responderCallback(cb.id, { text: 'Solicitud expirada' });
      return;
    }
    preguntasContexto.delete(key);
    const { item, cuentas, cruce, espera } = pregunta;
    let cierre;

    try {
      if (accion === 't') {
        fijarCuentaDeContexto(item, cruce.cuenta, 'texto');
        cierre = `Uso ${esc(cruce.cuenta.nombre)}.`;
      } else if (accion === 'c') {
        item.deteccion = { cuenta: cruce.otraCuenta, por: 'digitos', digitos: item.ultimos4?.[0]?.digitos ?? null };
        item.cuentaSugerida = cruce.otraCuenta;
        item.notaContexto = null;
        cierre = `Uso ${esc(cruce.otraCuenta.nombre)}.`;
      } else if (accion === 'u') {
        item.notaContexto = null;
        cierre = `Uso ${esc(item.cuentaSugerida?.nombre ?? 'la cuenta detectada')}.`;
      } else if (accion === 'n') {
        const cuenta = await crearCuentaDeContexto(item, cuentas);
        fijarCuentaDeContexto(item, cuenta, 'texto');
        cierre = `Creé la cuenta <b>${esc(cuenta.nombre)}</b>${cuenta.titular ? ` (titular ${esc(cuenta.titular)})` : ''}.`;
      } else if (accion === 'v') {
        const cuenta = item.deteccion?.cuenta;
        const guardado = cuenta ? await guardarDigitosCuenta(cuenta.id, 'cuenta', item.contexto.digitos) : false;
        if (guardado) cuenta.ultimos4_cuenta = item.contexto.digitos;
        cierre = guardado ? `Listo: la cuenta de ${esc(cuenta.nombre)} ahora termina en ****${esc(item.contexto.digitos)}.` : 'No pude actualizar la cuenta vinculada.';
      } else {
        // Elegir otra: se pregunta la cuenta como siempre, sin sugerencia
        item.deteccion = null;
        item.cuentaSugerida = null;
        item.notaContexto = null;
        cierre = 'Entendido, te pregunto la cuenta al importar.';
      }
    } catch (error) {
      console.error('Error al resolver el texto de una cartola:', error.code ?? error.name);
      item.deteccion = null;
      item.cuentaSugerida = null;
      cierre = 'No pude hacerlo; te pregunto la cuenta al importar.';
    }

    item.duda = null;
    await editar(cierre, { chat_id: pregunta.chatId, message_id: messageId });
    await responderCallback(cb.id, {});
    espera.restantes--;
    if (espera.restantes === 0) {
      clearTimeout(espera.timer);
      await espera.seguir();
    }
  }

  const descripcionVacia = (c) => !contextoUtil(c);

  /**
   * Texto suelto sobre las cartolas ("son de la tarjeta 8263", "cartola de la 8263", "es de la crédito de Valeska").
   * Si hay archivos esperando o ya mostrados (menos de 2 minutos) se aplica a ellos; si no, se recuerda para las que
   * lleguen en los próximos 2 minutos. Devuelve true si el mensaje era de eso.
   */
  async function manejarTexto(chatId, texto) {
    const contexto = leerContextoCartola(texto);
    if (!contexto.esCartola || descripcionVacia(contexto)) return false;

    // 1) Archivos que todavía se están agrupando
    const cola = colas.get(chatId);
    if (cola) {
      cola.contextoTexto = contexto;
      await enviar(chatId, `Anotado: ${esc(describirContexto(contexto))}. Lo aplico a las cartolas de este envío.`);
      return true;
    }

    // 2) Cartolas ya mostradas que esperan una respuesta
    const limite = Date.now() - VENTANA_CONTEXTO_MS;
    const unos = [...pendientes.entries()].filter(([, p]) => p.chatId === chatId && p.creadoEn >= limite && !p.contexto);
    const lote = [...lotes.entries()].find(([, l]) => l.chatId === chatId && l.creadoEn >= limite && !l.modo);
    if (unos.length > 0 || lote) {
      const cuentas = await listarCuentasConBanco();
      const items = [...unos.map(([, p]) => p), ...(lote ? lote[1].items.filter(i => i.estado === 'pendiente') : [])];
      for (const item of items) item.contexto = contexto;
      const dudas = items.filter(item => evaluarContexto(item, cuentas));

      const seguir = async () => {
        // Las cartolas sueltas se vuelven a mostrar con la cuenta ya resuelta; las de un lote la leen al preguntar
        for (const [key, p] of unos) {
          pendientes.delete(key);
          await ofrecerUno(chatId, p, cuentas);
        }
      };
      if (dudas.length === 0) {
        const hay = items.some(i => i.cuentaSugerida);
        await enviar(chatId, hay ? esc(items.find(i => i.notaContexto)?.notaContexto ?? 'Anotado.') : 'Anotado, pero con eso no pude identificar la cuenta. Te la pregunto al importar.');
        await seguir();
        return true;
      }
      const espera = { restantes: dudas.length, seguir, timer: null };
      for (const item of dudas) await preguntarContexto(chatId, item, cuentas, espera);
      return true;
    }

    // 3) Todavía no llegaron: vale para las próximas
    previos.set(chatId, { contexto, hasta: Date.now() + VENTANA_CONTEXTO_MS });
    await enviar(chatId, `Anotado: ${esc(describirContexto(contexto))}. Mándame la cartola (foto o PDF) en los próximos 2 minutos y la tomo como esa.`);
    return true;
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
    pendientes.set(key, { ...item, cuentas, chatId, creadoEn: Date.now() });
    setTimeout(async () => {
      if (pendientes.delete(key)) await borrarTemporal(item.tmp);
    }, ESPERA_MS);

    if (!item.esPDF) {
      await pedirCuentaUno(
        chatId, key,
        `<b>Cartola recibida</b>\n\nFormato detectado: ${esc(item.formato)}\n${resumenTexto(item.movimientos)}` +
          (lineaDeteccion(item) ? `\n${lineaDeteccion(item)}` : ''),
        cuentas, item.cuentaSugerida
      );
      return;
    }

    // PDF: lectura menos confiable, se muestra una vista previa y se pide confirmar antes de elegir cuenta
    await enviar(chatId,
      `<b>${EXT_IMAGEN.includes(item.ext) ? 'Cartola en foto leída' : 'Cartola en PDF leída'}</b>\n\n` +
      `Lectura automática ${item.origen === 'ia' ? 'con ayuda de IA' : item.origen === 'ocr' ? 'con OCR de la foto (las tablas se leen peor que en un PDF)' : 'por reglas'}: revisa que los datos sean correctos.\n\n` +
      `${resumenTexto(item.movimientos)}${lineaDeteccion(item) ? `\n${lineaDeteccion(item)}` : ''}\n\n<b>Primeros movimientos:</b>\n${vistaPrevia(item.movimientos)}`,
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
    const lote = { chatId, creadoEn: Date.now(), items, cuentas, modo: null, ocupado: false, registrados: [], grupos: [], digitosPorPreguntar: [] };
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
      (lineaDeteccion(item) ? `\n${lineaDeteccion(item)}` : '') +
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
      const { importados, registrados, archivoId, duplicados } = await registrarImportacion({
        archivo: ruta,
        hash: item.hash,
        cuentaId: cuenta.id,
        movimientos: item.movimientos
      });
      item.duplicados = duplicados ?? 0;
      item.archivoId = archivoId;
      item.estado = 'importado';
      item.importados = importados;
      item.cuentaNombre = cuenta.nombre;
      lote.registrados.push(...registrados);
      lote.grupos.push({ cuentaId: cuenta.id, registrados });
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
      if (item.estado === 'importado') return `${i + 1}. ${item.importados} movimientos en ${esc(item.cuentaNombre)}${textoDuplicados(item.duplicados)}`;
      if (item.estado === 'error') return `${i + 1}. no se pudo importar (el archivo quedó pendiente)`;
      return `${i + 1}. omitido`;
    });
    const total = lote.items.reduce((suma, item) => suma + item.importados, 0);
    const resumen = await enviar(chatId, `<b>Listo: importé ${total} movimientos</b>\n\n${lineas.join('\n')}`);

    // Cada archivo importado queda ligado al mensaje en que Juan lo mandó; el resumen solo si fue uno
    const importadas = lote.items.filter(item => item.estado === 'importado' && item.archivoId);
    for (const item of importadas) {
      await vincular(chatId, [item.mensajeUsuarioId], 'importacion', item.archivoId);
    }
    if (importadas.length === 1) await vincular(chatId, [resumen?.message_id], 'importacion', importadas[0].archivoId);

    // Dígitos nuevos de las cuentas elegidas a mano, y luego las preguntas de cuotas, todas juntas al final
    await vaciarPreguntasDigitos(chatId, lote);
    await procesarImportados(chatId, lote.grupos);
  }

  async function cancelarLote(chatId, key, messageId) {
    const lote = lotes.get(key);
    lotes.delete(key);
    if (lote) {
      for (const item of lote.items) if (item.estado === 'pendiente') await borrarTemporal(item.tmp);
    }
    await editar('Importación cancelada. Descarté los archivos pendientes.', { chat_id: chatId, message_id: messageId });
    // Lo que ya se había importado sigue su camino: dígitos nuevos y preguntas de cuotas
    if (lote) await vaciarPreguntasDigitos(chatId, lote);
    if (lote?.registrados.length > 0) await procesarImportados(chatId, lote.grupos);
  }

  // -------------------------------------------------------------------------
  // Dígitos de la cartola que no coinciden con ninguna cuenta
  // -------------------------------------------------------------------------

  /** "¿Guardo •1234 en esta cuenta para reconocerla la próxima vez?" con botones */
  async function preguntarGuardarDigitos(chatId, cuenta, candidato) {
    const key = nuevaClave(chatId);
    digitosPendientes.set(key, { cuentaId: cuenta.id, nombre: cuenta.nombre, digitos: candidato.digitos, tipo: candidato.tipo });
    setTimeout(() => digitosPendientes.delete(key), ESPERA_MS);

    await enviar(chatId,
      candidato.reemplaza
        ? `${esc(cuenta.nombre)} tiene vinculada la cuenta •${esc(candidato.reemplaza)}, pero esta cartola trae •${esc(candidato.digitos)}. ¿Actualizo el vínculo a •${esc(candidato.digitos)}?`
        : `¿Guardo •${esc(candidato.digitos)} en esta cuenta (${esc(cuenta.nombre)}) para reconocerla la próxima vez?`,
      {
        reply_markup: {
          inline_keyboard: [[
            { text: 'Sí, guardar', callback_data: `cad_${key}` },
            { text: 'No', callback_data: `can_${key}` }
          ]]
        }
      }
    );
  }

  /**
   * "la FAN termina en 6958": propone guardar esos 4 dígitos en la cuenta nombrada, con botones.
   * `datos`: { termino, digitos, tipo }. Nunca guarda sin confirmar; reutiliza los botones de dígitos.
   */
  async function proponerDigitos(chatId, datos) {
    try {
      const cuentas = await listarCuentasConBanco();
      const hallada = buscarCuentaPorTexto(datos.termino, cuentas);
      if (!hallada) {
        await enviar(chatId, `No encontré una cuenta que calce con «${esc(datos.termino)}». Escribe /cuentas para ver las que tienes.`);
        return;
      }
      if (hallada.ambiguas) {
        await enviar(chatId, `Hay varias cuentas que calzan: ${hallada.ambiguas.map(c => esc(c.nombre)).join(', ')}. Dime cuál con su nombre.`);
        return;
      }

      const cuenta = hallada.cuenta;
      // Sin "cuenta"/"tarjeta" en el texto, se decide por el tipo de la cuenta
      const tipo = datos.tipo ?? (String(cuenta.tipo).startsWith('tarjeta') ? 'tarjeta' : 'cuenta');
      const columna = tipo === 'cuenta' ? 'ultimos4_cuenta' : 'ultimos4';

      const otra = cuentas.find(c => c.id !== cuenta.id && c[columna] === datos.digitos);
      if (otra) {
        await enviar(chatId, `Esos dígitos (•${esc(datos.digitos)}) ya están asignados a ${esc(otra.nombre)}. No los asigné.`);
        return;
      }
      if (cuenta[columna] === datos.digitos) {
        await enviar(chatId, `${esc(cuenta.nombre)} ya tiene •${esc(datos.digitos)}.`);
        return;
      }

      const key = nuevaClave(chatId);
      digitosPendientes.set(key, { cuentaId: cuenta.id, nombre: cuenta.nombre, digitos: datos.digitos, tipo });
      setTimeout(() => digitosPendientes.delete(key), ESPERA_MS);

      await enviar(chatId,
        `¿Guardo •${esc(datos.digitos)} como los últimos 4 ${tipo === 'cuenta' ? 'del número de cuenta' : 'de la tarjeta'} de ${esc(cuenta.nombre)}?` +
        (cuenta[columna] ? ` Reemplaza a •${esc(cuenta[columna])}.` : ''),
        {
          reply_markup: {
            inline_keyboard: [[
              { text: 'Sí, guardar', callback_data: `cad_${key}` },
              { text: 'No', callback_data: `can_${key}` }
            ]]
          }
        }
      );
    } catch (error) {
      console.error('Error al proponer dígitos:', error.code ?? error.name);
      await enviar(chatId, 'No pude procesar eso. Inténtalo de nuevo.');
    }
  }

  /** En un lote las preguntas de dígitos se hacen al final, antes de las de cuotas */
  async function vaciarPreguntasDigitos(chatId, lote) {
    for (const { cuenta, candidato } of lote.digitosPorPreguntar.splice(0)) {
      await preguntarGuardarDigitos(chatId, cuenta, candidato);
    }
  }

  // -------------------------------------------------------------------------
  // Cuotas (siempre con botones, al final)
  // -------------------------------------------------------------------------

  /**
   * Lo importado pasa primero por la clasificación de transferencias (internas, pagos de cuotas, destinatarios
   * recordados o por preguntar) y lo que sobra, por la búsqueda de cuotas por alias de cartola.
   */
  async function procesarImportados(chatId, grupos) {
    let restantes = [];
    for (const { cuentaId, registrados } of grupos) {
      restantes.push(...(ctx.transferencias
        ? await ctx.transferencias.procesarMovimientos(chatId, registrados, { cuentaId })
        : registrados));
    }
    await preguntarPorCuotas(chatId, restantes);
  }

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

    // ---- Cruce del texto con las cuentas ----

    if ((m = data.match(/^cx([tcnuvo])_(.+)$/))) {
      await resolverContexto(cb, chatId, m[1], m[2]);
      return true;
    }

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
        chatId, key,
        `<b>Cartola en PDF</b>\n\n${resumenTexto(pendiente.movimientos)}${lineaDeteccion(pendiente) ? `\n${lineaDeteccion(pendiente)}` : ''}`,
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
        const { importados, registrados, archivoId, duplicados } = await registrarImportacion({
          archivo: ruta,
          hash: pendiente.hash,
          cuentaId: cuenta.id,
          movimientos: pendiente.movimientos
        });
        await editar(`Importé ${importados} movimientos en <b>${esc(cuenta.nombre)}</b>.${textoDuplicados(duplicados)}`, { chat_id: chatId, message_id: messageId });
        await vincular(chatId, [pendiente.mensajeUsuarioId, messageId], 'importacion', archivoId);
        await responderCallback(cb.id, { text: 'Importada' });

        // La cuenta se eligió a mano: si la cartola trae dígitos que no son de ninguna cuenta, se ofrece guardarlos
        const candidato = candidatoDigitos(pendiente.ultimos4, cuenta, pendiente.cuentas);
        if (candidato) await preguntarGuardarDigitos(chatId, cuenta, candidato);

        await procesarImportados(chatId, [{ cuentaId: cuenta.id, registrados }]);
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

    // ---- Guardar los dígitos para reconocer la cuenta ----

    if (data.startsWith('cad_')) {
      const key = data.replace('cad_', '');
      const pendiente = digitosPendientes.get(key);
      if (!pendiente) {
        await responderCallback(cb.id, { text: 'Solicitud expirada' });
        return true;
      }
      digitosPendientes.delete(key);
      try {
        const guardado = await guardarDigitosCuenta(pendiente.cuentaId, pendiente.tipo, pendiente.digitos);
        await editar(
          guardado
            ? `Listo: •${esc(pendiente.digitos)} queda asociada a ${esc(pendiente.nombre)}.`
            : 'No pude guardar esos dígitos.',
          { chat_id: chatId, message_id: messageId }
        );
        await responderCallback(cb.id, { text: guardado ? 'Guardado' : 'Sin cambios' });
      } catch (error) {
        console.error('Error al guardar los dígitos de la cuenta:', error.code ?? error.name);
        await responderCallback(cb.id, { text: 'Error al guardar' });
      }
      return true;
    }

    if (data.startsWith('can_')) {
      digitosPendientes.delete(data.replace('can_', ''));
      await editar('Entendido, no los guardo.', { chat_id: chatId, message_id: messageId });
      await responderCallback(cb.id, {});
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
        if (item.estado === 'importado') {
          const candidato = candidatoDigitos(item.ultimos4, cuenta, lote.cuentas);
          if (candidato) lote.digitosPorPreguntar.push({ cuenta, candidato });
        }
        await editar(
          item.estado === 'importado'
            ? `Importé ${item.importados} movimientos en <b>${esc(cuenta.nombre)}</b>.${textoDuplicados(item.duplicados)}`
            : 'No pude importar este archivo.',
          { chat_id: chatId, message_id: messageId }
        );
        if (item.estado === 'importado') await vincular(chatId, [item.mensajeUsuarioId, messageId], 'importacion', item.archivoId);
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

  return { recibirArchivo, recibirFoto, esFotoDeCartola, manejarTexto, manejarCallback, proponerDigitos };
}
