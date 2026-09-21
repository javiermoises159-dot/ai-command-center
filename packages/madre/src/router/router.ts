/**
 * Smart router.
 *
 * For every step it decides which agent runs it, on which provider and model,
 * with which tools, whether that happens locally or off the machine, whether a
 * person must approve it, and how confident the choice is — and it explains
 * itself in `rationale`.
 *
 * The preferences are not hard-coded here: they live in a `RoutingPolicy`
 * (see `./policy.ts`), which can be replaced per deployment or per call. The
 * default policy keeps the ladder local-first:
 *
 *     LOCAL  →  STRONGER LOCAL  →  EXTERNAL  →  SPECIALIZED  →  SIMULATED
 *
 * The router takes the lowest rung that is *good enough* for the step. It only
 * climbs when something forces it to: the step is harder than the local
 * models can handle, it needs a capability they do not declare, it needs live
 * information only an external model offers, or a lower rung is unavailable.
 * Sensitive input never leaves the machine. The simulated provider is a last
 * resort for development and is always labelled as such.
 *
 * Order of business, and it matters: the hard requirements filter first
 * (circuit breaker, privacy, declared capabilities, budget), then the ladder
 * orders what survived, and only then do the policy weights break ties. A
 * weight can reorder equals; it can never promote a model that cannot do the
 * work.
 */

import type { CostController } from '../cost/controller.ts';
import type { PermissionPolicy } from '../permissions/policy.ts';
import type { AgentRegistry } from '../registry/agents.ts';
import type { ProviderCatalog } from '../registry/providers.ts';
import type { ToolRegistry } from '../registry/tools.ts';
import type {
  CircuitState,
  ExcludedCandidate,
  ExclusionCode,
  MissionPlan,
  MissionStep,
  ModelProfile,
  ProviderProfile,
  ProviderErrorCode,
  ProviderTier,
  RouterCandidate,
  RouterExplanation,
  RoutingDecision,
  RoutingPolicy,
} from '../types.ts';
import { clamp, round, systemClock, type Clock } from '../util.ts';
import { CircuitBreaker } from './circuit.ts';
import {
  DEFAULT_ROUTING_POLICY,
  formatScore,
  labelCapability,
  labelTier,
  resolveRoutingPolicy,
  scoreCandidate,
  scoreContext,
  tierRank,
  type ModelCapabilityName,
  type ScoreBreakdown,
} from './policy.ts';

export { CircuitBreaker } from './circuit.ts';
export {
  DEFAULT_ROUTING_POLICY,
  labelCapability,
  labelTier,
  resolveRoutingPolicy,
  scoreCandidate,
  type ModelCapabilityName,
} from './policy.ts';

/** Rough size of a step's call, for cost estimates only. */
export const ESTIMATED_PROMPT_TOKENS = 1500;
export const ESTIMATED_COMPLETION_TOKENS = 700;

/** How many discards the rationale spells out before it summarises the rest. */
const MAX_EXPLAINED_DISCARDS = 4;

export interface RouteOptions {
  missionId?: string;
  /** Providers to skip, e.g. ones that just failed. */
  avoidProviders?: readonly string[];
  /**
   * Restrict the choice to one provider (and, optionally, one model): the one a
   * mission was started with. Everything else still applies — circuit breaker,
   * permissions, privacy, budget — so a pin narrows the candidates, it never
   * bypasses a control. If the pinned provider cannot be used the step is
   * blocked with the reason; it is never quietly sent somewhere else.
   */
  pin?: { providerId: string; model?: string | null };
  /** 1 = most urgent. Supplied by `computePriorities`. */
  priority?: number;
  /** Set to keep everything on the machine, on top of whatever the policy says. */
  localOnly?: boolean;
  /**
   * Model capabilities this step needs from the model *itself*.
   *
   * MADRE executes tools host-side, so a step having tool requests does not by
   * itself demand `toolCalling`: the caller asks for it when the step is to be
   * run with in-model tool use, or for `structuredOutput` when the answer must
   * follow a schema. Candidates that do not declare every capability listed
   * here are discarded, and if none is left the step is blocked with the
   * reason — the router never picks a model that cannot do the job.
   */
  requireCapabilities?: readonly ModelCapabilityName[];
  /** Override the router's policy for this call only. */
  policy?: Partial<RoutingPolicy>;
}

export interface RouterOptions {
  /** Overrides on top of `DEFAULT_ROUTING_POLICY`. */
  policy?: Partial<RoutingPolicy>;
  /** Time source for the circuit breaker. Injected so tests can control it. */
  clock?: Clock;
  /**
   * Alternate between providers that tie on everything that matters (tier,
   * score, quality), instead of always choosing the first by name. Off by
   * default so routing stays fully predictable unless the operator asks.
   */
  balanceTies?: boolean;
}

interface Candidate {
  provider: ProviderProfile;
  model: ModelProfile;
}

/** A candidate that was taken out of the running, and why — for the rationale. */
interface Discard {
  candidate: Candidate;
  reason: string;
  code: ExclusionCode;
}

/**
 * What `decide` learns along the way that the structured explanation needs: who
 * was excluded before any model was considered, who dropped out after, and the
 * ranking of those that stayed. Filled by `decide`, read by `route`.
 */
interface ExplainState {
  excluded: ExcludedCandidate[];
  discards: Discard[];
  ranked: Candidate[];
  others: Candidate[];
  score: ((candidate: Candidate) => ScoreBreakdown) | null;
}

/** A failed health probe this recent counts against a provider (see `demoted`). */
const FRESH_HEALTH_MS = 120_000;

const ERROR_CODE_OF: Partial<Record<ExclusionCode, ProviderErrorCode>> = {
  unconfigured: 'PROVIDER_UNCONFIGURED',
  circuit_open: 'PROVIDER_CIRCUIT_OPEN',
  capability_mismatch: 'PROVIDER_CAPABILITY_MISMATCH',
  cost_unknown: 'PROVIDER_COST_UNKNOWN',
};

/** Why a provider that is not executable was left out, from the states the catalog reports. */
function whyNotExecutable(provider: ProviderProfile): ExcludedCandidate {
  const base = { providerId: provider.id, model: null };
  if (!provider.enabled) return { ...base, code: 'disabled', errorCode: null, reason: provider.statusDetail };
  if (!provider.implemented) return { ...base, code: 'not_implemented', errorCode: null, reason: 'el adaptador está declarado pero no implementado' };
  if (!provider.configured) return { ...base, code: 'unconfigured', errorCode: 'PROVIDER_UNCONFIGURED', reason: provider.statusDetail };
  if (!provider.available) return { ...base, code: 'unavailable', errorCode: null, reason: provider.statusDetail };
  return { ...base, code: 'unusable', errorCode: null, reason: provider.statusDetail };
}

export class SmartRouter {
  private readonly routing: RoutingPolicy;
  private readonly circuit: CircuitBreaker;
  private readonly clock: Clock;
  private readonly balanceTies: boolean;

  constructor(
    private readonly agents: AgentRegistry,
    private readonly providers: ProviderCatalog,
    private readonly tools: ToolRegistry,
    private readonly permissions: PermissionPolicy,
    private readonly cost: CostController,
    options: RouterOptions = {},
  ) {
    this.routing = resolveRoutingPolicy(options.policy);
    this.clock = options.clock ?? systemClock;
    this.balanceTies = options.balanceTies === true;
    this.circuit = new CircuitBreaker(this.clock, {
      threshold: this.routing.circuitBreakerThreshold,
      cooldownMs: this.routing.circuitBreakerCooldownMs,
    });
  }

  /** The policy in force. A copy: changing it has no effect on the router. */
  get policy(): RoutingPolicy {
    return { ...this.routing, tierOrder: [...this.routing.tierOrder], weights: { ...this.routing.weights } };
  }

  // ---- circuit breaker: the engine reports outcomes here -------------------

  /** Report a successful call. Clears the provider's failure record. */
  recordSuccess(providerId: string): CircuitState {
    return this.circuit.recordSuccess(providerId);
  }

  /** Report a failed call. Trips the breaker once the threshold is reached. */
  recordFailure(providerId: string): CircuitState {
    return this.circuit.recordFailure(providerId);
  }

  /** A provider's standing with the breaker, or `null` when it has no record. */
  circuitState(providerId: string): CircuitState | null {
    return this.circuit.state(providerId);
  }

  /** Every provider the breaker has seen. */
  circuitStates(): CircuitState[] {
    return this.circuit.states();
  }

  /** Forget the breaker's record for one provider, or for all of them. */
  resetCircuits(providerId?: string): void {
    this.circuit.reset(providerId);
  }

  /**
   * Providers whose cooldown has expired since the last call — now half-open,
   * waiting for a probe. Each is reported once so the engine can audit it.
   */
  takeCircuitTransitions(): string[] {
    return this.circuit.takeHalfOpened();
  }

  /**
   * Take a provider out of service because its configuration is wrong (a
   * rejected key, an exhausted quota). Not a circuit-breaker matter: a breaker
   * closes again after a cooldown and would send the next step straight into
   * the same rejection. The provider stays out until the operator fixes it and
   * the server restarts (or `clearProviderFault` is called).
   */
  markProviderUnusable(providerId: string, detail: string): void {
    this.providers.markError(providerId, detail);
  }

  clearProviderFault(providerId: string): void {
    this.providers.clearError(providerId);
  }

  /**
   * Decide where a step runs. The decision carries a structured `explanation`:
   * the selected provider and model, the candidates that were in the running,
   * and every candidate that was turned away with a machine-readable code.
   */
  async route(step: MissionStep, options: RouteOptions = {}): Promise<RoutingDecision> {
    const ex: ExplainState = { excluded: [], discards: [], ranked: [], others: [], score: null };
    const decision = await this.decide(step, options, ex);
    decision.explanation = this.explain(decision, ex);
    return decision;
  }

  private explain(decision: RoutingDecision, ex: ExplainState): RouterExplanation {
    const selected = decision.provider;
    const seen = new Set<string>();
    const candidates: RouterCandidate[] = [];
    for (const candidate of [...ex.ranked, ...ex.others]) {
      const key = `${candidate.provider.id}:${candidate.model.id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      candidates.push({
        providerId: candidate.provider.id,
        model: candidate.model.id,
        tier: candidate.model.tier,
        source: candidate.provider.source,
        score: ex.score === null ? null : ex.score(candidate).total,
        estimatedCostUsd: this.cost.estimate(candidate.provider.id, candidate.model.id, ESTIMATED_PROMPT_TOKENS, ESTIMATED_COMPLETION_TOKENS),
        selected: selected !== null && selected.id === candidate.provider.id && selected.model === candidate.model.id,
      });
    }

    const excluded: ExcludedCandidate[] = [...ex.excluded];
    const seenExcluded = new Set(excluded.map((e) => `${e.providerId}:${e.model ?? ''}:${e.code}`));
    for (const discard of ex.discards) {
      const chosen = selected !== null && selected.id === discard.candidate.provider.id && selected.model === discard.candidate.model.id;
      if (chosen) continue;
      const key = `${discard.candidate.provider.id}:${discard.candidate.model.id}:${discard.code}`;
      if (seenExcluded.has(key)) continue;
      seenExcluded.add(key);
      excluded.push({
        providerId: discard.candidate.provider.id,
        model: discard.candidate.model.id,
        code: discard.code,
        errorCode: ERROR_CODE_OF[discard.code] ?? null,
        reason: discard.reason,
      });
    }

    return {
      selectedProvider: selected?.id ?? null,
      selectedModel: selected?.model ?? null,
      candidates,
      excludedCandidates: excluded,
      reasons: [...decision.rationale],
    };
  }

  private async decide(step: MissionStep, options: RouteOptions, ex: ExplainState): Promise<RoutingDecision> {
    const policy = options.policy === undefined ? this.routing : resolveRoutingPolicy({ ...this.routing, ...options.policy });
    const decision: RoutingDecision = {
      stepId: step.id,
      agentId: step.agentId,
      provider: null,
      fallbacks: [],
      tools: [],
      execution: 'none',
      needsExternalService: false,
      requiresApproval: false,
      approvalReasons: [],
      priority: options.priority ?? 1,
      estimatedCostUsd: 0,
      estimatedLatencyMs: null,
      confidence: 0,
      warnings: [],
      rationale: [],
      blocked: null,
    };

    // A step that waits for the user needs no agent or provider.
    if (step.kind === 'input') {
      decision.rationale.push('Espera información del usuario; no interviene ningún agente ni modelo.');
      decision.requiresApproval = true;
      decision.approvalReasons.push('La misión necesita información que solo puede aportar el usuario.');
      decision.confidence = 1;
      return decision;
    }

    const agent = this.agents.get(step.agentId);
    if (agent === undefined || agent.status !== 'active') {
      decision.blocked = {
        kind: 'agent_planned',
        reason:
          agent === undefined
            ? `El agente «${step.agentId}» no está registrado.`
            : `El agente «${agent.name}» está en estado ${agent.status}: ${agent.statusDetail}`,
      };
      decision.rationale.push(decision.blocked.reason);
      return decision;
    }

    // ---- tools -----------------------------------------------------------
    let toolBlock: string | null = null;
    for (const request of step.toolRequests) {
      const spec = this.tools.get(request.toolId);
      if (spec === undefined) {
        decision.tools.push({ toolId: request.toolId, status: 'PLANNED', usable: false, note: 'Herramienta desconocida.' });
        if (request.required) toolBlock = `La herramienta obligatoria «${request.toolId}» no existe.`;
        continue;
      }
      const permission = this.permissions.evaluate({
        level: request.permission,
        subject: spec.id,
        description: request.purpose,
        internal: spec.locality === 'local',
      });
      let usable = this.tools.isUsable(spec.id);
      let note: string | null = usable ? null : `${spec.status}: ${spec.statusDetail}`;

      if (usable && permission.mode === 'BLOCK') {
        usable = false;
        note = `Bloqueada por permisos: ${permission.reason}`;
      } else if (usable && permission.mode === 'ASK') {
        decision.requiresApproval = true;
        decision.approvalReasons.push(`${spec.name}: ${permission.reason}`);
      }
      if (spec.locality !== 'local' && usable) decision.needsExternalService = true;

      decision.tools.push({ toolId: spec.id, status: spec.status, usable, note });
      if (!usable) {
        if (request.required) toolBlock = `La herramienta obligatoria «${spec.name}» (${spec.id}) no se puede usar. ${note ?? ''}`.trim();
        else decision.warnings.push(`${spec.name} (${spec.id}) no está disponible, así que este paso se ejecuta sin ella. ${note ?? ''}`.trim());
      }
    }
    if (toolBlock !== null) {
      decision.blocked = { kind: 'tool_missing', reason: toolBlock };
      decision.rationale.push(toolBlock);
      return decision;
    }

    // ---- provider --------------------------------------------------------
    // Everything discarded along the way is recorded, so the decision can say
    // not only what it chose but what it turned down and why.
    const discards = ex.discards;
    const avoid = new Set(options.avoidProviders ?? []);
    const openCircuits: CircuitState[] = [];

    const profiles = this.providers.profiles();
    const reachable = profiles.filter((provider) => {
      // Specialised services (image, video, voice, search) are tools, not models.
      if (provider.tier === 'specialized') return false;
      if (!provider.executable) {
        ex.excluded.push(whyNotExecutable(provider));
        return false;
      }
      if (avoid.has(provider.id)) {
        ex.excluded.push({ providerId: provider.id, model: null, code: 'avoided', errorCode: null, reason: 'ya ha fallado en este paso' });
        return false;
      }
      if (this.circuit.isOpen(provider.id)) {
        const state = this.circuit.state(provider.id);
        if (state !== null) openCircuits.push(state);
        ex.excluded.push({
          providerId: provider.id,
          model: null,
          code: 'circuit_open',
          errorCode: 'PROVIDER_CIRCUIT_OPEN',
          reason: `fuera de rotación tras ${state?.consecutiveFailures ?? 0} fallos seguidos hasta ${formatInstant(state?.openedUntil ?? null)}`,
        });
        return false;
      }
      return true;
    });
    for (const state of openCircuits) {
      const label = this.providers.get(state.providerId)?.label ?? state.providerId;
      decision.warnings.push(
        `${label} está fuera de rotación tras ${state.consecutiveFailures} fallos seguidos; vuelve a estar disponible a partir de ${formatInstant(state.openedUntil)}.`,
      );
    }

    let candidatesOf = reachable;
    if (options.pin !== undefined) {
      const pin = options.pin;
      candidatesOf = reachable.filter((provider) => provider.id === pin.providerId);
      for (const other of reachable.filter((provider) => provider.id !== pin.providerId)) {
        ex.excluded.push({ providerId: other.id, model: null, code: 'not_pinned', errorCode: null, reason: `la misión se inició con «${pin.providerId}»` });
      }
      if (candidatesOf.length === 0) {
        const known = this.providers.get(pin.providerId);
        const why =
          known === undefined
            ? 'no está registrado'
            : openCircuits.some((s) => s.providerId === pin.providerId)
              ? 'está fuera de rotación por fallos repetidos'
              : avoid.has(pin.providerId)
                ? 'ya ha fallado en este paso'
                : `no se puede usar (${known.status}: ${known.statusDetail})`;
        const pinnedCode = ex.excluded.find((e) => e.providerId === pin.providerId)?.errorCode ?? undefined;
        decision.blocked = {
          kind: 'provider_missing',
          reason: `El proveedor «${pin.providerId}» con el que se inició esta misión ${why}. No se ha enviado el paso a ningún otro.`,
          ...(pinnedCode !== undefined ? { code: pinnedCode } : {}),
        };
        decision.rationale.push(decision.blocked.reason);
        return decision;
      }
    }

    // A pinned model is honoured when the provider offers it; otherwise the
    // provider's own models are all in play (the adapter maps an unknown model
    // to its default, exactly as the classic pipeline did).
    const pinnedModel = options.pin?.model ?? null;
    const all: Candidate[] = candidatesOf.flatMap((provider) => {
      const exact = pinnedModel !== null && options.pin?.providerId === provider.id ? provider.models.filter((m) => m.id === pinnedModel) : [];
      return (exact.length > 0 ? exact : provider.models).map((model) => ({ provider, model }));
    });

    if (all.length === 0) {
      const noneCode: ProviderErrorCode | undefined =
        openCircuits.length > 0 ? 'PROVIDER_CIRCUIT_OPEN' : ex.excluded.some((e) => e.code === 'unconfigured') ? 'PROVIDER_UNCONFIGURED' : undefined;
      decision.blocked = {
        kind: 'provider_missing',
        ...(noneCode !== undefined ? { code: noneCode } : {}),
        reason:
          openCircuits.length > 0
            ? `No queda ningún proveedor en rotación: ${openCircuits.map((s) => s.providerId).join(', ')} están fuera tras fallar repetidamente.`
            : avoid.size > 0
              ? 'Todos los proveedores ejecutables ya han fallado en este paso.'
              : 'Ningún proveedor puede ejecutar tareas: no hay ninguno conectado.',
      };
      decision.rationale.push(decision.blocked.reason);
      return decision;
    }

    // The simulation stands in only when NO real provider is in play at all — none
    // configured. A real provider that IS configured but cannot take this step
    // right now (its circuit is open, it already failed here, its key was
    // rejected) is a failure to report, not a reason to answer with a simulation.
    const realInPlay = profiles.filter((p) => p.tier !== 'mock' && p.tier !== 'specialized' && p.implemented && p.configured && p.enabled);
    if (options.pin === undefined && realInPlay.length > 0 && !all.some((c) => c.provider.tier !== 'mock')) {
      const why = realInPlay
        .map((p) => {
          const excluded = ex.excluded.find((e) => e.providerId === p.id);
          return `${p.label}: ${excluded?.reason ?? p.statusDetail}`;
        })
        .join('; ');
      for (const c of all) discards.push({ candidate: c, reason: 'la simulación no sustituye a un proveedor real configurado que ha fallado', code: 'mock_last_resort' });
      decision.blocked = {
        kind: 'provider_missing',
        ...(openCircuits.length > 0 ? { code: 'PROVIDER_CIRCUIT_OPEN' as const } : {}),
        reason: `Ningún proveedor real configurado puede ejecutar este paso ahora (${why}). No se sustituye por la simulación.`,
      };
      decision.rationale.push(decision.blocked.reason);
      return decision;
    }

    const needQuality: 3 | 4 = step.task.difficulty >= 4 ? 4 : 3;
    const real = all.filter((c) => c.provider.tier !== 'mock');
    let pool = real.length > 0 ? real : all;
    const usingMock = real.length === 0;
    if (usingMock) decision.warnings.push('Solo está disponible el proveedor simulado: este resultado es una simulación, no un análisis.');
    else for (const c of all.filter((c) => c.provider.tier === 'mock')) discards.push({ candidate: c, reason: 'el proveedor simulado solo se usa cuando no hay ninguno real', code: 'mock_last_resort' });

    // ---- hard requirement: privacy ---------------------------------------
    const localOnly = options.localOnly === true || policy.localOnly;
    if (localOnly || step.task.sensitive) {
      const onDevice = pool.filter((c) => c.provider.privacy !== 'third_party');
      const sentOut = pool.filter((c) => c.provider.privacy === 'third_party');
      const why = step.task.sensitive ? 'el paso trata información sensible' : 'la política de enrutado está en modo solo local';
      if (onDevice.length === 0) {
        decision.blocked = {
          kind: 'privacy',
          reason: step.task.sensitive
            ? 'Este paso maneja información sensible y no hay ningún proveedor en el propio dispositivo. No se ha enviado nada a ninguna parte.'
            : 'La política de enrutado solo permite proveedores en el propio dispositivo y no hay ninguno disponible. No se ha enviado nada a ninguna parte.',
        };
        decision.rationale.push(decision.blocked.reason);
        return decision;
      }
      if (sentOut.length > 0) {
        for (const c of sentOut) discards.push({ candidate: c, reason: `es un proveedor externo y ${why}`, code: 'privacy' });
        decision.rationale.push(
          step.task.sensitive
            ? 'Información sensible: se han descartado los proveedores externos.'
            : 'Modo solo local: se han descartado los proveedores externos.',
        );
      }
      pool = onDevice;
    }

    // ---- hard requirement: declared model capabilities --------------------
    const required = [...new Set(options.requireCapabilities ?? [])];
    if (required.length > 0) {
      const capable = pool.filter((c) => required.every((name) => hasCapability(c.model, name)));
      for (const c of pool.filter((candidate) => !capable.includes(candidate))) {
        const missing = required.filter((name) => !hasCapability(c.model, name));
        discards.push({ candidate: c, reason: `no declara ${missing.map(labelCapability).join(' ni ')}`, code: 'capability_mismatch' });
      }
      if (capable.length === 0) {
        decision.blocked = {
          kind: 'provider_missing',
          code: 'PROVIDER_CAPABILITY_MISMATCH',
          reason: `Este paso necesita ${required.map(labelCapability).join(' y ')}, y ningún modelo disponible declara esa capacidad. No se enruta a un modelo que no puede hacer el trabajo.`,
        };
        decision.rationale.push(decision.blocked.reason);
        decision.rationale.push(...explainDiscards(discards));
        return decision;
      }
      decision.rationale.push(`Este paso exige ${required.map(labelCapability).join(' y ')}: solo siguen en juego los modelos que lo declaran.`);
      pool = capable;
    }

    // ---- preference: quality floor ---------------------------------------
    // Not a hard requirement: when nothing reaches the floor MADRE still runs
    // the step, but it says loudly that the result is under-powered.
    const meetsQuality = pool.filter((c) => c.model.quality >= needQuality);
    let eligible = meetsQuality.length > 0 ? meetsQuality : pool;
    if (meetsQuality.length === 0) {
      decision.warnings.push(
        `El mejor modelo disponible está valorado en ${Math.max(...pool.map((c) => c.model.quality))}/5 y este paso pide ${needQuality}/5. Toma el resultado con más cautela.`,
      );
    } else {
      for (const c of pool.filter((candidate) => !meetsQuality.includes(candidate))) {
        discards.push({ candidate: c, reason: `su calidad ${c.model.quality}/5 no llega al mínimo ${needQuality}/5 de este paso`, code: 'quality' });
      }
    }

    // Live information: prefer a model that has it, otherwise say so.
    let freshnessMet = true;
    if (step.task.needsFreshInformation) {
      const webTool = decision.tools.some((t) => t.toolId === 'web.search' && t.usable);
      const live = eligible.filter((c) => c.model.liveInformation);
      if (live.length > 0) {
        for (const c of eligible.filter((candidate) => !live.includes(candidate))) {
          discards.push({ candidate: c, reason: 'no puede consultar información actual y este paso la necesita', code: 'freshness' });
        }
        eligible = live;
      } else if (!webTool) {
        freshnessMet = false;
        decision.warnings.push('Este paso necesita información actual y no hay ninguna disponible: usará solo el conocimiento del modelo y debe advertirlo.');
      }
    }

    // ---- ordering: the ladder first, the weights only to break ties -------
    const context = scoreContext(pool);
    const scores = new Map<Candidate, ScoreBreakdown>();
    const scoreOf = (candidate: Candidate): ScoreBreakdown => {
      const cached = scores.get(candidate);
      if (cached !== undefined) return cached;
      const computed = scoreCandidate(candidate, policy, context);
      scores.set(candidate, computed);
      return computed;
    };
    // A provider whose latest health probe failed a moment ago is not excluded
    // (the probe may have been a blip, and the circuit breaker is what watches
    // real calls) but it goes to the back of its own queue: anything healthy is
    // tried first, and it is only chosen when nothing else can take the step.
    const now = this.clock.now().getTime();
    const demoted = (c: Candidate): boolean =>
      c.provider.health.status === 'down' &&
      c.provider.health.checkedAt !== null &&
      now - Date.parse(c.provider.health.checkedAt) < FRESH_HEALTH_MS;
    const compare = (a: Candidate, b: Candidate): number =>
      Number(demoted(a)) - Number(demoted(b)) ||
      tierRank(policy, a.model.tier) - tierRank(policy, b.model.tier) ||
      scoreOf(b).total - scoreOf(a).total ||
      b.model.quality - a.model.quality ||
      agentPreference(agent.preferredTiers, a.provider.tier) - agentPreference(agent.preferredTiers, b.provider.tier) ||
      a.provider.id.localeCompare(b.provider.id) ||
      a.model.id.localeCompare(b.model.id);
    const sorted = [...eligible].sort(compare);
    // Load balancing: providers that tie exactly are alternated from step to
    // step (stable for a given step), so one free quota is not drained alone.
    let balancedAmong = 0;
    const ranked = ((): Candidate[] => {
      if (!this.balanceTies || sorted.length < 2) return sorted;
      const first = sorted[0]!;
      const tied = (c: Candidate): boolean =>
        demoted(c) === demoted(first) &&
        tierRank(policy, c.model.tier) === tierRank(policy, first.model.tier) &&
        scoreOf(c).total === scoreOf(first).total &&
        c.model.quality === first.model.quality;
      const leaders: Candidate[] = [];
      for (const c of sorted) {
        if (!tied(c)) break;
        if (!leaders.some((l) => l.provider.id === c.provider.id)) leaders.push(c);
      }
      if (leaders.length < 2) return sorted;
      balancedAmong = leaders.length;
      const pick = leaders[stableHash(step.id) % leaders.length]!;
      return [pick, ...sorted.filter((c) => c !== pick)];
    })();
    // Weaker or less suitable candidates still make sense as fallbacks, after the eligible ones.
    const others = pool.filter((c) => !eligible.includes(c)).sort(compare);
    ex.ranked = ranked;
    ex.others = others;
    ex.score = scoreOf;

    // Budget: walk down the ranking until something is affordable.
    let chosen: Candidate | null = null;
    let chosenCost: number | null = 0;
    const budgetNotes: string[] = [];
    let unpricedRefusals = 0;
    const fallbackLocal = this.cost.getBudget().onExceed === 'fallback_local';
    const walk = fallbackLocal ? [...ranked, ...others.filter((c) => c.provider.privacy !== 'third_party')] : ranked;
    for (const candidate of walk) {
      const estimated = this.cost.estimate(
        candidate.provider.id,
        candidate.model.id,
        ESTIMATED_PROMPT_TOKENS,
        ESTIMATED_COMPLETION_TOKENS,
      );
      const check = await this.cost.check({
        missionId: options.missionId ?? step.id,
        agentId: step.agentId,
        providerId: candidate.provider.id,
        estimatedUsd: estimated,
      });
      if (check.allowed) {
        chosen = candidate;
        chosenCost = estimated;
        break;
      }
      budgetNotes.push(`${candidate.provider.label} descartado: ${check.reason ?? 'fuera de presupuesto'}`);
      // An unknown price is reported as such: "we could not check" is not "too expensive".
      const unpriced = estimated === null;
      if (unpriced) unpricedRefusals += 1;
      discards.push({ candidate, reason: check.reason ?? 'no cabe en el presupuesto', code: unpriced ? 'cost_unknown' : 'budget' });
      if (check.action === 'ask') {
        chosen = candidate;
        chosenCost = estimated;
        decision.requiresApproval = true;
        decision.approvalReasons.push(check.reason ?? 'La llamada podría superar el presupuesto.');
        break;
      }
    }
    if (chosen === null) {
      decision.blocked = {
        kind: 'budget',
        // Every candidate refused for want of a price: that is the structured reason.
        ...(unpricedRefusals > 0 && unpricedRefusals === budgetNotes.length ? { code: 'PROVIDER_COST_UNKNOWN' as const } : {}),
        reason: `Ningún proveedor cabe en el presupuesto. ${budgetNotes.join(' ')}`.trim(),
      };
      decision.rationale.push(decision.blocked.reason);
      return decision;
    }
    decision.warnings.push(...budgetNotes);
    if (!eligible.includes(chosen) && meetsQuality.length > 0) {
      decision.warnings.push(`Se ha recurrido a ${chosen.provider.label} (${chosen.model.id}), valorado en ${chosen.model.quality}/5, y este paso pide ${needQuality}/5. Toma el resultado con más cautela.`);
    }

    const { provider, model } = chosen;
    decision.provider = { id: provider.id, model: model.id, tier: model.tier, status: provider.status };
    decision.execution = provider.tier === 'mock' ? 'simulated' : provider.privacy === 'on_device' ? 'local' : 'external';
    if (decision.execution === 'external') {
      decision.needsExternalService = true;
      const permission = this.permissions.evaluate({
        level: 'EXTERNAL_ACTION',
        subject: provider.id,
        description: `Enviar el contenido de este paso a ${provider.label}.`,
      });
      if (permission.mode === 'BLOCK') {
        decision.blocked = { kind: 'provider_missing', reason: permission.reason };
        decision.provider = null;
        decision.execution = 'none';
        return decision;
      }
      // Model calls are the job itself: they are audited, not approved one by one.
    }
    decision.estimatedCostUsd = chosenCost;
    decision.estimatedLatencyMs = model.typicalLatencyMs;
    if (demoted(chosen)) {
      decision.warnings.push(`La última comprobación de ${provider.label} falló hace poco y no había otra opción mejor: se intenta igualmente.`);
    }

    // The fallbacks are what the engine would actually reach for: one entry per
    // *other* provider, best model first. A provider that just failed is
    // avoided as a whole, so listing a sibling model of the primary would be a
    // fallback that never happens.
    const seenProviders = new Set([provider.id]);
    decision.fallbacks = [];
    for (const candidate of [...ranked, ...others]) {
      if (seenProviders.has(candidate.provider.id)) continue;
      if (decision.fallbacks.length >= policy.maxFallbacks) break;
      seenProviders.add(candidate.provider.id);
      decision.fallbacks.push({ providerId: candidate.provider.id, model: candidate.model.id });
    }

    // ---- explanation and confidence ---------------------------------------
    const score = scoreOf(chosen);
    decision.rationale.push(
      `Una dificultad de ${step.task.difficulty}/5 pide un modelo valorado en ${needQuality}/5 o mejor.`,
      `Escalera de la política: ${policy.tierOrder.map(labelTier).join(' → ')}; el simulado siempre es el último recurso.`,
      `Se ha elegido ${provider.label} (${model.id}, valorado en ${model.quality}/5, ${labelTier(model.tier)}) por ser el nivel más bajo de la escalera que cumple lo que pide el paso.`,
    );
    if (balancedAmong > 1) {
      decision.rationale.push(`Reparto de carga: ${balancedAmong} proveedores estaban igualados y se alterna entre ellos de un paso a otro.`);
    }
    const sameTier = ranked.filter((c) => tierRank(policy, c.model.tier) === tierRank(policy, chosen.model.tier));
    if (sameTier.length > 1) {
      decision.rationale.push(
        `Había ${sameTier.length} candidatos empatados en ese nivel: han desempatado los pesos de la política (puntuación ${formatScore(score.total)} — calidad ${formatScore(score.quality)}, coste ${formatScore(score.cost)}, latencia ${formatScore(score.latency)}, privacidad ${formatScore(score.privacy)}).`,
      );
    }
    if (model.tier === 'local' || model.tier === 'local_strong') decision.rationale.push('Primero lo local: ningún dato sale de la máquina y no hay coste por llamada.');
    if (provider.tier === 'external') {
      decision.rationale.push(
        meetsQuality.length > 0 && real.some((c) => c.provider.tier !== 'external')
          ? 'Ningún modelo local era lo bastante bueno ni capaz de hacer lo que pide este paso.'
          : 'No hay ningún proveedor local conectado.',
      );
    }
    if (decision.estimatedCostUsd === null) decision.rationale.push('Se desconoce el precio de esta llamada, así que no se estima su coste.');
    decision.rationale.push(...explainDiscards(discards.filter((d) => d.candidate !== chosen)));
    if (decision.fallbacks.length > 0) {
      decision.rationale.push(`Si falla, se recurriría a ${decision.fallbacks.map((f) => `${f.providerId} (${f.model})`).join(', ')}.`);
    }

    let confidence = 0.5;
    confidence += model.quality >= needQuality ? 0.25 : -0.15 * (needQuality - model.quality);
    if (step.task.needsFreshInformation) confidence += freshnessMet ? 0.1 : -0.15;
    confidence -= 0.05 * decision.tools.filter((t) => !t.usable).length;
    if (provider.tier === 'mock') confidence = Math.min(confidence, 0.3);
    decision.confidence = round(clamp(confidence, 0.05, 0.95), 2);

    return decision;
  }

  /** Route every step of a plan. Used for previews and by the engine at the start of a run. */
  async routePlan(plan: MissionPlan, options: Omit<RouteOptions, 'priority'> = {}): Promise<Map<string, RoutingDecision>> {
    const priorities = computePriorities(plan);
    const out = new Map<string, RoutingDecision>();
    for (const step of plan.steps) {
      out.set(step.id, await this.route(step, { ...options, priority: priorities.get(step.id) ?? 1 }));
    }
    return out;
  }
}

/**
 * A capability is only true when the adapter declares it true. A profile that
 * predates the capability contract counts as "does not declare it", never as
 * "probably supports it".
 */
function hasCapability(model: ModelProfile, name: ModelCapabilityName): boolean {
  return model.capabilities?.[name] === true;
}

/** One rationale line per discarded candidate, with the rest summarised. */
function explainDiscards(discards: readonly Discard[]): string[] {
  if (discards.length === 0) return [];
  const seen = new Set<string>();
  const lines: string[] = [];
  let extra = 0;
  for (const { candidate, reason } of discards) {
    const key = `${candidate.provider.id}:${candidate.model.id}:${reason}`;
    if (seen.has(key)) continue;
    seen.add(key);
    if (lines.length >= MAX_EXPLAINED_DISCARDS) {
      extra += 1;
      continue;
    }
    lines.push(`Se ha descartado ${candidate.provider.label} (${candidate.model.id}): ${reason}.`);
  }
  if (extra > 0) lines.push(`Se han descartado ${extra} candidatos más por los mismos motivos.`);
  return lines;
}

function formatInstant(iso: string | null): string {
  return iso === null ? 'que se revise la configuración' : iso;
}

function agentPreference(preferred: readonly ProviderTier[], tier: ProviderTier): number {
  const index = preferred.indexOf(tier);
  return index === -1 ? preferred.length : index;
}

/**
 * Priority 1 goes to the steps with the most work still queued behind them
 * (the critical path). Independent leaf steps get the highest numbers.
 */
export function computePriorities(plan: MissionPlan): Map<string, number> {
  const children = new Map<string, string[]>();
  for (const step of plan.steps) {
    for (const dep of step.dependsOn) {
      const list = children.get(dep.stepId) ?? [];
      list.push(step.id);
      children.set(dep.stepId, list);
    }
  }
  const memo = new Map<string, number>();
  const remaining = (id: string): number => {
    const cached = memo.get(id);
    if (cached !== undefined) return cached;
    memo.set(id, 0); // guards against cycles
    const next = (children.get(id) ?? []).map(remaining);
    const value = 1 + (next.length > 0 ? Math.max(...next) : 0);
    memo.set(id, value);
    return value;
  };
  const max = Math.max(1, ...plan.steps.map((s) => remaining(s.id)));
  return new Map(plan.steps.map((s) => [s.id, max - remaining(s.id) + 1]));
}

/** A small, stable string hash (FNV-1a), so the same step always lands on the same provider. */
function stableHash(text: string): number {
  let h = 2166136261;
  for (let i = 0; i < text.length; i += 1) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}
