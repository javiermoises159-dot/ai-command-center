/**
 * Base class for the real, remote provider adapters (OpenAI, Anthropic, Gemini).
 *
 * The three vendors differ in exactly three things — how a request is shaped,
 * how a response is read, and what a cheap reachability probe looks like. This
 * class owns everything else so it is written once:
 *
 *  - configuration is read from the environment by the server and handed in; a
 *    missing key or model is the state `unconfigured`, never a simulated answer;
 *  - `execute` refuses to run when unconfigured, when the model was not enabled
 *    by the operator, or when the task needs a capability the adapter does not
 *    implement — all BEFORE any request is made;
 *  - every failure is a structured `ProviderError`; nothing else escapes;
 *  - every success is labelled `source: 'real'`, `simulated: false`;
 *  - no retries here (the engine retries), no key in any message.
 */

import {
  ProviderError,
  newId,
  type AIProvider,
  type ProviderAvailability,
  type ProviderCapabilities,
  type ProviderConfiguration,
  type ProviderHealthReport,
  type ProviderId,
  type ProviderModel,
  type ProviderResult,
  type ProviderTask,
} from '@acc/domain';

import { obj, requestJson, scrub, type FailureContext, type HttpFetch, type HttpResponse } from './http.ts';

export interface RealProviderOptions {
  /** The credential. Absent or blank means the provider is `unconfigured`. */
  apiKey?: string | undefined;
  /** Model ids the operator enabled, first one is the default. Absent means unconfigured. */
  models?: readonly string[] | undefined;
  /** Override the vendor endpoint (a proxy, a regional endpoint). Absent uses the vendor's. */
  baseUrl?: string | undefined;
  fetch?: HttpFetch | undefined;
  /** Bounds one call. The engine has its own, usually shorter, timeout on top. */
  timeoutMs?: number | undefined;
  /** Largest completion to request when the task does not say. Anthropic requires one. */
  maxOutputTokens?: number | undefined;
}

export interface BuiltRequest {
  url: string;
  headers: Record<string, string>;
  body: unknown;
}

export interface ParsedCompletion {
  text: string;
  promptTokens: number;
  completionTokens: number;
  finishReason: ProviderResult['finishReason'];
  /** The vendor's own request/response id, when it sent one. */
  vendorRequestId: string | null;
}

const DEFAULT_TIMEOUT_MS = 120_000;
const PROBE_TIMEOUT_MS = 5_000;
const SLOW_PROBE_MS = 2_000;

/**
 * What these adapters implement today: plain text in, plain text out.
 *
 * The vendors' models can do more (tools, JSON schemas, images), but MADRE
 * runs tools itself through its ToolPipeline and none of this is wired into the
 * adapters yet, so declaring it would be a claim nobody could back. The router
 * treats an undeclared capability as absent and never routes a step that needs
 * it here.
 */
export const TEXT_ONLY: ProviderCapabilities = Object.freeze({
  streaming: false,
  toolCalling: false,
  structuredOutput: false,
  embeddings: false,
  vision: false,
});

export abstract class RealProvider implements AIProvider {
  abstract readonly id: ProviderId;
  abstract readonly label: string;
  /** Environment variable that holds the key, for messages. */
  abstract readonly keyVariable: string;
  abstract readonly modelVariable: string;
  protected abstract readonly defaultBaseUrl: string;

  readonly availability: ProviderAvailability;

  protected readonly apiKey: string | null;
  protected readonly baseUrl: string;
  protected readonly modelIds: readonly string[];
  protected readonly fetchImpl: HttpFetch;
  protected readonly timeoutMs: number;
  protected readonly maxOutputTokens: number | null;

  constructor(options: RealProviderOptions, defaultBaseUrl: string) {
    const key = options.apiKey?.trim();
    this.apiKey = key === undefined || key === '' ? null : key;
    this.baseUrl = (options.baseUrl?.trim() || defaultBaseUrl).replace(/\/+$/, '');
    this.modelIds = [...new Set((options.models ?? []).map((m) => m.trim()).filter((m) => m !== ''))];
    this.fetchImpl = options.fetch ?? (globalThis.fetch as unknown as HttpFetch);
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.maxOutputTokens = options.maxOutputTokens ?? null;
    this.availability = this.apiKey !== null && this.modelIds.length > 0 ? 'available' : 'unconfigured';
  }

  // ---- vendor-specific parts ---------------------------------------------

  protected abstract buildRequest(task: ProviderTask, model: string): BuiltRequest;
  protected abstract parse(response: HttpResponse, ctx: FailureContext): ParsedCompletion;
  /** A request that lists models: cheap, never billed. */
  protected abstract probeRequest(key: string): { url: string; headers: Record<string, string> };

  // ---- configuration ------------------------------------------------------

  /** Human-readable models, ids as the operator wrote them. */
  protected modelLabel(id: string): string {
    return id;
  }

  listModels(): readonly ProviderModel[] {
    if (this.availability !== 'available') return [];
    return this.modelIds.map((id) => ({ id, label: this.modelLabel(id), capabilities: { ...TEXT_ONLY } }));
  }

  configuration(): ProviderConfiguration {
    const missing: string[] = [];
    if (this.apiKey === null) missing.push(this.keyVariable);
    if (this.modelIds.length === 0) missing.push(this.modelVariable);
    return {
      configured: missing.length === 0,
      reason:
        missing.length === 0
          ? null
          : `Sin configurar: falta ${missing.join(' y ')}. ${this.label} no responderá hasta que se definan; nunca se sustituye por una simulación.`,
      requires: [this.keyVariable, this.modelVariable],
    };
  }

  protected failureContext(model: string | null): FailureContext {
    return {
      provider: this.id,
      label: this.label,
      model,
      keyVariable: this.keyVariable,
      modelVariable: this.modelVariable,
      secrets: this.apiKey === null ? [] : [this.apiKey],
    };
  }

  // ---- execution ----------------------------------------------------------

  async execute(task: ProviderTask, signal?: AbortSignal): Promise<ProviderResult> {
    const ctx = this.failureContext(task.model);

    // 1. Configured? A provider without credentials fails here — it is never
    //    answered by a stand-in.
    const configuration = this.configuration();
    if (this.apiKey === null || !configuration.configured) {
      throw new ProviderError('PROVIDER_UNCONFIGURED', {
        provider: this.id,
        model: task.model,
        detail: configuration.reason ?? `${this.label} no está configurado.`,
      });
    }

    // 2. Does it implement what this task needs?
    const missing = (task.requires ?? []).filter((name) => TEXT_ONLY[name] !== true);
    if (missing.length > 0) {
      throw new ProviderError('PROVIDER_CAPABILITY_MISMATCH', {
        provider: this.id,
        model: task.model,
        detail: `${this.label} no implementa lo que pide este paso (${missing.join(', ')}). No se ha enviado nada.`,
      });
    }

    // 3. Only models the operator enabled: a typo or a stale id must not quietly
    //    spend money on a different model.
    if (!this.modelIds.includes(task.model)) {
      throw new ProviderError('PROVIDER_BAD_REQUEST', {
        provider: this.id,
        model: task.model,
        detail: `El modelo «${task.model}» no está habilitado para ${this.label}. Habilitados en ${this.modelVariable}: ${this.modelIds.join(', ')}.`,
      });
    }

    const built = this.buildRequest(task, task.model);
    const response = await requestJson(
      {
        provider: this.id,
        model: task.model,
        url: built.url,
        method: 'POST',
        headers: built.headers,
        body: built.body,
        timeoutMs: this.timeoutMs,
        signal,
        secrets: [this.apiKey],
        fetch: this.fetchImpl,
      },
      ctx,
    );

    const parsed = this.parse(response, ctx);
    return {
      provider: this.id,
      model: task.model,
      text: parsed.text,
      usage: {
        promptTokens: parsed.promptTokens,
        completionTokens: parsed.completionTokens,
        totalTokens: parsed.promptTokens + parsed.completionTokens,
      },
      requestId: parsed.vendorRequestId ?? `${this.id}_${newId()}`,
      finishReason: parsed.finishReason,
      latencyMs: response.latencyMs,
      source: 'real',
      simulated: false,
    };
  }

  // ---- health ---------------------------------------------------------------

  /**
   * Cheap reachability probe: list the models. Never a billed call, never throws.
   *
   * `not_connected` when there is nothing to probe with; `ok` only after the
   * vendor actually answered with a success.
   */
  async health(signal?: AbortSignal): Promise<ProviderHealthReport> {
    if (this.apiKey === null) {
      return { status: 'not_connected', detail: `Sin conectar: falta ${this.keyVariable}, así que no hay nada que comprobar.` };
    }
    const probe = this.probeRequest(this.apiKey);
    const startedAt = Date.now();
    try {
      const response = await requestJson(
        {
          provider: this.id,
          model: null,
          url: probe.url,
          method: 'GET',
          headers: probe.headers,
          timeoutMs: PROBE_TIMEOUT_MS,
          signal,
          secrets: [this.apiKey],
          fetch: this.fetchImpl,
        },
        this.failureContext(null),
      );
      const note = this.modelIds.length === 0 ? ` Aun así falta ${this.modelVariable}: sin modelo no puede ejecutar pasos.` : '';
      return response.latencyMs > SLOW_PROBE_MS
        ? { status: 'degraded', detail: `${this.label} responde, pero lento (${response.latencyMs} ms).${note}`, latencyMs: response.latencyMs }
        : { status: 'ok', detail: `${this.label} responde.${note}`, latencyMs: response.latencyMs };
    } catch (error) {
      const latencyMs = Date.now() - startedAt;
      const detail = error instanceof ProviderError ? error.publicMessage : `No se pudo comprobar ${this.label}: ${scrub(error instanceof Error ? error.message : String(error), [this.apiKey])}`;
      return { status: 'down', detail, latencyMs };
    }
  }
}

/** Read `obj(x)?.[key]` for a chain of keys. Returns undefined at the first miss. */
export function dig(value: unknown, ...path: (string | number)[]): unknown {
  let current: unknown = value;
  for (const key of path) {
    if (typeof key === 'number') {
      if (!Array.isArray(current)) return undefined;
      current = current[key];
    } else {
      const record = obj(current);
      if (record === null) return undefined;
      current = record[key];
    }
  }
  return current;
}
