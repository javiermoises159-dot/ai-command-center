/**
 * Web connectors: Wikipedia (no key) and Tavily search (free plan, key).
 *
 * Both are plain `fetch` calls made from the server. Their output is EXTERNAL
 * TEXT: it is handed to models as data to cite, never as instructions, and it
 * carries the URL it came from so a claim can be traced. Nothing here invents a
 * result: an empty answer is an empty answer, and any failure throws with a
 * plain message that the executor turns into a failed `ToolResult`.
 */

export type WebFetch = (
  url: string,
  init?: { method?: string; headers?: Record<string, string>; body?: string; signal?: AbortSignal },
) => Promise<{ ok: boolean; status: number; json(): Promise<unknown>; text(): Promise<string> }>;

export const defaultWebFetch: WebFetch = (url, init) => globalThis.fetch(url, init as RequestInit) as ReturnType<WebFetch>;

const USER_AGENT = 'AICommandCenter/1.0 (research assistant; contact: owner of this deployment)';
const MAX_EXTRACT_CHARS = 3_000;
const MAX_SNIPPET_CHARS = 700;

export class WebToolError extends Error {}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function clip(text: string, max: number): string {
  const clean = text.replace(/\s+/g, ' ').trim();
  return clean.length <= max ? clean : `${clean.slice(0, max - 1)}…`;
}

const LANG = /^[a-z]{2,3}(-[a-z]{2,8})?$/;

export interface WikipediaOutput {
  title: string;
  extract: string;
  url: string;
  lang: string;
  fetchedAt: string;
}

/** Best-matching article's introduction for a title or free-text query. */
export async function wikipedia(fetch: WebFetch, title: string, lang: string, signal?: AbortSignal): Promise<WikipediaOutput> {
  const language = LANG.test(lang) ? lang : 'es';
  const q = clip(title, 200);
  if (q === '') throw new WebToolError('Falta el título o la consulta.');
  const params = new URLSearchParams({
    action: 'query',
    format: 'json',
    formatversion: '2',
    generator: 'search',
    gsrsearch: q,
    gsrlimit: '1',
    prop: 'extracts|info',
    exintro: '1',
    explaintext: '1',
    inprop: 'url',
    redirects: '1',
    origin: '*',
  });
  const response = await fetch(`https://${language}.wikipedia.org/w/api.php?${params.toString()}`, {
    headers: { 'user-agent': USER_AGENT, accept: 'application/json' },
    ...(signal === undefined ? {} : { signal }),
  });
  if (!response.ok) throw new WebToolError(`Wikipedia respondió con HTTP ${response.status}.`);
  const pages = record(record(await response.json())?.query)?.pages;
  const page = Array.isArray(pages) ? record(pages[0]) : null;
  const extract = typeof page?.extract === 'string' ? page.extract.trim() : '';
  if (page === null || extract === '') throw new WebToolError(`Wikipedia (${language}) no tiene ningún artículo para «${q}».`);
  return {
    title: typeof page.title === 'string' ? page.title : q,
    extract: clip(extract, MAX_EXTRACT_CHARS),
    url: typeof page.fullurl === 'string' ? page.fullurl : `https://${language}.wikipedia.org/wiki/${encodeURIComponent(q)}`,
    lang: language,
    fetchedAt: new Date().toISOString(),
  };
}

export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
  publishedAt: string | null;
}

export interface SearchOutput {
  query: string;
  results: SearchResult[];
  provider: 'tavily';
  fetchedAt: string;
}

/** Tavily search. The key is sent in a header and never appears in any message. */
export async function tavilySearch(fetch: WebFetch, apiKey: string, query: string, limit: number, signal?: AbortSignal): Promise<SearchOutput> {
  const q = clip(query, 380);
  if (q === '') throw new WebToolError('Falta la consulta.');
  const max = Math.max(1, Math.min(10, Math.floor(limit)));
  let response;
  try {
    response = await fetch('https://api.tavily.com/search', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({ query: q, max_results: max, search_depth: 'basic', include_answer: false }),
      ...(signal === undefined ? {} : { signal }),
    });
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') throw error;
    throw new WebToolError('No se pudo contactar con Tavily.');
  }
  if (response.status === 401 || response.status === 403) throw new WebToolError('Tavily rechazó la clave (TAVILY_API_KEY).');
  if (response.status === 429 || response.status === 432 || response.status === 433) throw new WebToolError('Tavily: se agotó el cupo gratuito o hay demasiadas peticiones.');
  if (!response.ok) throw new WebToolError(`Tavily respondió con HTTP ${response.status}.`);
  const raw = record(await response.json())?.results;
  const results: SearchResult[] = [];
  for (const item of Array.isArray(raw) ? raw : []) {
    const r = record(item);
    if (r === null || typeof r.url !== 'string' || !/^https?:\/\//i.test(r.url)) continue;
    results.push({
      title: typeof r.title === 'string' ? clip(r.title, 200) : r.url,
      url: r.url,
      snippet: typeof r.content === 'string' ? clip(r.content, MAX_SNIPPET_CHARS) : '',
      publishedAt: typeof r.published_date === 'string' ? r.published_date : null,
    });
    if (results.length >= max) break;
  }
  return { query: q, results, provider: 'tavily', fetchedAt: new Date().toISOString() };
}
