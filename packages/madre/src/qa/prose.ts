/**
 * Human writing layer.
 *
 * Two halves. `HUMAN_WRITING_GUIDE` is appended to every agent prompt so the
 * text comes out natural in the first place. `lintProse` checks the result for
 * the tells that make text read as machine-made: stock phrases, empty
 * openings, generic conclusions, and rhythm that is too even. Findings are
 * advice for a reviser; they never fail a mission by themselves.
 */

export const HUMAN_WRITING_GUIDE = [
  'ESTILO DE ESCRITURA',
  '- Escribe como un colega competente hablando de tú a tú: directo, concreto, palabras llanas.',
  '- Empieza por lo sustancial. Sin saludos, sin "aquí tienes", sin repetir la petición.',
  '- No uses muletillas como "es importante señalar", "cabe destacar", "en el mundo actual", "sin lugar a dudas", "ahondar", "desbloquear el potencial", "un antes y un después".',
  '- Varía la longitud de las frases. No construyas cada lista o párrafo con el mismo patrón.',
  '- Prefiere un ejemplo concreto a tres adjetivos abstractos.',
  '- Termina cuando hayas terminado. Sin resumen de lo que acabas de decir, sin ofrecerte a seguir ayudando.',
  '- Escribe en el idioma de la misión (español, inglés o italiano). Por defecto, español.',
].join('\n');

export interface ProseFinding {
  rule: 'stock_phrase' | 'empty_intro' | 'generic_conclusion' | 'repetitive_structure' | 'even_rhythm' | 'dash_overuse';
  message: string;
  excerpt: string;
}

const STOCK_PHRASES: RegExp[] = [
  // English
  /\bdelve[sd]?\b/i,
  /\bit(?:'s| is) (?:important|worth|crucial) (?:to )?(?:note|noting|mention|remember)\b/i,
  /\bin today(?:'s|s)? (?:fast-paced|digital|modern|ever-changing) world\b/i,
  /\bever-(?:evolving|changing) landscape\b/i,
  /\bunlock(?:ing)? the (?:power|potential)\b/i,
  /\bgame-?changer\b/i,
  /\bnavigate the complexities\b/i,
  /\bembark on a journey\b/i,
  /\brich tapestry\b/i,
  /\bseamless(?:ly)?\b/i,
  /\bI hope this helps\b/i,
  /\bas an ai\b/i,
  // Spanish
  /\bcabe (?:destacar|señalar|mencionar|resaltar)\b/i,
  /\bes (?:importante|crucial|fundamental|esencial|necesario) (?:destacar|señalar|mencionar|resaltar|recordar|tener en cuenta)\b/i,
  /\bvale la pena (?:destacar|mencionar|señalar)\b/i,
  /\ben el (?:mundo actual|vertiginoso mundo|cambiante mundo|mundo (?:actual|moderno|digital|globalizado))\b/i,
  /\ben (?:el|un) (?:vertiginoso|cambiante|acelerado) mundo\b/i,
  /\bhoy en d[ií]a,? en un mundo\b/i,
  /\bpanorama (?:en constante evoluci[oó]n|cambiante|actual en constante)\b/i,
  /\bdesbloquea(?:r|ndo)? el (?:poder|potencial)\b/i,
  /\bsin lugar a dudas\b/i,
  /\bno cabe (?:duda|la menor duda)\b/i,
  /\bun amplio abanico de\b/i,
  /\bun(?:a)? (?:amplio|amplia) (?:abanico|gama|variedad) de (?:posibilidades|oportunidades)\b/i,
  /\bahond(?:ar|ando|emos|aremos) en\b/i,
  /\bprofundicemos en\b/i,
  /\bnavegar por (?:las complejidades|la complejidad)\b/i,
  /\bembarcar(?:se|nos)? en (?:un viaje|una aventura)\b/i,
  /\bun antes y un despu[eé]s\b/i,
  /\bpiedra angular\b/i,
  /\bsin fisuras\b/i,
  /\bespero que (?:esto |esta informaci[oó]n )?(?:te |le |os )?(?:ayude|sea de ayuda|resulte [uú]til)\b/i,
  /\bcomo (?:modelo de lenguaje|(?:una )?(?:ia|inteligencia artificial))\b/i,
  // Italian
  /\bè importante (?:notare|sottolineare)\b/i,
  /\bnel mondo (?:frenetico|moderno) di oggi\b/i,
];

const EMPTY_INTRO =
  /^\s*¡?(?:sure|certainly|of course|absolutely|great question|claro|por supuesto|desde luego|genial|perfecto|excelente pregunta|buena pregunta|certo|certamente)!?[,!.]|^\s*here(?:'s| is| are) (?:a|an|the|your)\b|^\s*below (?:you will|is|are)\b|^\s*aqu[ií] (?:tienes|te dejo|te presento|va|encontrar[aá]s)\b|^\s*a continuaci[oó]n[,]? (?:te presento|te dejo|encontrar[aá]s|se (?:detalla|presenta|muestra|expone))\b|^\s*en este (?:documento|informe|an[aá]lisis) (?:te |se )?(?:presento|presenta|expongo|expone|analizo|analiza)\b/i;

const GENERIC_CONCLUSION =
  /^\s*(?:in conclusion|to sum up|to summari[sz]e|overall,|in summary|all in all|en conclusi[oó]n|en resumen|en s[ií]ntesis|resumiendo|recapitulando|para concluir|para terminar|para finalizar|en definitiva|en [uú]ltima instancia|in conclusione|in sintesi)\b/i;

function stripNonProse(text: string): string {
  return text
    .split('\n')
    .filter((l) => !/^\s*>/.test(l) && !/^\s*\|/.test(l) && !/^\s*```/.test(l))
    .join('\n');
}

function sentences(text: string): string[] {
  return text
    .replace(/^#+\s.*$/gm, '')
    .replace(/^\s*(?:[-*]|\d+[.)])\s+/gm, '')
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.trim())
    .filter((s) => s.split(/\s+/).length >= 3);
}

export function lintProse(input: string): ProseFinding[] {
  const text = stripNonProse(input);
  const findings: ProseFinding[] = [];

  for (const re of STOCK_PHRASES) {
    const m = re.exec(text);
    if (m !== null) findings.push({ rule: 'stock_phrase', message: `Muletilla: «${m[0]}». Dilo directamente.`, excerpt: m[0] });
  }

  const paragraphs = text.split(/\n\s*\n/).map((p) => p.trim()).filter((p) => p.length > 0 && !/^#/.test(p));
  const first = paragraphs[0];
  if (first !== undefined && EMPTY_INTRO.test(first)) {
    findings.push({ rule: 'empty_intro', message: 'El texto abre con relleno en vez de ir al grano.', excerpt: first.slice(0, 80) });
  }
  const last = paragraphs.at(-1);
  if (last !== undefined && GENERIC_CONCLUSION.test(last)) {
    findings.push({ rule: 'generic_conclusion', message: 'El texto cierra con un resumen genérico que no aporta nada.', excerpt: last.slice(0, 80) });
  }

  // Three or more consecutive lines that begin with the same two words.
  const lines = text
    .split('\n')
    .map((l) => l.replace(/^\s*(?:[-*]|\d+[.)])\s+/, '').replace(/[*_`]/g, '').trim())
    .filter((l) => l.length > 0 && !/^#/.test(l));
  let run = 1;
  for (let i = 1; i < lines.length; i++) {
    const a = lines[i - 1]!.split(/\s+/).slice(0, 2).join(' ').toLowerCase();
    const b = lines[i]!.split(/\s+/).slice(0, 2).join(' ').toLowerCase();
    run = a === b && a.length > 0 ? run + 1 : 1;
    if (run === 3) {
      findings.push({ rule: 'repetitive_structure', message: `Tres líneas seguidas empiezan por «${b}». Varía la construcción.`, excerpt: lines[i]!.slice(0, 80) });
      break;
    }
  }

  const sents = sentences(text);
  if (sents.length >= 6) {
    const lengths = sents.map((s) => s.split(/\s+/).length);
    const mean = lengths.reduce((a, b) => a + b, 0) / lengths.length;
    const variance = lengths.reduce((a, b) => a + (b - mean) ** 2, 0) / lengths.length;
    const cv = Math.sqrt(variance) / mean;
    if (cv < 0.2) {
      findings.push({
        rule: 'even_rhythm',
        message: `Casi todas las frases miden lo mismo (unas ${Math.round(mean)} palabras). Alterna frases cortas y largas.`,
        excerpt: sents[0]!.slice(0, 80),
      });
    }
  }

  const words = text.split(/\s+/).filter(Boolean).length;
  const dashes = (text.match(/—/g) ?? []).length;
  if (words >= 80 && dashes / words > 0.03) {
    findings.push({ rule: 'dash_overuse', message: 'Demasiadas rayas (—); usa puntos o comas.', excerpt: '—' });
  }

  return findings;
}
