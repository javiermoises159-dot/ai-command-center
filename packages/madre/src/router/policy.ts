/**
 * Routing policy: what the router optimises for, as data.
 *
 * The old router carried its preferences inside one long comparator. This file
 * turns them into a `RoutingPolicy` value that can be read, diffed and
 * overridden per deployment or per call, without touching the routing code.
 *
 * Two rules keep the policy honest:
 *
 *  1. The ladder in `tierOrder` is the backbone and is applied *before* any
 *     weighting. The simulated provider is pinned to the very last rung
 *     whatever the configured order says, so no configuration can make MADRE
 *     answer with a simulation while a real model is available.
 *  2. The weights only break ties between candidates that already satisfy
 *     every hard requirement — required model capabilities, privacy, budget.
 *     A weight can reorder equals; it can never promote a model that cannot do
 *     the work.
 */

import type { ModelCapabilities, ModelProfile, ProviderProfile, ProviderTier, RoutingPolicy } from '../types.ts';
import { clamp, round } from '../util.ts';

/** The names of the model capabilities a step can demand. */
export type ModelCapabilityName = keyof ModelCapabilities;

/** How each capability is described when the router explains a discard. */
const CAPABILITY_LABELS: Record<ModelCapabilityName, string> = {
  streaming: 'respuesta en streaming',
  toolCalling: 'llamada a herramientas',
  structuredOutput: 'salida estructurada',
  embeddings: 'generación de embeddings',
  vision: 'lectura de imágenes',
};

export function labelCapability(name: ModelCapabilityName): string {
  return CAPABILITY_LABELS[name];
}

/**
 * The default policy: local first, simulated last.
 *
 *     LOCAL  →  LOCAL POTENTE  →  EXTERNO  →  ESPECIALIZADO  →  SIMULADO
 *
 * The weights favour quality and privacy, with cost and latency as the finer
 * tie-breakers, and they only ever sort candidates that are already acceptable.
 */
export const DEFAULT_ROUTING_POLICY: RoutingPolicy = Object.freeze({
  tierOrder: ['local', 'local_strong', 'external', 'specialized', 'mock'] as ProviderTier[],
  weights: Object.freeze({ quality: 0.4, cost: 0.2, latency: 0.15, privacy: 0.25 }),
  localOnly: false,
  circuitBreakerThreshold: 3,
  circuitBreakerCooldownMs: 60_000,
  maxFallbacks: 3,
}) as RoutingPolicy;

/** Fill a partial policy from the defaults. Nested objects are merged, not replaced wholesale. */
export function resolveRoutingPolicy(overrides: Partial<RoutingPolicy> = {}): RoutingPolicy {
  return {
    tierOrder: [...(overrides.tierOrder ?? DEFAULT_ROUTING_POLICY.tierOrder)],
    weights: { ...DEFAULT_ROUTING_POLICY.weights, ...overrides.weights },
    localOnly: overrides.localOnly ?? DEFAULT_ROUTING_POLICY.localOnly,
    circuitBreakerThreshold: Math.max(1, overrides.circuitBreakerThreshold ?? DEFAULT_ROUTING_POLICY.circuitBreakerThreshold),
    circuitBreakerCooldownMs: Math.max(0, overrides.circuitBreakerCooldownMs ?? DEFAULT_ROUTING_POLICY.circuitBreakerCooldownMs),
    maxFallbacks: Math.max(0, overrides.maxFallbacks ?? DEFAULT_ROUTING_POLICY.maxFallbacks),
  };
}

/**
 * Position of a tier on the ladder — lower is preferred.
 *
 * `mock` is pinned below everything else, and a tier the policy forgot to list
 * sorts after the ones it did list rather than jumping the queue.
 */
export function tierRank(policy: RoutingPolicy, tier: ProviderTier): number {
  if (tier === 'mock') return Number.MAX_SAFE_INTEGER;
  const index = policy.tierOrder.indexOf(tier);
  return index === -1 ? policy.tierOrder.length : index;
}

export function labelTier(tier: ProviderTier): string {
  switch (tier) {
    case 'local':
      return 'local';
    case 'local_strong':
      return 'local potente';
    case 'external':
      return 'externo';
    case 'specialized':
      return 'especializado';
    case 'mock':
      return 'simulado';
  }
}

/** A model's declared price for one call, or `null` when the vendor's price is unknown. */
export function knownPrice(model: ModelProfile): number | null {
  if (model.pricePer1kInputUsd === null || model.pricePer1kOutputUsd === null) return null;
  return model.pricePer1kInputUsd + model.pricePer1kOutputUsd;
}

export interface ScoreInput {
  provider: ProviderProfile;
  model: ModelProfile;
}

export interface ScoreContext {
  /** Highest known price among the candidates being compared. */
  maxPrice: number;
  /** Highest known latency among the candidates being compared. */
  maxLatencyMs: number;
}

export function scoreContext(candidates: readonly ScoreInput[]): ScoreContext {
  const prices = candidates.map((c) => knownPrice(c.model)).filter((p): p is number => p !== null);
  const latencies = candidates.map((c) => c.model.typicalLatencyMs).filter((l): l is number => l !== null);
  return {
    maxPrice: prices.length > 0 ? Math.max(...prices) : 0,
    maxLatencyMs: latencies.length > 0 ? Math.max(...latencies) : 0,
  };
}

/** Privacy as a 0..1 score: on the machine is best, a third party is worst. */
function privacyScore(privacy: ProviderProfile['privacy']): number {
  switch (privacy) {
    case 'on_device':
      return 1;
    case 'simulated':
      return 0.5;
    case 'third_party':
      return 0;
  }
}

export interface ScoreBreakdown {
  total: number;
  quality: number;
  cost: number;
  latency: number;
  privacy: number;
}

/**
 * Weighted score in 0..1 for a candidate that already passed every filter.
 *
 * An unknown price or latency scores 0 on that axis: MADRE never invents a
 * number, and "we do not know" is not evidence of being cheap or fast.
 */
export function scoreCandidate(candidate: ScoreInput, policy: RoutingPolicy, context: ScoreContext): ScoreBreakdown {
  const price = knownPrice(candidate.model);
  const latency = candidate.model.typicalLatencyMs;

  const quality = clamp(candidate.model.quality / 5, 0, 1);
  const cost = price === null ? 0 : context.maxPrice === 0 ? 1 : clamp(1 - price / context.maxPrice, 0, 1);
  const latencyScore = latency === null ? 0 : context.maxLatencyMs === 0 ? 1 : clamp(1 - latency / context.maxLatencyMs, 0, 1);
  const privacy = privacyScore(candidate.provider.privacy);

  const weights = policy.weights;
  const sum = weights.quality + weights.cost + weights.latency + weights.privacy;
  const total =
    sum <= 0 ? 0 : (quality * weights.quality + cost * weights.cost + latencyScore * weights.latency + privacy * weights.privacy) / sum;

  return {
    total: round(total, 4),
    quality: round(quality, 4),
    cost: round(cost, 4),
    latency: round(latencyScore, 4),
    privacy: round(privacy, 4),
  };
}

/** `0,73` — Spanish decimal separator, for the rationale. */
export function formatScore(value: number): string {
  return round(value, 2).toFixed(2).replace('.', ',');
}
