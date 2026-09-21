/**
 * Shared HTTP plumbing for the real (remote) provider adapters.
 *
 * One place owns the parts that must behave identically for OpenAI, Anthropic
 * and Gemini: the timeout, the cancellation signal, turning an HTTP status into
 * a structured `ProviderError`, and making sure no credential ends up in an
 * error message, a log line, the audit log or the trace.
 *
 * Deliberately NOT here: retries. The engine already retries, backs off and
 * switches provider (see `execution/healing.ts`); a second retry loop inside an
 * adapter would multiply attempts (3 × 3 calls for one step) and hide from the
 * circuit breaker how often the vendor really failed. No SDK is used, so no
 * hidden SDK retry exists either.
 */

import { ProviderError } from '@acc/domain';

/** The slice of `fetch` the adapters use. Injectable, so tests never touch the network. */
export type HttpFetch = (
  url: string,
  init?: { method?: string; headers?: Record<string, string>; body?: string; signal?: AbortSignal },
) => Promise<{
  ok: boolean;
  status: number;
  text(): Promise<string>;
  headers?: { get(name: string): string | null };
}>;

export interface HttpRequest {
  provider: string;
  model: string | null;
  url: string;
  method: 'GET' | 'POST';
  headers: Record<string, string>;
  body?: unknown;
  timeoutMs: number;
  /** The caller's cancellation (the mission was cancelled, or the engine's own timeout fired). */
  signal?: AbortSignal | undefined;
  /** Every credential that travels in this request. Scrubbed from anything that is reported. */
  secrets: readonly string[];
  fetch: HttpFetch;
}

export interface HttpResponse {
  status: number;
  /** Parsed JSON body. */
  json: unknown;
  headers: { get(name: string): string | null };
  latencyMs: number;
}

const EMPTY_HEADERS = { get: (_name: string): string | null => null };

/** Vendor key shapes that can appear inside an error message the vendor echoes back. */
const KEY_SHAPES = /(?:sk-(?:ant-|proj-)?[A-Za-z0-9_-]{8,}|AIza[0-9A-Za-z_-]{16,})/g;

/** Remove every known credential (and anything shaped like one) from a piece of text. */
export function scrub(text: string, secrets: readonly string[]): string {
  let out = text;
  for (const secret of secrets) {
    if (secret.length >= 6) out = out.split(secret).join('[clave oculta]');
  }
  return out.replace(KEY_SHAPES, '[clave oculta]');
}

const MAX_EXCERPT = 300;

function excerpt(text: string, secrets: readonly string[]): string {
  const clean = scrub(text.replace(/\s+/g, ' ').trim(), secrets);
  return clean.length > MAX_EXCERPT ? `${clean.slice(0, MAX_EXCERPT)}…` : clean;
}

/** The message a vendor put in its error body, if it followed the usual `{error:{message}}` shape. */
function vendorMessage(body: string): string | null {
  try {
    const parsed = JSON.parse(body) as unknown;
    if (typeof parsed !== 'object' || parsed === null) return null;
    const error = (parsed as Record<string, unknown>)['error'];
    if (typeof error === 'string') return error;
    if (typeof error === 'object' && error !== null) {
      const e = error as Record<string, unknown>;
      const message = e['message'];
      const code = typeof e['code'] === 'string' ? e['code'] : typeof e['type'] === 'string' ? e['type'] : null;
      if (typeof message === 'string') return code !== null ? `${code}: ${message}` : message;
    }
    return null;
  } catch {
    // Not JSON (a proxy's HTML error page, say). The caller falls back to the raw excerpt.
    return null;
  }
}

/** `Retry-After` is either seconds or an HTTP date. Returns milliseconds, or null when absent or unreadable. */
export function parseRetryAfter(value: string | null, now = Date.now()): number | null {
  if (value === null || value.trim() === '') return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.round(seconds * 1000);
  const date = Date.parse(value);
  return Number.isNaN(date) ? null : Math.max(0, date - now);
}

export interface FailureContext {
  provider: string;
  label: string;
  model: string | null;
  /** Name of the variable that holds this provider's key, for the message. */
  keyVariable: string;
  modelVariable: string;
  secrets: readonly string[];
}

/**
 * Turn a non-2xx answer into a structured error.
 *
 * The status decides the code; the vendor's own message is kept as `cause`
 * (scrubbed and truncated), because "why" is what a person debugging needs.
 */
export function failureFromResponse(
  ctx: FailureContext,
  status: number,
  body: string,
  headers: { get(name: string): string | null },
): ProviderError {
  const said = vendorMessage(body) ?? (body.trim() === '' ? null : body);
  const cause = said === null ? `HTTP ${status}` : `HTTP ${status}: ${excerpt(said, ctx.secrets)}`;
  const base = { provider: ctx.provider, model: ctx.model, cause, httpStatus: status };
  const lower = (said ?? '').toLowerCase();

  if (status === 401 || status === 403) {
    return new ProviderError('PROVIDER_AUTH_FAILED', {
      ...base,
      detail: `${ctx.label} rechazó las credenciales (HTTP ${status}). Revisa ${ctx.keyVariable}: la clave puede ser incorrecta, estar revocada o no tener permiso para este modelo.`,
    });
  }
  // Out of credit is not a rate limit and not a bad request: waiting does not fix
  // it and neither does changing the request. (Anthropic reports it as a 400.)
  // 402 Payment Required: the host wants credit or an activated plan. Treat as
  // exhausted quota so the engine moves on to another provider.
  if (status === 402 || ((status === 429 || status === 400) && /insufficient_quota|billing|exceeded your current quota|credit balance/.test(lower))) {
    return new ProviderError('PROVIDER_QUOTA_EXHAUSTED', {
      ...base,
      detail: `${ctx.label} indica que la cuenta se ha quedado sin cuota o saldo. Revisa el plan y la facturación de la cuenta.`,
    });
  }
  if (status === 429) {
    return new ProviderError('PROVIDER_RATE_LIMITED', {
      ...base,
      retryAfterMs: parseRetryAfter(headers.get('retry-after')),
      detail: `${ctx.label} limitó las solicitudes (HTTP 429). Se reintenta pasado un tiempo de espera.`,
    });
  }
  // 413: the request is bigger than this plan allows per call (free tiers cap
  // tokens per request). The same request will not fit later either, but another
  // provider may take it — so it is treated like a limit hit, which sends the
  // engine to the next provider instead of ending the step.
  if (status === 413) {
    return new ProviderError('PROVIDER_RATE_LIMITED', {
      ...base,
      detail: `${ctx.label} rechazó la petición por ser demasiado grande para el límite de su plan (HTTP 413). Se prueba con otro proveedor.`,
    });
  }
  if (status === 408 || status === 504) {
    return new ProviderError('PROVIDER_TIMEOUT', { ...base, detail: `${ctx.label} no respondió a tiempo (HTTP ${status}).` });
  }
  if (status >= 500) {
    return new ProviderError('PROVIDER_UNAVAILABLE', {
      ...base,
      retryAfterMs: parseRetryAfter(headers.get('retry-after')),
      detail: `${ctx.label} no está disponible ahora mismo (HTTP ${status}).`,
    });
  }
  if (status === 404 && ctx.model !== null) {
    return new ProviderError('PROVIDER_BAD_REQUEST', {
      ...base,
      detail: `${ctx.label} no reconoce el modelo «${ctx.model}» (HTTP 404). Revisa ${ctx.modelVariable}.`,
    });
  }
  return new ProviderError('PROVIDER_BAD_REQUEST', {
    ...base,
    detail: `${ctx.label} rechazó la solicitud (HTTP ${status}). No se reintenta: la misma solicitud volvería a fallar.`,
  });
}

/**
 * Make one HTTP call with a timeout and the caller's cancellation.
 *
 * Every way it can fail is a `ProviderError`; nothing else escapes.
 */
export async function requestJson(req: HttpRequest, ctx: FailureContext): Promise<HttpResponse> {
  const startedAt = Date.now();
  // Already cancelled (the mission was stopped between routing and the call):
  // there is nothing to send.
  if (req.signal?.aborted === true) {
    throw new ProviderError('PROVIDER_CANCELLED', { provider: ctx.provider, model: ctx.model, detail: `La llamada a ${ctx.label} fue cancelada antes de enviarse.` });
  }
  // A function, not a value: the signal can flip while the request is in flight.
  const cancelled = (): boolean => req.signal?.aborted === true;
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, req.timeoutMs);
  const onAbort = () => controller.abort();
  req.signal?.addEventListener('abort', onAbort, { once: true });

  try {
    let response: Awaited<ReturnType<HttpFetch>>;
    try {
      response = await req.fetch(req.url, {
        method: req.method,
        headers: req.headers,
        ...(req.body !== undefined ? { body: JSON.stringify(req.body) } : {}),
        signal: controller.signal,
      });
    } catch (error) {
      if (timedOut) {
        throw new ProviderError('PROVIDER_TIMEOUT', {
          provider: ctx.provider,
          model: ctx.model,
          detail: `${ctx.label} no respondió en ${formatMs(req.timeoutMs)}.`,
        });
      }
      if (cancelled()) {
        throw new ProviderError('PROVIDER_CANCELLED', { provider: ctx.provider, model: ctx.model, detail: `La llamada a ${ctx.label} fue cancelada.` });
      }
      const reason = error instanceof Error ? error.message : String(error);
      throw new ProviderError('PROVIDER_UNAVAILABLE', {
        provider: ctx.provider,
        model: ctx.model,
        cause: excerpt(reason, req.secrets),
        detail: `No se pudo conectar con ${ctx.label}: ${excerpt(reason, req.secrets)}`,
      });
    }

    let body: string;
    try {
      body = await response.text();
    } catch (error) {
      if (timedOut) {
        throw new ProviderError('PROVIDER_TIMEOUT', {
          provider: ctx.provider,
          model: ctx.model,
          detail: `${ctx.label} no terminó de responder en ${formatMs(req.timeoutMs)}.`,
        });
      }
      if (cancelled()) {
        throw new ProviderError('PROVIDER_CANCELLED', { provider: ctx.provider, model: ctx.model, detail: `La llamada a ${ctx.label} fue cancelada.` });
      }
      throw new ProviderError('PROVIDER_UNAVAILABLE', {
        provider: ctx.provider,
        model: ctx.model,
        cause: excerpt(error instanceof Error ? error.message : String(error), req.secrets),
        detail: `Se cortó la conexión con ${ctx.label} mientras respondía.`,
      });
    }

    const headers = response.headers ?? EMPTY_HEADERS;
    if (!response.ok) throw failureFromResponse(ctx, response.status, body, headers);

    let json: unknown;
    try {
      json = JSON.parse(body);
    } catch {
      throw new ProviderError('PROVIDER_INVALID_RESPONSE', {
        provider: ctx.provider,
        model: ctx.model,
        cause: `cuerpo no JSON: ${excerpt(body, req.secrets)}`,
        detail: `${ctx.label} respondió con algo que no es JSON válido.`,
      });
    }
    return { status: response.status, json, headers, latencyMs: Date.now() - startedAt };
  } finally {
    clearTimeout(timer);
    req.signal?.removeEventListener('abort', onAbort);
  }
}

function formatMs(ms: number): string {
  return ms < 1000 ? `${ms} ms` : `${Math.round(ms / 1000)} s`;
}

/** A malformed success body. Always a structured error, never a fabricated result. */
export function invalidResponse(ctx: FailureContext, what: string, options: { retryable?: boolean } = {}): ProviderError {
  return new ProviderError('PROVIDER_INVALID_RESPONSE', {
    provider: ctx.provider,
    model: ctx.model,
    cause: what,
    detail: `${ctx.label} respondió con un formato inesperado: ${what}.`,
    ...(options.retryable !== undefined ? { retryable: options.retryable } : {}),
  });
}

// ---------------------------------------------------------------------------
// Small readers for untyped JSON
// ---------------------------------------------------------------------------

export function obj(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

export function count(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.round(value) : 0;
}
