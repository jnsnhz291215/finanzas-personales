/**
 * Detecta si un gasto es un préstamo ("le pagué 15 mil a Christian con la CMR, me lo
 * devuelve") y a quién. El préstamo se guarda en movimientos con es_prestamo y
 * persona_prestamo, que es lo que usan /deudas y /pago.
 */

function normalizar(texto) {
  return String(texto ?? '').normalize('NFC').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
}

// Frases que indican que el dinero se va a devolver o que se prestó
const SENALES_PRESTAMO = [
  /\bme lo (?:devuelve|devolvera|va a devolver|paga|pagara|va a pagar|devuelven)\b/,
  /\bme (?:debe|deben|devuelve|devolvera|pagara)\b/,
  /\b(?:le|les) preste\b/,
  /\bprestamo\b/,
  /\bprestado\b/
];

// Palabras con mayúscula que no son nombres de persona
const NO_PERSONAS = new Set(['Hoy', 'Ayer', 'Anteayer', 'Me', 'Le', 'Les', 'Lo', 'El', 'La']);

/**
 * @returns {{ esPrestamo: boolean, persona: string|null }}
 * La persona se toma de un nombre propio con mayúscula inicial: "a Christian" /
 * "para Pedro Soto", o "Christian me debe". Si no se encuentra, persona es null y el bot la pregunta.
 */
export function detectarPrestamo(texto) {
  const original = String(texto ?? '');
  const norm = normalizar(original);
  if (!SENALES_PRESTAMO.some(patron => patron.test(norm))) {
    return { esPrestamo: false, persona: null };
  }

  const nombre = '(\\p{Lu}\\p{Ll}+(?:\\s+\\p{Lu}\\p{Ll}+)?)';
  const candidatos = [
    new RegExp(`(?<![\\p{L}])(?:a|para)\\s+${nombre}`, 'u'),
    new RegExp(`${nombre}\\s+me\\s+(?:debe|deben|devuelve|devolvera|devolverá|pagara|pagará)`, 'u')
  ];
  for (const regex of candidatos) {
    const m = regex.exec(original);
    if (m) {
      const persona = m[1].split(/\s+/).filter(p => !NO_PERSONAS.has(p)).join(' ');
      if (persona) return { esPrestamo: true, persona };
    }
  }
  return { esPrestamo: true, persona: null };
}
