/**
 * Tool execution.
 *
 * The executor is the last stage of the tool pipeline (`./pipeline.ts`): it
 * runs a tool whose call has already been permitted, looked up, validated
 * against its schema and cleared by the cost controller. It does not repeat
 * those checks, and nothing else in MADRE should call it directly — the
 * pipeline is what makes a call safe and observable.
 *
 * A tool that is not connected never gets here: the pipeline refuses it with a
 * structured error that says so. The executor never returns invented output.
 */

import type { MemoryService } from '../memory/service.ts';
import type { ToolRegistry } from '../registry/tools.ts';
import type { MemoryScope, ToolRequest, ToolResult } from '../types.ts';
import { CalculatorError, evaluate } from './calculator.ts';
import { fetchPage, UnsafeUrlError, type PageFetcher } from './safe-fetch.ts';
import { defaultWebFetch, gdeltNews, tavilySearch, WebToolError, wikipedia, type WebFetch } from './web.ts';

export interface ToolContext {
  missionId: string;
  runId: string;
  stepId: string;
  signal?: AbortSignal;
}

export interface ToolExecutor {
  /** True when this executor has an implementation for the tool. It says nothing about whether the tool is enabled or connected. */
  canRun(toolId: string): boolean;
  /**
   * Run one call. The input has already been validated. Failures are returned
   * as a failed `ToolResult`; only a genuine bug may throw, and the pipeline
   * turns that into a structured error too.
   */
  execute(request: ToolRequest, context: ToolContext): Promise<ToolResult>;
}

/** The tools this executor implements. Everything else in the catalog is declared, not built. */
export const IMPLEMENTED_TOOLS: ReadonlySet<string> = new Set(['memory.recall', 'math.calculator', 'research.wikipedia', 'web.search', 'web.fetch', 'news.gdelt']);

const MEMORY_SCOPES: readonly MemoryScope[] = ['user', 'project', 'mission', 'session'];
const MAX_RECALL = 20;
const ENRICH_TOP = 2;
const ENRICH_CHARS = 1_000;
const FETCH_CHARS = 6_000;

export class LocalToolExecutor implements ToolExecutor {
  constructor(
    private readonly tools: ToolRegistry,
    private readonly memory: MemoryService,
    private readonly web: { fetch?: WebFetch | undefined; searchApiKey?: string | undefined; pageFetcher?: PageFetcher | undefined; enrichSearch?: boolean | undefined } = {},
  ) {}

  canRun(toolId: string): boolean {
    return IMPLEMENTED_TOOLS.has(toolId);
  }

  async execute(request: ToolRequest, context: ToolContext): Promise<ToolResult> {
    const base = { toolId: request.toolId, requestId: request.id };
    const spec = this.tools.get(request.toolId);
    const name = spec?.name ?? request.toolId;

    try {
      switch (request.toolId) {
        case 'memory.recall': {
          const { query, scope, limit } = request.input;
          if (typeof query !== 'string') {
            return { ...base, ok: false, output: null, error: 'Falta el texto que buscar en la memoria.', verified: false, stage: 'execution', code: 'invalid_input' };
          }
          const hits = await this.memory.recall({
            query,
            limit: typeof limit === 'number' ? Math.max(1, Math.min(MAX_RECALL, Math.floor(limit))) : 5,
            ...(typeof scope === 'string' && (MEMORY_SCOPES as readonly string[]).includes(scope) ? { scope: scope as MemoryScope } : {}),
          });
          return {
            ...base,
            ok: true,
            verified: false,
            error: null,
            output: {
              entries: hits.map((h) => ({
                id: h.entry.id,
                title: h.entry.title,
                content: h.entry.content,
                type: h.entry.type,
                verified: h.entry.verified,
                confidence: h.entry.confidence,
              })),
            },
          };
        }
        case 'math.calculator': {
          const expression = request.input.expression;
          if (typeof expression !== 'string') {
            return { ...base, ok: false, output: null, error: 'Hace falta una expresión.', verified: false, stage: 'execution', code: 'invalid_input' };
          }
          return { ...base, ok: true, verified: true, error: null, output: { expression, value: evaluate(expression) } };
        }
        case 'research.wikipedia': {
          const { title, lang } = request.input;
          if (typeof title !== 'string') {
            return { ...base, ok: false, output: null, error: 'Falta el título o la consulta.', verified: false, stage: 'execution', code: 'invalid_input' };
          }
          const output = await wikipedia(this.web.fetch ?? defaultWebFetch, title, typeof lang === 'string' ? lang : 'es', context.signal);
          // A source that can be cited, but a wiki is not a primary source: not "verified".
          return { ...base, ok: true, verified: false, error: null, output: { ...output } };
        }
        case 'web.search': {
          const { query, limit } = request.input;
          if (typeof query !== 'string') {
            return { ...base, ok: false, output: null, error: 'Falta la consulta.', verified: false, stage: 'execution', code: 'invalid_input' };
          }
          if (this.web.searchApiKey === undefined) {
            return { ...base, ok: false, output: null, error: 'La búsqueda web no tiene clave (TAVILY_API_KEY).', verified: false, stage: 'execution', code: 'execution_error' };
          }
          const output = await tavilySearch(this.web.fetch ?? defaultWebFetch, this.web.searchApiKey, query, typeof limit === 'number' ? limit : 5, context.signal);
          // Read the top pages themselves, not just the snippets. A page that
          // cannot be read is left with its snippet; it never fails the search.
          const results =
            this.web.enrichSearch === true
              ? await Promise.all(
                  output.results.map(async (r, i) => {
                    if (i >= ENRICH_TOP) return r;
                    try {
                      const page = await (this.web.pageFetcher ?? fetchPage)(r.url, { signal: AbortSignal.any([...(context.signal === undefined ? [] : [context.signal]), AbortSignal.timeout(8_000)]), maxBytes: 400_000 });
                      return { ...r, pageText: page.text.slice(0, ENRICH_CHARS) };
                    } catch {
                      return r;
                    }
                  }),
                )
              : output.results;
          return { ...base, ok: true, verified: false, error: null, output: { ...output, results } };
        }
        case 'news.gdelt': {
          const { query, limit } = request.input;
          if (typeof query !== 'string') {
            return { ...base, ok: false, output: null, error: 'Falta la consulta.', verified: false, stage: 'execution', code: 'invalid_input' };
          }
          const output = await gdeltNews(this.web.fetch ?? defaultWebFetch, query, typeof limit === 'number' ? limit : 8, context.signal);
          return { ...base, ok: true, verified: false, error: null, output: { ...output } };
        }
        case 'web.fetch': {
          const { url } = request.input;
          if (typeof url !== 'string') {
            return { ...base, ok: false, output: null, error: 'Falta la dirección de la página.', verified: false, stage: 'execution', code: 'invalid_input' };
          }
          const page = await (this.web.pageFetcher ?? fetchPage)(url, context.signal === undefined ? {} : { signal: context.signal });
          if (page.text.trim() === '') throw new WebToolError('La página no tiene texto legible.');
          return { ...base, ok: true, verified: false, error: null, output: { url: page.url, title: page.title, text: page.text.slice(0, FETCH_CHARS), truncated: page.truncated || page.text.length > FETCH_CHARS, fetchedAt: new Date().toISOString() } };
        }
        default:
          return { ...base, ok: false, output: null, error: `${name} no tiene ejecutor en esta versión.`, verified: false, stage: 'executor', code: 'no_executor' };
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        ...base,
        ok: false,
        output: null,
        error: error instanceof CalculatorError || error instanceof WebToolError || error instanceof UnsafeUrlError ? message : `${name} falló al ejecutarse: ${message}`,
        verified: false,
        stage: 'execution',
        code: 'execution_error',
      };
    }
  }
}
