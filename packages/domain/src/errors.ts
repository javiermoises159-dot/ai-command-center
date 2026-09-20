/**
 * Domain error taxonomy.
 *
 * Every error carries a machine-readable `code` and an HTTP `status` hint, so
 * the transport layer can translate without a pile of `instanceof` checks and
 * without leaking stack traces to clients.
 */

export type ErrorCode =
  | 'validation_error'
  | 'mission_not_found'
  | 'run_not_found'
  | 'not_found'
  | 'conflict'
  | 'mission_already_running'
  | 'provider_not_configured'
  | 'provider_failed'
  | 'provider_timeout'
  | 'provider_error'
  | 'invalid_transition'
  | 'internal_error';

export interface FieldIssue {
  path: string;
  message: string;
}

export class DomainError extends Error {
  readonly code: ErrorCode;
  readonly status: number;
  readonly issues: FieldIssue[];
  /** Safe to show to an end user; `message` may contain internal detail. */
  readonly publicMessage: string;

  constructor(
    code: ErrorCode,
    message: string,
    options: { status?: number; issues?: FieldIssue[]; publicMessage?: string; cause?: unknown } = {},
  ) {
    super(message, options.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = new.target.name;
    this.code = code;
    this.status = options.status ?? 500;
    this.issues = options.issues ?? [];
    this.publicMessage = options.publicMessage ?? message;
  }
}

export class ValidationError extends DomainError {
  constructor(issues: FieldIssue[], message = 'Los datos enviados no son válidos.') {
    super('validation_error', message, { status: 400, issues });
  }
}

export class MissionNotFoundError extends DomainError {
  constructor(missionId: string) {
    super('mission_not_found', `Mission ${missionId} does not exist.`, {
      status: 404,
      publicMessage: 'No se encontró la misión.',
    });
  }
}

export class RunNotFoundError extends DomainError {
  constructor(runId: string) {
    super('run_not_found', `Run ${runId} does not exist.`, {
      status: 404,
      publicMessage: 'No se encontró la ejecución.',
    });
  }
}

export class MissionAlreadyRunningError extends DomainError {
  constructor(missionId: string) {
    super('mission_already_running', `Mission ${missionId} already has an active run.`, {
      status: 409,
      publicMessage: 'Esta misión ya se está ejecutando. Espera a que termine antes de iniciar una nueva ejecución.',
    });
  }
}

/**
 * Thrown by the planned provider adapters. It is deliberately explicit that the
 * adapter is a stub rather than a misconfiguration, so nobody debugs an API key
 * that was never going to be read.
 */
export class ProviderNotConfiguredError extends DomainError {
  constructor(providerId: string, detail: string) {
    super('provider_not_configured', `Provider "${providerId}" is not available: ${detail}`, {
      status: 503,
      publicMessage: `El proveedor «${providerId}» no está disponible en esta versión.`,
    });
  }
}

export class ProviderFailedError extends DomainError {
  constructor(providerId: string, detail: string, cause?: unknown) {
    super('provider_failed', `Provider "${providerId}" failed: ${detail}`, {
      status: 502,
      publicMessage: detail,
      cause,
    });
  }
}

export class ProviderTimeoutError extends DomainError {
  constructor(providerId: string, timeoutMs: number) {
    super('provider_timeout', `Provider "${providerId}" timed out after ${timeoutMs}ms.`, {
      status: 504,
      publicMessage: `El agente no respondió en ${Math.round(timeoutMs / 1000)} s.`,
    });
  }
}

// ---------------------------------------------------------------------------
// Structured provider errors
// ---------------------------------------------------------------------------

/**
 * What went wrong with a provider call, as a code a machine can branch on.
 *
 * The codes are English and stable (they appear in the audit log, the trace and
 * the API); the messages that accompany them are Spanish.
 */
export type ProviderErrorCode =
  | 'PROVIDER_UNCONFIGURED'
  | 'PROVIDER_AUTH_FAILED'
  | 'PROVIDER_QUOTA_EXHAUSTED'
  | 'PROVIDER_RATE_LIMITED'
  | 'PROVIDER_TIMEOUT'
  | 'PROVIDER_UNAVAILABLE'
  | 'PROVIDER_BAD_REQUEST'
  | 'PROVIDER_INVALID_RESPONSE'
  | 'PROVIDER_CAPABILITY_MISMATCH'
  | 'PROVIDER_CIRCUIT_OPEN'
  | 'PROVIDER_COST_UNKNOWN'
  | 'PROVIDER_CANCELLED'
  /** A failure nobody classified: the message is all there is. */
  | 'PROVIDER_FAILED';

/** Where in the life of a call the failure happened. */
export type ProviderErrorStage = 'config' | 'routing' | 'cost' | 'capability' | 'request' | 'response';

/** The serialisable shape of a provider error, for audit, trace and API. Never holds a secret. */
export interface ProviderErrorInfo {
  code: ProviderErrorCode;
  stage: ProviderErrorStage;
  provider: string | null;
  model: string | null;
  /** Another attempt (on this provider, after a backoff) may succeed. */
  retryable: boolean;
  /** Spanish, safe to show. */
  message: string;
  /** The underlying reason in the vendor's or the network's words, already scrubbed of credentials. */
  cause: string | null;
}

interface ProviderErrorTraits {
  stage: ProviderErrorStage;
  /** Retrying may help. */
  retryable: boolean;
  /**
   * Counts against the circuit breaker: the provider is misbehaving right now.
   * A permanent configuration error (bad key, no quota) does not — it will not
   * heal by waiting, so it takes the provider out of service instead (see
   * `permanent`) rather than tripping a breaker that would close again.
   */
  circuit: boolean;
  /** Will keep failing until the operator changes the configuration. */
  permanent: boolean;
}

const TRAITS: Record<ProviderErrorCode, ProviderErrorTraits> = {
  PROVIDER_UNCONFIGURED: { stage: 'config', retryable: false, circuit: false, permanent: true },
  PROVIDER_AUTH_FAILED: { stage: 'request', retryable: false, circuit: false, permanent: true },
  PROVIDER_QUOTA_EXHAUSTED: { stage: 'request', retryable: false, circuit: false, permanent: true },
  PROVIDER_RATE_LIMITED: { stage: 'request', retryable: true, circuit: true, permanent: false },
  PROVIDER_TIMEOUT: { stage: 'request', retryable: true, circuit: true, permanent: false },
  PROVIDER_UNAVAILABLE: { stage: 'request', retryable: true, circuit: true, permanent: false },
  PROVIDER_BAD_REQUEST: { stage: 'request', retryable: false, circuit: false, permanent: false },
  PROVIDER_INVALID_RESPONSE: { stage: 'response', retryable: true, circuit: true, permanent: false },
  PROVIDER_CAPABILITY_MISMATCH: { stage: 'capability', retryable: false, circuit: false, permanent: false },
  PROVIDER_CIRCUIT_OPEN: { stage: 'routing', retryable: false, circuit: false, permanent: false },
  PROVIDER_COST_UNKNOWN: { stage: 'cost', retryable: false, circuit: false, permanent: false },
  PROVIDER_CANCELLED: { stage: 'request', retryable: false, circuit: false, permanent: false },
  PROVIDER_FAILED: { stage: 'request', retryable: false, circuit: false, permanent: false },
};

export function providerErrorTraits(code: ProviderErrorCode): Readonly<ProviderErrorTraits> {
  return TRAITS[code];
}

const HTTP_STATUS: Record<ProviderErrorCode, number> = {
  PROVIDER_UNCONFIGURED: 503,
  PROVIDER_AUTH_FAILED: 502,
  PROVIDER_QUOTA_EXHAUSTED: 502,
  PROVIDER_RATE_LIMITED: 429,
  PROVIDER_TIMEOUT: 504,
  PROVIDER_UNAVAILABLE: 503,
  PROVIDER_BAD_REQUEST: 502,
  PROVIDER_INVALID_RESPONSE: 502,
  PROVIDER_CAPABILITY_MISMATCH: 422,
  PROVIDER_CIRCUIT_OPEN: 503,
  PROVIDER_COST_UNKNOWN: 402,
  PROVIDER_CANCELLED: 499,
  PROVIDER_FAILED: 502,
};

export interface ProviderErrorOptions {
  provider: string | null;
  model?: string | null;
  /** Spanish, one sentence: what happened and what to do. */
  detail: string;
  /** The reason in the vendor's words. Callers scrub credentials before passing it. */
  cause?: string | null;
  stage?: ProviderErrorStage;
  /** Overrides the default for this code (e.g. a refusal is not worth retrying). */
  retryable?: boolean;
  /** How long the vendor asked us to wait, when it said. */
  retryAfterMs?: number | null;
  /** The HTTP status the vendor answered with, when there was one. */
  httpStatus?: number | null;
}

/**
 * A provider call failed in a way the rest of the system can act on.
 *
 * Adapters raise this (never a raw SDK or fetch error), and the engine reads
 * `code` and the traits instead of guessing from message text.
 */
export class ProviderError extends DomainError {
  readonly providerCode: ProviderErrorCode;
  readonly stage: ProviderErrorStage;
  readonly provider: string | null;
  readonly model: string | null;
  readonly retryable: boolean;
  readonly retryAfterMs: number | null;
  readonly httpStatus: number | null;
  readonly causeText: string | null;

  constructor(code: ProviderErrorCode, options: ProviderErrorOptions) {
    const who = options.provider === null ? 'provider' : `provider "${options.provider}"`;
    super('provider_error', `${who} [${code}]: ${options.detail}${options.cause != null ? ` (${options.cause})` : ''}`, {
      status: HTTP_STATUS[code],
      publicMessage: options.detail,
    });
    const traits = TRAITS[code];
    this.providerCode = code;
    this.stage = options.stage ?? traits.stage;
    this.provider = options.provider;
    this.model = options.model ?? null;
    this.retryable = options.retryable ?? traits.retryable;
    this.retryAfterMs = options.retryAfterMs ?? null;
    this.httpStatus = options.httpStatus ?? null;
    this.causeText = options.cause ?? null;
  }

  /** The provider is misbehaving right now: report it to the circuit breaker. */
  get countsAgainstCircuit(): boolean {
    return TRAITS[this.providerCode].circuit && this.retryable;
  }

  /** Fails until the operator changes the configuration: take the provider out of service. */
  get permanent(): boolean {
    return TRAITS[this.providerCode].permanent;
  }

  toInfo(): ProviderErrorInfo {
    return {
      code: this.providerCode,
      stage: this.stage,
      provider: this.provider,
      model: this.model,
      retryable: this.retryable,
      message: this.publicMessage,
      cause: this.causeText,
    };
  }
}

export function isProviderError(error: unknown): error is ProviderError {
  return error instanceof ProviderError;
}

export class InvalidTransitionError extends DomainError {
  constructor(entity: string, from: string, to: string) {
    super('invalid_transition', `Illegal ${entity} transition ${from} -> ${to}.`, { status: 409 });
  }
}

/** Narrow an unknown throwable into something with a stable message. */
export function toDomainError(error: unknown): DomainError {
  if (error instanceof DomainError) return error;
  const message = error instanceof Error ? error.message : String(error);
  return new DomainError('internal_error', message, {
    status: 500,
    publicMessage: 'Se produjo un error inesperado.',
    cause: error,
  });
}

/** Short, user-facing string for any throwable. */
export function errorMessage(error: unknown): string {
  return toDomainError(error).publicMessage;
}
