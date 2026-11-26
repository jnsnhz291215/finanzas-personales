/**
 * Lectura de texto de imágenes (capturas de comprobantes) con OCR local: tesseract.js con los datos de
 * idioma español que vienen en node_modules (@tesseract.js-data/spa). Nada sale del servidor y nada se
 * descarga en tiempo de ejecución.
 *
 * El texto leído puede traer RUT y números de cuenta: no se guarda, no se registra en los logs y solo
 * se usa para extraer monto, fecha y destinatario (comprobante.js).
 *
 * El OCR de capturas de apps bancarias no es perfecto: quien lo use debe confirmar con el usuario.
 */

import { createRequire } from 'module';

const require = createRequire(import.meta.url);

const TIMEOUT_OCR_MS = 60 * 1000;
const INACTIVIDAD_MS = 60 * 1000;

let workerEnCurso = null;
let temporizador = null;

async function obtenerWorker() {
  if (!workerEnCurso) {
    workerEnCurso = (async () => {
      const { createWorker } = await import('tesseract.js');
      const spa = require('@tesseract.js-data/spa');
      return createWorker('spa', 1, {
        langPath: spa.langPath,
        gzip: spa.gzip,
        cacheMethod: 'none',
        logger: () => {}
      });
    })().catch((error) => {
      workerEnCurso = null;
      throw error;
    });
  }
  return workerEnCurso;
}

/** Libera la memoria del OCR cuando lleva un rato sin usarse */
function programarCierre() {
  clearTimeout(temporizador);
  temporizador = setTimeout(async () => {
    const pendiente = workerEnCurso;
    workerEnCurso = null;
    try {
      await (await pendiente)?.terminate();
    } catch {
      // ya estaba cerrado
    }
  }, INACTIVIDAD_MS);
  temporizador.unref?.();
}

/** Texto de una imagen (Buffer). Lanza si el OCR no puede leerla en 60 s. Nunca registra el texto. */
export async function leerTextoDeImagen(buffer) {
  const lectura = (async () => {
    const worker = await obtenerWorker();
    const { data } = await worker.recognize(buffer);
    return String(data?.text ?? '');
  })();

  let temporizadorLectura;
  const limite = new Promise((_, reject) => {
    temporizadorLectura = setTimeout(() => reject(Object.assign(new Error('el OCR tardó demasiado'), { code: 'OCR_TIMEOUT' })), TIMEOUT_OCR_MS);
  });
  try {
    return await Promise.race([lectura, limite]);
  } finally {
    clearTimeout(temporizadorLectura);
    programarCierre();
  }
}
