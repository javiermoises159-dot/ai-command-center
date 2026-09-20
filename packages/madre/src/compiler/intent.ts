/**
 * Intent classification.
 *
 * Reads a mission written in Spanish, English or Italian and works out what
 * kind of job it is. It is deliberately rule-based: it is deterministic, free,
 * runs offline, and every call it makes can be explained. Everything it
 * extracts is quoted from the text (places, amounts, timeframes) — nothing is
 * inferred. A model-backed classifier can replace it later behind the same
 * `IntentClassifier` interface.
 */

import type { AmountMention, Complexity, Language, MissionIntent, MissionKind } from '../types.ts';
import { clamp, round, unique } from '../util.ts';

export interface IntentClassifier {
  classify(text: string): MissionIntent;
}

// ---------------------------------------------------------------------------
// Language
// ---------------------------------------------------------------------------

const STOPWORDS: Record<Exclude<Language, 'unknown'>, string[]> = {
  es: ['el', 'la', 'los', 'las', 'una', 'un', 'de', 'del', 'que', 'quiero', 'para', 'con', 'por', 'en', 'y', 'mi', 'necesito', 'es', 'se', 'al'],
  en: ['the', 'a', 'an', 'of', 'to', 'and', 'for', 'with', 'my', 'want', 'need', 'is', 'in', 'on', 'that', 'this', 'i', 'our'],
  it: ['il', 'lo', 'la', 'gli', 'le', 'una', 'un', 'di', 'del', 'che', 'voglio', 'per', 'con', 'in', 'e', 'mio', 'devo', 'è', 'dei', 'nel'],
};

export function detectLanguage(text: string): Language {
  const words = text.toLowerCase().normalize('NFC').split(/[^\p{L}]+/u).filter(Boolean);
  if (words.length === 0) return 'unknown';
  const scores: [Language, number][] = (Object.keys(STOPWORDS) as (keyof typeof STOPWORDS)[]).map((lang) => [
    lang,
    words.filter((w) => STOPWORDS[lang].includes(w)).length,
  ]);
  // Distinctive characters break ties between es and it.
  if (/[ñ¿¡]/.test(text)) scores.find(([l]) => l === 'es')![1] += 2;
  if (/\b(?:della|degli|nelle|voglio|vorrei|negozio)\b/i.test(text)) scores.find(([l]) => l === 'it')![1] += 2;
  scores.sort((a, b) => b[1] - a[1]);
  const [best, second] = scores;
  if (best === undefined || best[1] === 0) return 'unknown';
  if (second !== undefined && best[1] === second[1]) return 'unknown';
  return best[0];
}

// ---------------------------------------------------------------------------
// Kind
// ---------------------------------------------------------------------------

/** Order breaks ties: the more specific intents come first. */
const KIND_ORDER: MissionKind[] = [
  'document_analysis',
  'market_research',
  'validation_experiment',
  'content_campaign',
  'financial_model',
  'growth',
  'product_build',
  'launch_business',
];

const KIND_PATTERNS: Record<Exclude<MissionKind, 'general'>, RegExp[]> = {
  launch_business: [
    /\b(?:lanzar|lanzamiento de|abrir|montar|crear|iniciar|arrancar|emprender|poner en marcha|sacar al mercado)\b.{0,40}\b(?:tienda|negocio|empresa|startup|marca|restaurante|cafeter[ií]a|panader[ií]a|ecommerce|e-commerce|suscripci[oó]n|servicio|consultor[ií]a|academia|club)\b/iu,
    /\b(?:launch|open|start|set up|build)\b.{0,40}\b(?:store|shop|business|company|startup|brand|restaurant|ecommerce|e-commerce)\b/iu,
    /\b(?:lanciare|aprire|avviare|creare)\b.{0,40}\b(?:negozio|attivit[aà]|azienda|startup|marchio|ristorante|shop)\b/iu,
    /\b(?:tienda online|online (?:store|shop)|negozio online|e-?commerce)\b/iu,
  ],
  market_research: [
    /\b(?:investig\w+|estudi\w+|analiz\w+)\b.{0,30}\b(?:mercado|competencia|competidores|sector)\b/iu,
    /\b(?:research|study|analy[sz]e|map)\b.{0,30}\b(?:market|competitors|competition|industry|sector)\b/iu,
    /\b(?:ricerca|studio|analisi)\b.{0,30}\b(?:mercato|concorrenti|settore)\b/iu,
    /\b(?:market research|estudio de mercado|investigaci[oó]n de mercado|an[aá]lisis de (?:mercado|la competencia)|an[aá]lisis competitivo|tama[nñ]o de mercado|ricerca di mercato)\b/iu,
  ],
  validation_experiment: [
    /\b(?:validar\w*|validaci[oó]n|experimento|comprobar si|probar (?:la )?idea|test de mercado|prueba de concepto|preventa|lista de espera)\b/iu,
    /\b(?:validate|validation|experiment|smoke test|test (?:the|my) idea|prove (?:demand|the idea))\b/iu,
    /\b(?:validare|validazione|esperimento|testare l'idea)\b/iu,
  ],
  content_campaign: [
    /\b(?:campa[nñ]a|contenido|contenidos|redes sociales|publicaciones|v[ií]deos?|anuncios|publicidad|reels?|tiktok|instagram|youtube|bolet[ií]n|calendario editorial|guion(?:es)?)\b/iu,
    /\b(?:campaign|content|social media|posts?|reels?|tiktok|instagram|youtube|newsletter)\b/iu,
    /\b(?:campagna|contenuti|social network|post)\b/iu,
  ],
  document_analysis: [
    /\b(?:analiz\w+|revis\w+|resum\w+|extra\w+|sintetiz\w+|lee|leer)\b.{0,40}\b(?:document\w*|contratos?|informes?|pdf|archivos?|actas?|facturas?|expedientes?|memorias?)\b/iu,
    /\b(?:analy[sz]e|review|summari[sz]e|read|go through)\b.{0,40}\b(?:documents?|contracts?|reports?|pdfs?|files?|papers?)\b/iu,
    /\b(?:analizza\w*|rivedi|riassumi|leggi)\b.{0,40}\b(?:document\w*|contratti?|rapporti|pdf|file)\b/iu,
  ],
  product_build: [
    /\b(?:aplicaci[oó]n|app|software|plataforma|sitio web|p[aá]gina web|api|bot|programar|desarrollar|construir)\b/iu,
    /\b(?:application|app|software|platform|website|web app|api|bot|develop|program|code)\b/iu,
    /\b(?:applicazione|piattaforma|sito web|sviluppare|programmare)\b/iu,
  ],
  growth: [
    /\b(?:crecer|crecimiento|escalar|afiliad\w+|captar clientes|conseguir clientes|adquisici[oó]n|referid\w+|fidelizaci[oó]n|fidelizar|retenci[oó]n de clientes|embudo de (?:ventas|conversi[oó]n))\b/iu,
    /\b(?:grow|growth|scale|affiliates?|acquire customers|get customers|acquisition|referrals?)\b/iu,
    /\b(?:crescita|scalare|affiliati|acquisire clienti)\b/iu,
  ],
  financial_model: [
    /\b(?:presupuesto|financi\w+|rentabilidad|rentable|precios?|margen(?:es)?|flujo de caja|costes?|costos?|ingresos|beneficios?|viabilidad econ[oó]mica|punto de equilibrio|punto muerto|tesorer[ií]a|cuenta de resultados|unit economics)\b/iu,
    /\b(?:budget|financ\w+|profitability|pricing|margins?|cash ?flow|unit economics|break-?even)\b/iu,
    /\b(?:budget|finanz\w+|redditivit[aà]|prezzi|margini|flusso di cassa)\b/iu,
  ],
};

interface KindScore {
  kind: MissionKind;
  score: number;
}

export function scoreKinds(text: string): KindScore[] {
  return KIND_ORDER.map((kind) => {
    const patterns = KIND_PATTERNS[kind as Exclude<MissionKind, 'general'>];
    return { kind, score: patterns.filter((p) => p.test(text)).length };
  }).filter((s) => s.score > 0);
}

// ---------------------------------------------------------------------------
// Mentions
// ---------------------------------------------------------------------------

const PLACE_RE = /\b(?:en|in|a|at|para|de|from|to|nel|nella|nello)\s+((?:[A-ZÁÉÍÓÚÑÀÈÌÒÙ][\p{L}'’-]+)(?:\s+(?:de|del|di|of|la|el)?\s*[A-ZÁÉÍÓÚÑÀÈÌÒÙ][\p{L}'’-]+)*)/gu;

const NOT_PLACES = new Set(['Instagram', 'TikTok', 'YouTube', 'Facebook', 'Google', 'Amazon', 'Shopify', 'WhatsApp', 'LinkedIn', 'Twitter']);

export function extractPlaces(text: string): string[] {
  const found: string[] = [];
  for (const match of text.matchAll(PLACE_RE)) {
    const place = match[1]?.trim();
    if (place && !NOT_PLACES.has(place)) found.push(place);
  }
  return unique(found);
}

const TIMEFRAME_RE =
  /\b(\d+\s*(?:d[ií]as?|semanas?|meses|mes|a[nñ]os?|days?|weeks?|months?|years?|giorni|settimane|mesi|anni)|hoy|ma[nñ]ana|today|tomorrow|(?:esta|this|questa)\s+(?:semana|week|settimana)|(?:este|this|questo)\s+(?:mes|month|mese)|(?:este|this|quest')\s*(?:a[nñ]o|year|anno)|Q[1-4](?:\s*\d{4})?)\b/giu;

export function extractTimeframes(text: string): string[] {
  return unique([...text.matchAll(TIMEFRAME_RE)].map((m) => m[1]!.replace(/\s+/g, ' ').trim()));
}

const AMOUNT_RE =
  /(?:(€|\$|£)\s*(\d[\d.,]*)\s*(k|mil|m|millones|million)?|(\d[\d.,]*)\s*(k|mil|m|millones|million)?\s*(€|\$|£|eur(?:os?)?|usd|d[oó]lares|dollars?|gbp))/giu;

function parseNumber(raw: string): number | null {
  let s = raw.replace(/[.,]$/, '');
  if (/^\d{1,3}(\.\d{3})+$/.test(s)) s = s.replace(/\./g, '');
  else if (/^\d{1,3}(,\d{3})+$/.test(s)) s = s.replace(/,/g, '');
  else s = s.replace(',', '.');
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

function currencyOf(symbol: string): string {
  const s = symbol.toLowerCase();
  if (s === '€' || s.startsWith('eur')) return 'EUR';
  if (s === '$' || s === 'usd' || s.startsWith('d') ) return 'USD';
  if (s === '£' || s === 'gbp') return 'GBP';
  return symbol.toUpperCase();
}

export function extractAmounts(text: string): AmountMention[] {
  const out: AmountMention[] = [];
  for (const m of text.matchAll(AMOUNT_RE)) {
    const numberText = m[2] ?? m[4];
    const suffix = (m[3] ?? m[5] ?? '').toLowerCase();
    const currency = m[1] ?? m[6];
    if (numberText === undefined || currency === undefined) continue;
    let value = parseNumber(numberText);
    if (value === null) continue;
    if (suffix === 'k' || suffix === 'mil') value *= 1000;
    else if (suffix === 'm' || suffix === 'millones' || suffix === 'million') value *= 1_000_000;
    out.push({ raw: m[0].trim(), value, currency: currencyOf(currency) });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Sensitivity and freshness
// ---------------------------------------------------------------------------

const FRESH_RE =
  /\b(?:actual\w*|hoy|[uú]ltim\w+|reciente\w*|tendencias?|noticias|precio actual|competidor\w*|competencia|regulaci[oó]n|ley|normativa|latest|current|recent|today|trend\w*|news|competitors?|regulation|law|attuale|ultimi|tendenze|concorrenti|normativa|mercato|mercado|market)\b/iu;
const MONEY_RE = /\b(?:presupuesto|invertir|inversi[oó]n|pagar|pago|cobrar|comisi[oó]n|comisiones|trading|budget|invest\w*|pay\w*|charge|commission|fees?|pagamento|investire|commissioni)\b|[€$£]/iu;
const PUBLISH_RE = /\b(?:publicar|publicaci[oó]n|subir|postear|redes sociales|tiktok|instagram|youtube|publish|post|upload|social media|pubblicare|social)\b/iu;
const EXTERNAL_RE = /\b(?:enviar|mandar|contactar|comprar|registrar|contratar|correo|email|send|contact|buy|purchase|register|hire|mail|inviare|contattare|comprare)\b/iu;
const PERSONAL_RE = /\b(?:dni|pasaporte|passport|datos personales|personal data|salud|health|n[oó]mina|payroll|iban|tarjeta|credit card|contrato|contract|codice fiscale|clientes?|customers? list)\b/iu;

// ---------------------------------------------------------------------------
// Subject
// ---------------------------------------------------------------------------

const LEAD_RE =
  /^\s*(?:por favor,?\s*|please,?\s*|per favore,?\s*)?(?:quiero|queremos|quisiera|necesito|necesitamos|me gustar[ií]a|nos gustar[ií]a|ay[uú]dame a|ayudame a|ay[uú]danos a|hazme|i want to|i want|i need to|i need|i'd like to|we want to|we need to|help me|can you|could you|vorrei|voglio|devo|aiutami a)\s+/iu;

export function extractSubject(text: string): string | null {
  const stripped = text
    .replace(/\[[a-z]+:[^\]]*\]/gi, ' ')
    .replace(/\s+/g, ' ')
    .replace(LEAD_RE, '')
    .replace(/[\s.!?¿¡]+$/u, '')
    .trim();
  if (stripped.length < 3) return null;
  return stripped.charAt(0).toLowerCase() === stripped.charAt(0) ? stripped : stripped;
}

// ---------------------------------------------------------------------------
// Ambiguities
// ---------------------------------------------------------------------------

function ambiguitiesFor(
  kind: MissionKind,
  text: string,
  m: MissionIntent['mentions'],
): string[] {
  const questions: string[] = [];
  const businessLike = kind === 'launch_business' || kind === 'growth' || kind === 'financial_model' || kind === 'product_build';
  if (businessLike && m.amounts.length === 0) questions.push('¿Qué presupuesto hay disponible, si lo hay?');
  if (businessLike && m.timeframes.length === 0) questions.push('¿Hay una fecha o un plazo límite?');
  if ((kind === 'launch_business' || kind === 'market_research' || kind === 'growth') && m.places.length === 0) {
    questions.push('¿Para qué país o mercado es?');
  }
  if (kind === 'content_campaign' && !/[A-ZÁÉÍÓÚÑ][\p{L}]+/u.test(text.slice(1))) {
    questions.push('¿Qué marca, qué audiencia y qué canales?');
  }
  if (kind === 'document_analysis') {
    questions.push('¿Qué documentos hay que analizar y qué decisión apoyará el análisis?');
  }
  if (kind === 'validation_experiment') questions.push('¿Qué resultado te haría descartar la idea?');
  if (kind === 'general') questions.push('¿Qué resultado te indicaría que esta misión ha funcionado?');
  return questions;
}

// ---------------------------------------------------------------------------
// Classifier
// ---------------------------------------------------------------------------

export class RulesIntentClassifier implements IntentClassifier {
  classify(rawText: string): MissionIntent {
    const text = rawText.replace(/\[[a-z]+:[^\]]*\]/gi, ' ').replace(/\s+/g, ' ').trim();
    const language = detectLanguage(text);

    const scores = scoreKinds(text);
    // A strong "launch a business" reading beats generic content/product words
    // that merely appear inside it (a store *has* a website and social media).
    const ranked = [...scores].sort((a, b) => b.score - a.score || KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind));
    let kind: MissionKind = ranked[0]?.kind ?? 'general';
    const launch = scores.find((s) => s.kind === 'launch_business');
    if (launch !== undefined && launch.score >= 2 && kind !== 'document_analysis') kind = 'launch_business';
    if (launch !== undefined && kind === 'product_build' && scores.find((s) => s.kind === 'product_build')!.score <= launch.score) {
      kind = 'launch_business';
    }

    const secondaryKinds = ranked.map((s) => s.kind).filter((k) => k !== kind).slice(0, 3);

    const mentions = {
      places: extractPlaces(text),
      timeframes: extractTimeframes(text),
      amounts: extractAmounts(text),
    };

    const words = text.split(/\s+/).filter(Boolean).length;
    const signals: string[] = [];
    let weight = 0;
    if (words > 60) {
      weight += 2;
      signals.push(`petición extensa (${words} palabras)`);
    } else if (words > 25) {
      weight += 1;
      signals.push(`${words} palabras`);
    }
    if (secondaryKinds.length >= 2) {
      weight += 2;
      signals.push(`abarca ${secondaryKinds.length + 1} tipos de trabajo`);
    } else if (secondaryKinds.length === 1) {
      weight += 1;
      signals.push('abarca dos tipos de trabajo');
    }
    if (kind === 'launch_business' || kind === 'product_build') {
      weight += 1;
      signals.push(`${kind === 'launch_business' ? 'lanzar un negocio' : 'construir un producto'} abarca varias disciplinas`);
    }
    if (mentions.amounts.length + mentions.timeframes.length >= 2) {
      weight += 1;
      signals.push('incluye restricciones explícitas');
    }
    const complexity: Complexity = weight >= 3 ? 'complex' : weight >= 1 ? 'moderate' : 'simple';
    if (signals.length === 0) signals.push('petición breve y con un único propósito');

    const ambiguities = ambiguitiesFor(kind, text, mentions);

    const hits = scores.reduce((sum, s) => sum + s.score, 0);
    const confidence = kind === 'general' ? 0.25 : clamp(0.4 + 0.15 * Math.min(3, hits) - 0.05 * Math.max(0, ambiguities.length - 2), 0.3, 0.9);

    return {
      rawText,
      language,
      kind,
      secondaryKinds,
      complexity,
      complexitySignals: signals,
      subject: extractSubject(text),
      mentions,
      needsFreshInformation:
        FRESH_RE.test(text) || ['market_research', 'launch_business', 'growth', 'content_campaign', 'validation_experiment'].includes(kind),
      sensitivity: {
        involvesMoney: MONEY_RE.test(text) || mentions.amounts.length > 0,
        involvesPublishing: PUBLISH_RE.test(text),
        involvesExternalAction: EXTERNAL_RE.test(text) || PUBLISH_RE.test(text),
        involvesPersonalData: PERSONAL_RE.test(text),
      },
      confidence: round(confidence, 2),
      ambiguities,
    };
  }
}

export const classifyIntent = (text: string): MissionIntent => new RulesIntentClassifier().classify(text);
