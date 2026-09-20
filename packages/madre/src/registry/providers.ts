/**
 * Provider catalog.
 *
 * The domain `ProviderRegistry` answers "what can execute a task". The router
 * needs more: how good, how private, how costly, how far away. This catalog
 * derives that view from the registered adapters and never claims a provider
 * is connected unless its adapter says it is available.
 *
 * Prices are `null` (unknown) unless the operator configures them. Quality is
 * a coarse editorial rating, not a benchmark, and is documented as such.
 */

import type { ProviderDescriptor, ProviderModel } from '@acc/domain';

import type {
  CircuitState,
  ModelCapabilities,
  ModelLimits,
  ModelProfile,
  ProviderHealth,
  ProviderProfile,
  ProviderStatus,
  ProviderTier,
} from '../types.ts';

interface ProviderMeta {
  label: string;
  tier: ProviderTier;
  privacy: ProviderProfile['privacy'];
  requires: string | null;
  /** Status when the adapter is available. */
  whenAvailable: ProviderStatus;
  notConnected: string;
  connected: string;
}

const META: Record<string, ProviderMeta> = {
  mock: {
    label: 'Proveedor simulado',
    tier: 'mock',
    privacy: 'simulated',
    requires: null,
    whenAvailable: 'MOCK',
    notConnected: 'No disponible.',
    connected: 'Simulación determinista para desarrollo y pruebas. No razona y nunca pretende hacerlo.',
  },
  ollama: {
    label: 'Ollama (modelos locales)',
    tier: 'local',
    privacy: 'on_device',
    requires: 'OLLAMA_BASE_URL apuntando a un servidor Ollama en ejecución',
    whenAvailable: 'LOCAL',
    notConnected: 'OLLAMA_BASE_URL no está definida, así que no hay ningún servidor de modelos locales configurado.',
    connected: 'Se comunica con el servidor Ollama configurado. Nada sale de la máquina.',
  },
  openai: {
    label: 'OpenAI',
    tier: 'external',
    privacy: 'third_party',
    requires: 'OPENAI_API_KEY y OPENAI_MODEL',
    whenAvailable: 'CONNECTED',
    notConnected: 'Sin configurar: faltan OPENAI_API_KEY y OPENAI_MODEL. No se sustituye por una simulación.',
    connected: 'Configurado. Las llamadas salen del servidor; la clave nunca llega al navegador.',
  },
  anthropic: {
    label: 'Anthropic',
    tier: 'external',
    privacy: 'third_party',
    requires: 'ANTHROPIC_API_KEY y ANTHROPIC_MODEL',
    whenAvailable: 'CONNECTED',
    notConnected: 'Sin configurar: faltan ANTHROPIC_API_KEY y ANTHROPIC_MODEL. No se sustituye por una simulación.',
    connected: 'Configurado. Las llamadas salen del servidor; la clave nunca llega al navegador.',
  },
  gemini: {
    label: 'Google Gemini',
    tier: 'external',
    privacy: 'third_party',
    requires: 'GOOGLE_API_KEY (o GEMINI_API_KEY) y GEMINI_MODEL',
    whenAvailable: 'CONNECTED',
    notConnected: 'Sin configurar: faltan GOOGLE_API_KEY (o GEMINI_API_KEY) y GEMINI_MODEL. No se sustituye por una simulación.',
    connected: 'Configurado. Las llamadas salen del servidor; la clave nunca llega al navegador.',
  },
  'openai-compatible': {
    label: 'Endpoint compatible con OpenAI',
    tier: 'external',
    privacy: 'third_party',
    requires: 'OPENAI_COMPAT_BASE_URL y clave',
    whenAvailable: 'CONNECTED',
    notConnected: 'Adaptador declarado, sin implementar. No se usan credenciales.',
    connected: 'Conectado.',
  },
};

// ---------------------------------------------------------------------------
// Declared capabilities
// ---------------------------------------------------------------------------

/**
 * What a model can do beyond producing text.
 *
 * These are *declarations*, not probes: for an unconnected provider they say
 * what the vendor documents, and MADRE cannot confirm any of it until the
 * adapter is really implemented. The router treats a missing capability as a
 * hard "no", so every field is stated rather than left out.
 */
const NO_CAPABILITIES: ModelCapabilities = {
  streaming: false,
  toolCalling: false,
  structuredOutput: false,
  embeddings: false,
  vision: false,
};

const NO_LIMITS: ModelLimits = { maxOutputTokens: null, requestsPerMinute: null, tokensPerMinute: null };

/** Never checked, nothing to check, or checked — three different things. */
export const UNKNOWN_HEALTH: ProviderHealth = {
  status: 'unknown',
  checkedAt: null,
  latencyMs: null,
  detail: 'Todavía no se ha comprobado.',
};

export const NOT_CONNECTED_HEALTH: ProviderHealth = {
  status: 'not_connected',
  checkedAt: null,
  latencyMs: null,
  detail: 'No hay nada que comprobar: el proveedor no está configurado.',
};

/**
 * Capabilities per provider, as documented by each vendor.
 *
 * `mock` is the honest case: it produces text and nothing else, because it is a
 * local simulation. Ollama's true capabilities depend on the model pulled, so
 * the conservative floor is declared and anything beyond it has to be proven by
 * a real adapter rather than assumed here.
 */
const CAPABILITIES: Record<string, ModelCapabilities> = {
  mock: { ...NO_CAPABILITIES, streaming: false, structuredOutput: false },
  ollama: { ...NO_CAPABILITIES, streaming: true, embeddings: true },
  openai: { streaming: true, toolCalling: true, structuredOutput: true, embeddings: true, vision: true },
  anthropic: { streaming: true, toolCalling: true, structuredOutput: true, embeddings: false, vision: true },
  gemini: { streaming: true, toolCalling: true, structuredOutput: true, embeddings: true, vision: true },
  'openai-compatible': { streaming: true, toolCalling: true, structuredOutput: true, embeddings: true, vision: false },
};

function capabilitiesFor(providerId: string): ModelCapabilities {
  return { ...(CAPABILITIES[providerId] ?? NO_CAPABILITIES) };
}

/** Specialised services MADRE knows it will want. None is connected. */
const SPECIALIZED: ProviderProfile[] = [
  ['specialized-image', 'Servicio de generación de imágenes', 'Una clave de API de imágenes'],
  ['specialized-video', 'Servicio de generación de vídeo', 'Una clave de API de vídeo'],
  ['specialized-voice', 'Servicio de generación de voz', 'Una clave de API de voz'],
  ['specialized-search', 'Servicio de búsqueda web', 'Una clave de API de búsqueda'],
].map(([id, label, requires]) => ({
  id: id as string,
  label: label as string,
  status: 'NOT_CONNECTED' as const,
  statusDetail: 'No se ha elegido ni configurado ningún servicio.',
  tier: 'specialized' as const,
  privacy: 'third_party' as const,
  models: [],
  requires: requires as string,
  executable: false,
  implemented: false,
  configured: false,
  available: false,
  enabled: true,
  healthy: null,
  source: 'real' as const,
  health: NOT_CONNECTED_HEALTH,
}));


/** Editorial rating from a local model's name: parameter count is a rough proxy for capability. */
export function profileLocalModel(id: string, label = id): ModelProfile {
  const match = /(\d+(?:\.\d+)?)\s*b\b/i.exec(id);
  const billions = match?.[1] !== undefined ? Number(match[1]) : null;
  const strong = billions !== null && billions >= 30;
  const mid = billions !== null && billions >= 7;
  return {
    id,
    label,
    tier: strong ? 'local_strong' : 'local',
    quality: strong ? 4 : mid ? 3 : 2,
    contextWindow: null,
    pricePer1kInputUsd: 0,
    pricePer1kOutputUsd: 0,
    typicalLatencyMs: null,
    liveInformation: false,
    capabilities: capabilitiesFor('ollama'),
    // A local server has no vendor rate limit; the ceiling is the machine.
    limits: { ...NO_LIMITS },
  };
}

function profileModel(providerId: string, tier: ProviderTier, model: ProviderModel): ModelProfile {
  const { id, label, contextWindow } = model;
  if (providerId === 'ollama') return { ...profileLocalModel(id, label), contextWindow: contextWindow ?? null };
  if (providerId === 'mock') {
    return {
      id,
      label,
      tier: 'mock',
      quality: 1,
      contextWindow: contextWindow ?? null,
      pricePer1kInputUsd: 0,
      pricePer1kOutputUsd: 0,
      typicalLatencyMs: null,
      liveInformation: false,
      capabilities: capabilitiesFor('mock'),
      limits: { ...NO_LIMITS },
    };
  }
  return {
    id,
    label,
    tier,
    quality: 4,
    contextWindow: contextWindow ?? null,
    pricePer1kInputUsd: null,
    pricePer1kOutputUsd: null,
    typicalLatencyMs: null,
    liveInformation: false,
    // What the adapter says it implements wins over the vendor's documented list:
    // a model that can call tools is no use here until the adapter wires it.
    capabilities: model.capabilities !== undefined ? { ...model.capabilities } : capabilitiesFor(providerId),
    // Rate limits are per account, so they cannot be known from here.
    limits: { ...NO_LIMITS },
  };
}

export type ProviderSource = () => readonly ProviderDescriptor[];

export class ProviderCatalog {
  private readonly errors = new Map<string, string>();
  private readonly health = new Map<string, ProviderHealth>();
  private readonly disabled = new Map<string, string>();
  private circuit: (providerId: string) => CircuitState | null = () => null;

  constructor(private readonly source: ProviderSource) {}

  /**
   * Show the router's circuit breaker on the profiles. The breaker is what
   * takes a provider out of rotation and brings it back; the catalog only
   * reports it, so there is one mechanism and one place to read its verdict.
   */
  attachCircuit(lookup: (providerId: string) => CircuitState | null): void {
    this.circuit = lookup;
  }

  /** Switch a provider off (an operator decision): it is never routed to, and says why. */
  disable(providerId: string, reason: string): void {
    this.disabled.set(providerId, reason);
  }

  enable(providerId: string): void {
    this.disabled.delete(providerId);
  }

  /**
   * Take a provider out of service until the operator fixes it. Used when a call
   * fails in a way that will keep failing (a rejected key, an exhausted quota):
   * waiting would not help, so the circuit breaker's cooldown is the wrong tool.
   * Cleared by `clearError`, or by restarting after fixing the configuration.
   */
  markError(providerId: string, detail: string): void {
    this.errors.set(providerId, detail);
  }

  clearError(providerId: string): void {
    this.errors.delete(providerId);
  }

  /** Record the outcome of a real reachability check. Nothing else may set this. */
  recordHealth(providerId: string, health: ProviderHealth): void {
    this.health.set(providerId, health);
  }

  healthOf(providerId: string): ProviderHealth {
    return this.health.get(providerId) ?? UNKNOWN_HEALTH;
  }

  profiles(): ProviderProfile[] {
    const out: ProviderProfile[] = [];
    for (const descriptor of this.source()) {
      const meta = META[descriptor.id];
      const available = descriptor.availability === 'available';
      const implemented = descriptor.implemented ?? true;
      const configured = descriptor.configured ?? available;
      const tier = meta?.tier ?? 'external';
      const error = this.errors.get(descriptor.id);
      const disabledReason = this.disabled.get(descriptor.id);
      const enabled = disabledReason === undefined;
      const circuit = available ? this.circuit(descriptor.id) : null;

      let status: ProviderStatus;
      let statusDetail: string;
      if (!enabled) {
        status = 'DISABLED';
        statusDetail = `Desactivado por el operador: ${disabledReason}`;
      } else if (!available) {
        // Implemented but without credentials is a different thing from a stub.
        status = implemented && !configured && descriptor.availability === 'unconfigured' ? 'UNCONFIGURED' : 'NOT_CONNECTED';
        statusDetail = descriptor.note ?? meta?.notConnected ?? 'Sin implementar.';
      } else if (error !== undefined) {
        status = 'ERROR';
        statusDetail = error;
      } else if (circuit?.open === true) {
        status = 'ERROR';
        statusDetail = `Fuera de rotación tras ${circuit.consecutiveFailures} ${circuit.consecutiveFailures === 1 ? 'fallo seguido' : 'fallos seguidos'}; se vuelve a probar a partir de ${circuit.openedUntil ?? 'que se revise la configuración'}.`;
      } else {
        status = meta?.whenAvailable ?? 'CONNECTED';
        statusDetail = descriptor.note ?? meta?.connected ?? 'Disponible.';
      }

      const health = this.health.get(descriptor.id) ?? (available ? UNKNOWN_HEALTH : NOT_CONNECTED_HEALTH);
      const executable = available && enabled && error === undefined;
      out.push({
        id: descriptor.id,
        label: meta?.label ?? descriptor.label,
        status,
        statusDetail,
        tier,
        privacy: meta?.privacy ?? 'third_party',
        models: available
          ? descriptor.models.map((m) => profileModel(descriptor.id, tier, m))
          : [],
        requires: meta?.requires ?? null,
        executable,
        implemented,
        configured,
        available,
        enabled,
        // Only a probe that answered makes a provider healthy.
        healthy: !available ? null : health.status === 'ok' ? true : health.status === 'unknown' || health.status === 'not_connected' ? null : false,
        source: tier === 'mock' ? 'mock' : 'real',
        health,
        circuit,
      });
    }
    // Declared-but-unregistered providers still appear, so the roadmap is visible.
    const seen = new Set(out.map((p) => p.id));
    for (const [id, meta] of Object.entries(META)) {
      if (seen.has(id)) continue;
      out.push({
        id,
        label: meta.label,
        status: 'NOT_CONNECTED',
        statusDetail: meta.notConnected,
        tier: meta.tier,
        privacy: meta.privacy,
        models: [],
        requires: meta.requires,
        executable: false,
        implemented: false,
        configured: false,
        available: false,
        enabled: true,
        healthy: null,
        source: meta.tier === 'mock' ? 'mock' : 'real',
        health: NOT_CONNECTED_HEALTH,
      });
    }
    return [...out, ...SPECIALIZED.map((p) => ({ ...p }))];
  }

  get(id: string): ProviderProfile | undefined {
    return this.profiles().find((p) => p.id === id);
  }

  executable(): ProviderProfile[] {
    return this.profiles().filter((p) => p.executable);
  }
}
