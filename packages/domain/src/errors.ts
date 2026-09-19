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
  | 'mission_already_running'
  | 'provider_not_configured'
  | 'provider_failed'
  | 'provider_timeout'
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
  constructor(issues: FieldIssue[], message = 'The request payload is invalid.') {
    super('validation_error', message, { status: 400, issues });
  }
}

export class MissionNotFoundError extends DomainError {
  constructor(missionId: string) {
    super('mission_not_found', `Mission ${missionId} does not exist.`, {
      status: 404,
      publicMessage: 'Mission not found.',
    });
  }
}

export class RunNotFoundError extends DomainError {
  constructor(runId: string) {
    super('run_not_found', `Run ${runId} does not exist.`, {
      status: 404,
      publicMessage: 'Run not found.',
    });
  }
}

export class MissionAlreadyRunningError extends DomainError {
  constructor(missionId: string) {
    super('mission_already_running', `Mission ${missionId} already has an active run.`, {
      status: 409,
      publicMessage: 'This mission is already running. Wait for it to finish before starting a new run.',
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
      publicMessage: `The "${providerId}" provider is not available in this build.`,
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
      publicMessage: `The agent did not respond within ${Math.round(timeoutMs / 1000)}s.`,
    });
  }
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
    publicMessage: 'An unexpected error occurred.',
    cause: error,
  });
}

/** Short, user-facing string for any throwable. */
export function errorMessage(error: unknown): string {
  return toDomainError(error).publicMessage;
}
