/**
 * Self-healing.
 *
 * When a step fails, this module decides what to do next. It diagnoses the
 * error, classifies it, and returns a *bounded* action. It never loops: the
 * engine allows a fixed number of attempts per step, and each diagnosis says
 * whether another attempt is worthwhile at all.
 *
 *   timeout / rate limit      → retry after a backoff
 *   provider unavailable/auth → switch provider (and mark it failing)
 *   empty or unusable output  → retry once with a corrective instruction
 *   invalid request           → do not retry; the same request will fail again
 *   budget                    → do not retry; ask or fall back to local
 *   cancelled                 → stop
 */

import { DomainError, ProviderError } from '@acc/domain';

export type FailureClass =
  | 'timeout'
  | 'rate_limit'
  | 'provider_unavailable'
  | 'auth'
  | 'quota'
  | 'invalid_response'
  | 'bad_output'
  | 'invalid_request'
  | 'budget'
  | 'cancelled'
  | 'unknown';

export type HealingAction = 'retry' | 'retry_with_correction' | 'switch_provider' | 'fail' | 'stop';

/** Human-readable (Spanish) names for failure classes and actions, for messages a person reads. */
export const FAILURE_CLASS_LABEL: Record<FailureClass, string> = {
  timeout: 'tiempo de espera agotado',
  rate_limit: 'límite de solicitudes',
  provider_unavailable: 'proveedor no disponible',
  auth: 'error de autenticación',
  quota: 'cuota agotada',
  invalid_response: 'respuesta del proveedor no válida',
  bad_output: 'respuesta inutilizable',
  invalid_request: 'solicitud no válida',
  budget: 'presupuesto',
  cancelled: 'cancelado',
  unknown: 'error desconocido',
};

export const HEALING_ACTION_LABEL: Record<HealingAction, string> = {
  retry: 'reintentar',
  retry_with_correction: 'reintentar con una corrección',
  switch_provider: 'cambiar de proveedor',
  fail: 'dar el paso por fallido',
  stop: 'detener',
};

export interface Diagnosis {
  class: FailureClass;
  action: HealingAction;
  /** Another attempt may succeed. */
  retryable: boolean;
  /** Mark the provider as failing and route around it. */
  switchProvider: boolean;
  backoffMs: number;
  explanation: string;
}

export class BadOutputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BadOutputError';
  }
}

export class BudgetExceededError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BudgetExceededError';
  }
}

export class CancelledError extends Error {
  constructor(message = 'La ejecución fue cancelada.') {
    super(message);
    this.name = 'CancelledError';
  }
}

export interface HealingOptions {
  baseBackoffMs: number;
  maxBackoffMs: number;
  /** Pool mode: a failure that another provider might not have goes straight to the next provider. */
  poolSwitch?: boolean;
}

export const DEFAULT_HEALING: HealingOptions = { baseBackoffMs: 500, maxBackoffMs: 8000 };

function backoff(attempt: number, options: HealingOptions, multiplier = 1): number {
  return Math.min(options.maxBackoffMs, options.baseBackoffMs * multiplier * 2 ** Math.max(0, attempt - 1));
}

const POOL_SWITCH_CLASSES: ReadonlySet<FailureClass> = new Set(['timeout', 'rate_limit', 'provider_unavailable', 'invalid_response', 'bad_output', 'unknown', 'quota', 'auth']);

export function diagnose(error: unknown, attempt: number, options: HealingOptions = DEFAULT_HEALING): Diagnosis {
  const d = diagnoseOnce(error, attempt, options);
  if (options.poolSwitch !== true || !POOL_SWITCH_CLASSES.has(d.class)) return d;
  // In the pool another provider is one step away: switch at once instead of waiting or retrying the same one.
  return { ...d, action: 'switch_provider', retryable: true, switchProvider: true, backoffMs: Math.min(d.backoffMs, 300) };
}

function diagnoseOnce(error: unknown, attempt: number, options: HealingOptions): Diagnosis {
  const message = error instanceof Error ? error.message : String(error);
  // Classification reads the raw message; what a person is shown is the curated
  // one. A domain error's `message` is developer English, its `publicMessage` is Spanish.
  const explanation = error instanceof DomainError ? error.publicMessage : message;

  if (error instanceof CancelledError) {
    return { class: 'cancelled', action: 'stop', retryable: false, switchProvider: false, backoffMs: 0, explanation };
  }
  if (error instanceof BudgetExceededError) {
    return { class: 'budget', action: 'fail', retryable: false, switchProvider: false, backoffMs: 0, explanation };
  }
  if (error instanceof BadOutputError) {
    return {
      class: 'bad_output',
      action: attempt < 2 ? 'retry_with_correction' : 'fail',
      retryable: attempt < 2,
      switchProvider: false,
      backoffMs: 0,
      explanation,
    };
  }

  if (error instanceof ProviderError) return diagnoseProviderError(error, attempt, options);

  if (error instanceof DomainError) {
    switch (error.code) {
      case 'provider_timeout':
        return { class: 'timeout', action: 'retry', retryable: true, switchProvider: attempt >= 2, backoffMs: backoff(attempt, options), explanation };
      case 'provider_not_configured':
        return { class: 'provider_unavailable', action: 'switch_provider', retryable: true, switchProvider: true, backoffMs: 0, explanation };
      case 'validation_error':
        return { class: 'invalid_request', action: 'fail', retryable: false, switchProvider: false, backoffMs: 0, explanation };
      default:
        break;
    }
  }

  const lower = message.toLowerCase();
  if (/\b429\b|rate.?limit|too many requests|quota|demasiadas solicitudes|l[ií]mite de (?:solicitudes|peticiones|uso)|cuota/.test(lower)) {
    return { class: 'rate_limit', action: 'retry', retryable: true, switchProvider: attempt >= 2, backoffMs: backoff(attempt, options, 2), explanation };
  }
  if (/\b401\b|\b403\b|unauthori[sz]ed|forbidden|invalid api key|authentication|no autorizad|prohibido|clave (?:de api )?(?:no v[aá]lida|inv[aá]lida)|autenticaci[oó]n/.test(lower)) {
    return { class: 'auth', action: 'switch_provider', retryable: true, switchProvider: true, backoffMs: 0, explanation };
  }
  if (/timed? ?out|timeout|etimedout|aborted due to timeout|tiempo de espera|tiempo l[ií]mite|se agot[oó] el tiempo/.test(lower)) {
    return { class: 'timeout', action: 'retry', retryable: true, switchProvider: attempt >= 2, backoffMs: backoff(attempt, options), explanation };
  }
  if (/econnrefused|econnreset|enotfound|fetch failed|socket hang up|network|\b50[0-4]\b|unavailable|overloaded|no disponible|sobrecargad|error de red|sin conexi[oó]n/.test(lower)) {
    return { class: 'provider_unavailable', action: 'switch_provider', retryable: true, switchProvider: true, backoffMs: backoff(attempt, options), explanation };
  }
  if (/\b400\b|\b422\b|invalid request|context length|too long|maximum context|solicitud no v[aá]lida|longitud del contexto|demasiado larg|contexto m[aá]ximo/.test(lower)) {
    return { class: 'invalid_request', action: 'fail', retryable: false, switchProvider: false, backoffMs: 0, explanation };
  }

  // Unknown: one more try is reasonable, a third is not.
  return {
    class: 'unknown',
    action: attempt < 2 ? 'retry' : 'fail',
    retryable: attempt < 2,
    switchProvider: false,
    backoffMs: backoff(attempt, options),
    explanation,
  };
}

/**
 * A structured provider error says what it is; nothing is guessed from its text.
 *
 * Retry policy, by code:
 *   timeout / rate limit / unavailable / invalid response   retry with backoff, switch after the second attempt
 *   rejected key / exhausted quota / not configured         do not retry here: switch provider
 *   bad request / capability mismatch                       fail: the same request would fail again
 *   circuit open                                            switch provider
 *   unknown cost                                            fail as a budget refusal
 *   cancelled                                               stop
 * A rate limit honours the vendor's `Retry-After` when it sent one, within the
 * engine's backoff ceiling.
 */
function diagnoseProviderError(error: ProviderError, attempt: number, options: HealingOptions): Diagnosis {
  const explanation = error.publicMessage;
  const retryAfter = error.retryAfterMs ?? 0;
  const wait = (multiplier = 1) => Math.min(options.maxBackoffMs, Math.max(backoff(attempt, options, multiplier), retryAfter));
  const retry = (cls: FailureClass, multiplier = 1): Diagnosis => ({
    class: cls,
    action: 'retry',
    retryable: error.retryable,
    switchProvider: attempt >= 2,
    backoffMs: wait(multiplier),
    explanation,
  });
  const switchAway = (cls: FailureClass): Diagnosis => ({ class: cls, action: 'switch_provider', retryable: true, switchProvider: true, backoffMs: 0, explanation });
  const fail = (cls: FailureClass): Diagnosis => ({ class: cls, action: 'fail', retryable: false, switchProvider: false, backoffMs: 0, explanation });

  switch (error.providerCode) {
    case 'PROVIDER_TIMEOUT':
      return retry('timeout');
    case 'PROVIDER_RATE_LIMITED':
      return retry('rate_limit', 2);
    case 'PROVIDER_UNAVAILABLE':
      return retry('provider_unavailable');
    case 'PROVIDER_INVALID_RESPONSE':
      // A refusal is marked non-retryable by the adapter: asking again gets the same answer.
      return error.retryable ? retry('invalid_response') : fail('invalid_response');
    case 'PROVIDER_AUTH_FAILED':
      return switchAway('auth');
    case 'PROVIDER_QUOTA_EXHAUSTED':
      return switchAway('quota');
    case 'PROVIDER_UNCONFIGURED':
    case 'PROVIDER_CIRCUIT_OPEN':
      return switchAway('provider_unavailable');
    case 'PROVIDER_BAD_REQUEST':
    case 'PROVIDER_CAPABILITY_MISMATCH':
      return fail('invalid_request');
    case 'PROVIDER_COST_UNKNOWN':
      return fail('budget');
    case 'PROVIDER_CANCELLED':
      return { class: 'cancelled', action: 'stop', retryable: false, switchProvider: false, backoffMs: 0, explanation };
    case 'PROVIDER_FAILED':
      return { class: 'unknown', action: attempt < 2 ? 'retry' : 'fail', retryable: attempt < 2, switchProvider: false, backoffMs: backoff(attempt, options), explanation };
  }
}

/** Checks a provider result for the kinds of "success" that are really failures. */
export function assertUsableOutput(text: string, minChars = 40): void {
  const trimmed = text.trim();
  if (trimmed.length === 0) throw new BadOutputError('El proveedor devolvió una respuesta vacía.');
  if (trimmed.length < minChars) throw new BadOutputError(`El proveedor devolvió solo ${trimmed.length} caracteres.`);
  if (/^(?:i (?:can(?:'|no)t|am unable)|lo siento, no puedo|mi dispiace, non posso)\b/i.test(trimmed) && trimmed.length < 300) {
    throw new BadOutputError('El proveedor se negó o no pudo responder.');
  }
}
