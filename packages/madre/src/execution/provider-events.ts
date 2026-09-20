/**
 * What the engine says about a provider call.
 *
 * Kept out of `engine.ts` so the shape of the audit events, the structured
 * errors and the provenance rules can be read (and tested) in one place. Nothing
 * here does I/O.
 *
 * Audit event names follow the convention already used by the circuit breaker
 * (`provider.circuit_opened`): a `provider.` namespace, then snake_case.
 *
 *   provider.selected            the router chose a provider and model
 *   provider.excluded            a real provider was turned away for this step
 *   provider.unconfigured        a real provider has no key or model (once per run)
 *   provider.request_started     a call is about to leave for the provider
 *   provider.request_succeeded   it answered
 *   provider.request_failed      it failed, with a structured error
 *   provider.cost_recorded       what the call cost, or that its price is unknown
 *   provider.circuit_opened      (engine.ts) the breaker tripped
 *   provider.circuit_half_open   the cooldown expired; the next call is the probe
 *   provider.circuit_closed      (engine.ts) the probe succeeded
 */

import { DomainError, ProviderError } from '@acc/domain';

import type { ExclusionCode, ProviderErrorCode, ProviderErrorInfo, RouterExplanation } from '../types.ts';
import { redactSecrets } from '../util.ts';

export { provenanceOf } from '../util.ts';
import { BadOutputError, type Diagnosis, type FailureClass } from './healing.ts';

export const PROVIDER_EVENTS = {
  selected: 'provider.selected',
  excluded: 'provider.excluded',
  unconfigured: 'provider.unconfigured',
  requestStarted: 'provider.request_started',
  requestSucceeded: 'provider.request_succeeded',
  requestFailed: 'provider.request_failed',
  costRecorded: 'provider.cost_recorded',
  circuitOpened: 'provider.circuit_opened',
  circuitHalfOpen: 'provider.circuit_half_open',
  circuitClosed: 'provider.circuit_closed',
} as const;

/** Exclusions worth an audit line of their own: the ones that keep a provider from a step. */
export const AUDITED_EXCLUSIONS: ReadonlySet<ExclusionCode> = new Set<ExclusionCode>([
  'disabled',
  'unusable',
  'circuit_open',
  'capability_mismatch',
  'budget',
  'cost_unknown',
  'privacy',
]);

const CAUSE_LIMIT = 300;

const CODE_OF_CLASS: Partial<Record<FailureClass, ProviderErrorCode>> = {
  timeout: 'PROVIDER_TIMEOUT',
  rate_limit: 'PROVIDER_RATE_LIMITED',
  provider_unavailable: 'PROVIDER_UNAVAILABLE',
  auth: 'PROVIDER_AUTH_FAILED',
  quota: 'PROVIDER_QUOTA_EXHAUSTED',
  invalid_request: 'PROVIDER_BAD_REQUEST',
  invalid_response: 'PROVIDER_INVALID_RESPONSE',
  bad_output: 'PROVIDER_INVALID_RESPONSE',
  cancelled: 'PROVIDER_CANCELLED',
};

/**
 * The structured form of whatever a provider call threw.
 *
 * An adapter that raises a `ProviderError` already says everything; anything
 * else (the mock's injected failure, a test double, an unforeseen exception) is
 * classified from the diagnosis so the audit log and the trace never hold an
 * unstructured failure. Text is scrubbed of credentials on the way out.
 */
export function providerErrorInfo(error: unknown, diagnosis: Diagnosis, provider: string, model: string): ProviderErrorInfo {
  if (error instanceof ProviderError) {
    const info = error.toInfo();
    return { ...info, provider: info.provider ?? provider, model: info.model ?? model, message: redactSecrets(info.message), cause: info.cause === null ? null : redactSecrets(info.cause) };
  }
  const raw = error instanceof Error ? error.message : String(error);
  const code: ProviderErrorCode =
    error instanceof DomainError && error.code === 'provider_timeout'
      ? 'PROVIDER_TIMEOUT'
      : error instanceof DomainError && error.code === 'provider_not_configured'
        ? 'PROVIDER_UNCONFIGURED'
        : error instanceof BadOutputError
          ? 'PROVIDER_INVALID_RESPONSE'
          : (CODE_OF_CLASS[diagnosis.class] ?? 'PROVIDER_FAILED');
  return {
    code,
    stage: code === 'PROVIDER_INVALID_RESPONSE' ? 'response' : code === 'PROVIDER_UNCONFIGURED' ? 'config' : 'request',
    provider,
    model,
    retryable: diagnosis.retryable,
    message: redactSecrets(diagnosis.explanation),
    cause: redactSecrets(raw).slice(0, CAUSE_LIMIT),
  };
}

/**
 * The structured error for a step the router could not place.
 * The router says why in `blocked.reason`; `code` says what kind of reason.
 */
export function blockedErrorInfo(code: ProviderErrorCode, message: string, provider: string | null): ProviderErrorInfo {
  return {
    code,
    stage: code === 'PROVIDER_UNCONFIGURED' ? 'config' : code === 'PROVIDER_COST_UNKNOWN' ? 'cost' : code === 'PROVIDER_CAPABILITY_MISMATCH' ? 'capability' : 'routing',
    provider,
    model: null,
    retryable: false,
    message: redactSecrets(message),
    cause: null,
  };
}

/** A compact copy of the router's explanation for the audit log. */
export function explanationData(explanation: RouterExplanation): Record<string, unknown> {
  return {
    selectedProvider: explanation.selectedProvider,
    selectedModel: explanation.selectedModel,
    candidates: explanation.candidates.map((c) => ({ provider: c.providerId, model: c.model, tier: c.tier, source: c.source, score: c.score, estimatedCostUsd: c.estimatedCostUsd, selected: c.selected })),
    excluded: explanation.excludedCandidates.map((e) => ({ provider: e.providerId, model: e.model, code: e.code, errorCode: e.errorCode, reason: e.reason })),
  };
}
