/**
 * OllamaProvider — a local model server.
 *
 * Talks to an Ollama instance the operator runs (`OLLAMA_BASE_URL`, for example
 * http://localhost:11434). No API key, no cost per call. Registered as
 * `available` only when a base URL is configured; otherwise it appears as
 * `planned`, so nothing claims a connection that does not exist.
 *
 * `fetch` is injectable so the adapter is tested against a fake server, and no
 * network is used in tests.
 */

import {
  ProviderFailedError,
  ProviderNotConfiguredError,
  type AIProvider,
  type ProviderAvailability,
  type ProviderModel,
  type ProviderResult,
  type ProviderTask,
} from '@acc/domain';

export type FetchLike = (url: string, init?: { method?: string; headers?: Record<string, string>; body?: string; signal?: AbortSignal }) => Promise<{
  ok: boolean;
  status: number;
  text(): Promise<string>;
}>;

export interface OllamaOptions {
  /** Absent or empty means "not configured": the adapter is listed as planned. */
  baseUrl?: string | undefined;
  /** Models to offer. Use `discoverOllamaModels` to fill this from the server. */
  models?: readonly ProviderModel[];
  fetch?: FetchLike;
  /** Local generation can be slow; this bounds one call. */
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 300_000;

export class OllamaProvider implements AIProvider {
  readonly id = 'ollama' as const;
  readonly label = 'Ollama (local)';
  readonly availability: ProviderAvailability;

  private readonly baseUrl: string | null;
  private readonly models: readonly ProviderModel[];
  private readonly fetchImpl: FetchLike;
  private readonly timeoutMs: number;

  constructor(options: OllamaOptions = {}) {
    const url = options.baseUrl?.trim();
    this.baseUrl = url === undefined || url === '' ? null : url.replace(/\/+$/, '');
    this.models = options.models ?? [];
    this.availability = this.baseUrl !== null && this.models.length > 0 ? 'available' : 'planned';
    this.fetchImpl = options.fetch ?? (globalThis.fetch as unknown as FetchLike);
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  listModels(): readonly ProviderModel[] {
    return this.models;
  }

  /** Why the adapter is not usable, or null when it is. */
  unavailableReason(): string | null {
    if (this.baseUrl === null) return 'OLLAMA_BASE_URL no está definida.';
    if (this.models.length === 0) return `No se encontraron modelos en ${this.baseUrl}. Descarga uno con «ollama pull <modelo>».`;
    return null;
  }

  async execute(task: ProviderTask, signal?: AbortSignal): Promise<ProviderResult> {
    if (this.baseUrl === null || this.availability !== 'available') {
      throw new ProviderNotConfiguredError('ollama', this.unavailableReason() ?? 'no está configurado.');
    }
    const startedAt = Date.now();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    const onAbort = () => controller.abort();
    signal?.addEventListener('abort', onAbort, { once: true });

    try {
      const response = await this.fetchImpl(`${this.baseUrl}/api/chat`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        signal: controller.signal,
        body: JSON.stringify({
          model: task.model,
          stream: false,
          messages: [
            { role: 'system', content: task.systemPrompt },
            { role: 'user', content: task.prompt },
          ],
          options: {
            ...(task.temperature !== undefined ? { temperature: task.temperature } : {}),
            ...(task.maxTokens !== undefined ? { num_predict: task.maxTokens } : {}),
          },
        }),
      });
      const raw = await response.text();
      if (!response.ok) {
        throw new ProviderFailedError('ollama', `HTTP ${response.status} del servidor de Ollama${raw ? `: ${raw.slice(0, 200)}` : '.'}`);
      }
      let body: unknown;
      try {
        body = JSON.parse(raw);
      } catch {
        throw new ProviderFailedError('ollama', 'El servidor de Ollama devolvió una respuesta que no es JSON.');
      }
      const parsed = parseChat(body);
      if (parsed === null) throw new ProviderFailedError('ollama', 'La respuesta de Ollama no contenía ningún mensaje.');

      return {
        provider: 'ollama',
        model: task.model,
        text: parsed.text,
        usage: { promptTokens: parsed.promptTokens, completionTokens: parsed.completionTokens, totalTokens: parsed.promptTokens + parsed.completionTokens },
        requestId: `ollama_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
        finishReason: parsed.doneReason === 'length' ? 'length' : parsed.doneReason === 'stop' || parsed.doneReason === null ? 'stop' : 'other',
        latencyMs: Date.now() - startedAt,
        // A model that really ran, on the operator's own machine.
        source: 'real',
        simulated: false,
      };
    } catch (error) {
      if (error instanceof ProviderFailedError || error instanceof ProviderNotConfiguredError) throw error;
      if (signal?.aborted) throw new ProviderFailedError('ollama', 'La ejecución del agente fue cancelada.', error);
      if (controller.signal.aborted) throw new ProviderFailedError('ollama', `Se agotó el tiempo de espera del modelo local tras ${formatTimeout(this.timeoutMs)}.`, error);
      throw new ProviderFailedError('ollama', `No se pudo conectar con el servidor de Ollama en ${this.baseUrl}: ${error instanceof Error ? error.message : String(error)}`, error);
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    }
  }
}

function parseChat(body: unknown): { text: string; promptTokens: number; completionTokens: number; doneReason: string | null } | null {
  if (typeof body !== 'object' || body === null) return null;
  const b = body as Record<string, unknown>;
  const message = b['message'];
  if (typeof message !== 'object' || message === null) return null;
  const content = (message as Record<string, unknown>)['content'];
  if (typeof content !== 'string') return null;
  const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
  return {
    text: content,
    promptTokens: num(b['prompt_eval_count']),
    completionTokens: num(b['eval_count']),
    doneReason: typeof b['done_reason'] === 'string' ? b['done_reason'] : null,
  };
}

/**
 * Ask a running Ollama server which models it has. Returns an empty list (never
 * throws) when the server cannot be reached, so boot does not depend on it.
 */
export async function discoverOllamaModels(baseUrl: string | undefined, fetchImpl?: FetchLike, timeoutMs = 3000): Promise<{ models: ProviderModel[]; error: string | null }> {
  const url = baseUrl?.trim().replace(/\/+$/, '');
  if (url === undefined || url === '') return { models: [], error: 'OLLAMA_BASE_URL no está definida.' };
  const doFetch = fetchImpl ?? (globalThis.fetch as unknown as FetchLike);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await doFetch(`${url}/api/tags`, { signal: controller.signal });
    if (!response.ok) return { models: [], error: `HTTP ${response.status} desde ${url}/api/tags.` };
    const body = JSON.parse(await response.text()) as { models?: { name?: unknown }[] };
    const models = (body.models ?? []).flatMap((m) => (typeof m.name === 'string' ? [{ id: m.name, label: `${m.name} (local)` }] : []));
    return { models, error: models.length === 0 ? `El servidor en ${url} no tiene modelos instalados.` : null };
  } catch (error) {
    return { models: [], error: `No se pudo conectar con ${url}: ${error instanceof Error ? error.message : String(error)}` };
  } finally {
    clearTimeout(timer);
  }
}

/** "20 ms" / "2,5 s": a timeout the reader can compare with what they configured. */
function formatTimeout(ms: number): string {
  return ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(ms % 1000 === 0 ? 0 : 1).replace('.', ',')} s`;
}
