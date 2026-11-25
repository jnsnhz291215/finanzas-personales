/**
 * Límite simple de llamadas a Gemini por chat, en memoria: 30 por hora (ventana deslizante).
 * Se reinicia al reiniciar el servidor. Lo usan el enrutador de intenciones y el respaldo de
 * lectura de gastos; cuando se pasa, el bot sigue funcionando solo con sus reglas.
 */

export const LIMITE_POR_HORA = 30;
export const VENTANA_MS = 60 * 60 * 1000;

export function crearLimitador({ limite = LIMITE_POR_HORA, ventanaMs = VENTANA_MS, ahora = () => Date.now() } = {}) {
  // chatId -> instantes (ms) de las llamadas dentro de la ventana
  const usos = new Map();

  function vigentes(chatId) {
    const t = ahora();
    const lista = (usos.get(chatId) ?? []).filter(instante => t - instante < ventanaMs);
    usos.set(chatId, lista);
    return lista;
  }

  return {
    /** Registra una llamada. Devuelve false (y no la cuenta) si el chat ya llegó al límite. */
    consumir(chatId) {
      const lista = vigentes(chatId);
      if (lista.length >= limite) return false;
      lista.push(ahora());
      return true;
    },

    /** Llamadas que le quedan al chat en la ventana actual */
    restantes(chatId) {
      return Math.max(0, limite - vigentes(chatId).length);
    }
  };
}

// Instancia compartida del bot
export const limitadorGemini = crearLimitador();
