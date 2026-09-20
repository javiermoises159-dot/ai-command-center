/**
 * Research engine.
 *
 * Works on sources it is *given*. Searching the web is a separate port
 * (`SearchProvider`) whose only implementation here reports NOT CONNECTED, so
 * nothing in this module invents a source, a quotation or a URL.
 *
 * Every claim carries a label:
 *   FACT        stated by a source, with a citation
 *   ASSUMPTION  taken as true to make progress, not established
 *   ANALYSIS    derived by reasoning from facts, with the facts named
 *   OPINION     a judgement, attributed
 *   UNKNOWN     asked and not answered
 * A FACT without a citation is downgraded to ASSUMPTION rather than kept.
 */

export type ClaimLabel = 'FACT' | 'ASSUMPTION' | 'ANALYSIS' | 'OPINION' | 'UNKNOWN';
export type SourceKind = 'primary' | 'official' | 'academic' | 'news' | 'reference' | 'commercial' | 'social' | 'unknown';

export interface Source {
  id: string;
  title: string;
  url: string | null;
  kind: SourceKind;
  /** ISO date the source was published or last updated, when known. */
  publishedAt: string | null;
  /** Text of the source, used to check that quotations really appear in it. */
  text: string;
}

export interface Citation {
  sourceId: string;
  quote: string;
}

export interface Claim {
  id: string;
  statement: string;
  label: ClaimLabel;
  citations: Citation[];
  /** For ANALYSIS: ids of the claims it is derived from. */
  basedOn?: string[];
  /** Topic key used to compare claims, e.g. "market size". Optional. */
  topic?: string;
  /** Numeric value for comparison across sources, when the claim states one. */
  value?: number;
}

export interface SearchProvider {
  readonly id: string;
  readonly connected: boolean;
  search(query: string): Promise<Source[]>;
}

export class SearchNotConnectedError extends Error {
  constructor() {
    super('La búsqueda web NO ESTÁ CONECTADA. No se ha enviado ninguna consulta ni se ha inventado ninguna fuente.');
    this.name = 'SearchNotConnectedError';
  }
}

export const notConnectedSearch: SearchProvider = Object.freeze({
  id: 'web.search',
  connected: false,
  search: () => Promise.reject(new SearchNotConnectedError()),
});

/**
 * Etiquetas en español para lo que se muestra. Los valores de enumeración
 * (FACT, ASSUMPTION, ANALYSIS, OPINION, UNKNOWN) no cambian: la interfaz los etiqueta.
 */
export const CLAIM_LABEL_TITLE: Record<ClaimLabel, string> = {
  FACT: 'hechos con cita',
  ASSUMPTION: 'supuestos',
  ANALYSIS: 'análisis',
  OPINION: 'opiniones',
  UNKNOWN: 'sin respuesta',
};

export const RESEARCH_STATUS_LABEL: Record<'sourced' | 'partly_sourced' | 'unsourced', string> = {
  sourced: 'con fuentes',
  partly_sourced: 'parcialmente con fuentes',
  unsourced: 'sin fuentes',
};

export const SOURCE_KIND_LABEL: Record<SourceKind, string> = {
  primary: 'fuente primaria',
  official: 'oficial',
  academic: 'académica',
  news: 'prensa',
  reference: 'obra de referencia',
  commercial: 'comercial',
  social: 'redes sociales',
  unknown: 'desconocida',
};

const KIND_WEIGHT: Record<SourceKind, number> = { primary: 1, official: 0.95, academic: 0.9, reference: 0.7, news: 0.6, commercial: 0.4, social: 0.25, unknown: 0.2 };

/** 0..1 reliability weight from kind and age. A weight is a prior, not a verdict. */
export function sourceWeight(source: Source, now: Date): number {
  let w = KIND_WEIGHT[source.kind];
  if (source.publishedAt !== null) {
    const years = (now.getTime() - new Date(source.publishedAt).getTime()) / (365.25 * 86_400_000);
    if (years > 2) w *= Math.max(0.5, 1 - (years - 2) * 0.1);
  } else {
    w *= 0.8;
  }
  return Math.round(w * 100) / 100;
}

export interface CheckedClaim extends Claim {
  originalLabel: ClaimLabel;
  issues: string[];
}

function normalise(s: string): string {
  return s.toLowerCase().replace(/\s+/g, ' ').trim();
}

/** Verifies citations against the supplied sources and downgrades unsupported facts. */
export function checkClaims(claims: readonly Claim[], sources: readonly Source[]): CheckedClaim[] {
  const byId = new Map(sources.map((s) => [s.id, s]));
  return claims.map((claim) => {
    const issues: string[] = [];
    let label = claim.label;
    const valid = claim.citations.filter((c) => {
      const src = byId.get(c.sourceId);
      if (src === undefined) {
        issues.push(`Cita a una fuente desconocida: "${c.sourceId}".`);
        return false;
      }
      if (c.quote.trim() === '' || !normalise(src.text).includes(normalise(c.quote))) {
        issues.push(`La cita textual no aparece en "${src.title}".`);
        return false;
      }
      return true;
    });
    if (label === 'FACT' && valid.length === 0) {
      issues.push('Etiquetado como FACT sin una cita verificable; se trata como ASSUMPTION.');
      label = 'ASSUMPTION';
    }
    if (label === 'ANALYSIS' && (claim.basedOn ?? []).length === 0) issues.push('ANALYSIS no indica en qué afirmaciones se basa.');
    return { ...claim, label, citations: valid, originalLabel: claim.label, issues };
  });
}

export interface Contradiction {
  topic: string;
  claimIds: string[];
  values: number[];
  spreadPct: number;
  note: string;
}

/** Claims on the same topic whose stated numbers differ by more than `tolerancePct`. */
export function findContradictions(claims: readonly Claim[], tolerancePct = 10): Contradiction[] {
  const groups = new Map<string, Claim[]>();
  for (const c of claims) {
    if (c.topic === undefined || c.value === undefined || c.label === 'UNKNOWN') continue;
    groups.set(c.topic, [...(groups.get(c.topic) ?? []), c]);
  }
  const out: Contradiction[] = [];
  for (const [topic, group] of groups) {
    if (group.length < 2) continue;
    const values = group.map((g) => g.value!);
    const lo = Math.min(...values);
    const hi = Math.max(...values);
    const spread = lo === 0 ? (hi === 0 ? 0 : 100) : ((hi - lo) / Math.abs(lo)) * 100;
    if (spread > tolerancePct) {
      out.push({ topic, claimIds: group.map((g) => g.id), values, spreadPct: Math.round(spread * 10) / 10, note: `Las fuentes discrepan sobre "${topic}" en un ${Math.round(spread)} %. No elijas una en silencio.` });
    }
  }
  return out;
}

export interface ResearchBrief {
  question: string;
  claims: CheckedClaim[];
  sources: (Source & { weight: number })[];
  contradictions: Contradiction[];
  counts: Record<ClaimLabel, number>;
  unknowns: string[];
  status: 'sourced' | 'partly_sourced' | 'unsourced';
  searched: boolean;
  markdown: string;
}

export function buildBrief(input: { question: string; claims: readonly Claim[]; sources: readonly Source[]; now: Date; searched?: boolean }): ResearchBrief {
  const claims = checkClaims(input.claims, input.sources);
  const contradictions = findContradictions(claims);
  const counts: Record<ClaimLabel, number> = { FACT: 0, ASSUMPTION: 0, ANALYSIS: 0, OPINION: 0, UNKNOWN: 0 };
  for (const c of claims) counts[c.label]++;
  const sources = input.sources.map((s) => ({ ...s, weight: sourceWeight(s, input.now) }));
  const unknowns = claims.filter((c) => c.label === 'UNKNOWN').map((c) => c.statement);
  const status = counts.FACT === 0 ? 'unsourced' : counts.ASSUMPTION + counts.UNKNOWN > counts.FACT ? 'partly_sourced' : 'sourced';

  const lines = [
    `# ${input.question}`,
    '',
    `Estado: ${RESEARCH_STATUS_LABEL[status]}. ${input.searched === true ? 'Se han buscado fuentes.' : 'No se ha ejecutado ninguna búsqueda; esto cubre solo las fuentes aportadas.'}`,
    '',
  ];
  for (const label of ['FACT', 'ANALYSIS', 'OPINION', 'ASSUMPTION', 'UNKNOWN'] as const) {
    const group = claims.filter((c) => c.label === label);
    if (group.length === 0) continue;
    lines.push(`## ${label} — ${CLAIM_LABEL_TITLE[label]}`);
    for (const c of group) {
      const cites = c.citations.map((ct) => `[${ct.sourceId}]`).join('');
      lines.push(`- ${c.statement}${cites === '' ? '' : ` ${cites}`}`);
    }
    lines.push('');
  }
  if (contradictions.length > 0) lines.push('## Contradicciones', ...contradictions.map((c) => `- ${c.note}`), '');
  if (sources.length > 0) {
    lines.push('## Fuentes', ...sources.map((s) => `- [${s.id}] ${s.title}${s.url === null ? '' : ` — ${s.url}`} (${SOURCE_KIND_LABEL[s.kind]}, peso ${s.weight})`));
  }
  return { question: input.question, claims, sources, contradictions, counts, unknowns, status, searched: input.searched === true, markdown: lines.join('\n').trim() };
}

/** Runs a search through the port when connected; otherwise returns an honest empty brief. */
export async function research(input: { question: string; claims?: readonly Claim[]; sources?: readonly Source[]; search: SearchProvider; now: Date }): Promise<ResearchBrief & { searchError: string | null }> {
  let found: Source[] = [];
  let searchError: string | null = null;
  let searched = false;
  if (input.search.connected) {
    try {
      found = await input.search.search(input.question);
      searched = true;
    } catch (error) {
      searchError = error instanceof Error ? error.message : String(error);
    }
  } else {
    searchError = 'La búsqueda web NO ESTÁ CONECTADA; solo se han usado las fuentes aportadas.';
  }
  const brief = buildBrief({ question: input.question, claims: input.claims ?? [], sources: [...(input.sources ?? []), ...found], now: input.now, searched });
  return { ...brief, searchError };
}
