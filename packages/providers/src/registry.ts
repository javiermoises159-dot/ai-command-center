/**
 * Provider registry — the lookup the orchestrator uses instead of importing a
 * vendor SDK. Adding a provider means registering an adapter here; no call site
 * changes.
 */

import {
  DomainError,
  ProviderError,
  describeProvider,
  type AIProvider,
  type ProviderDescriptor,
  type ProviderHealthReport,
  type ProviderId,
} from '@acc/domain';

export class ProviderRegistry {
  private readonly providers = new Map<ProviderId, AIProvider>();
  private readonly notes = new Map<ProviderId, string>();
  private defaultId: ProviderId | null = null;

  register(provider: AIProvider, options: { note?: string; makeDefault?: boolean } = {}): this {
    this.providers.set(provider.id, provider);
    if (options.note !== undefined) this.notes.set(provider.id, options.note);
    if (options.makeDefault === true || this.defaultId === null) {
      if (provider.availability === 'available') this.defaultId = provider.id;
    }
    return this;
  }

  has(id: string): boolean {
    return this.providers.has(id as ProviderId);
  }

  /** Throws a typed domain error rather than returning undefined. */
  get(id: string): AIProvider {
    const provider = this.providers.get(id as ProviderId);
    if (!provider) {
      throw new DomainError('provider_not_configured', `Unknown provider "${id}".`, {
        status: 400,
        publicMessage: `Proveedor desconocido «${id}». Disponibles: ${this.availableIds().join(', ')}.`,
      });
    }
    return provider;
  }

  getDefault(): AIProvider {
    if (this.defaultId === null) {
      throw new DomainError('provider_not_configured', 'No available provider is registered.', {
        status: 503,
        publicMessage: 'No hay ningún proveedor de IA disponible en este servidor.',
      });
    }
    return this.get(this.defaultId);
  }

  defaultProviderId(): ProviderId | null {
    return this.defaultId;
  }

  availableIds(): ProviderId[] {
    return [...this.providers.values()].filter((p) => p.availability === 'available').map((p) => p.id);
  }

  /** Everything registered, including planned adapters, for the API. */
  describe(): ProviderDescriptor[] {
    return [...this.providers.values()].map((p) => describeProvider(p, this.notes.get(p.id)));
  }

  /**
   * Ask an adapter whether it is reachable right now, without running a task.
   * Returns null for an adapter that offers no probe (it is then reported as
   * unknown, never as healthy).
   */
  probe(id: string, signal?: AbortSignal): Promise<ProviderHealthReport | null> {
    const provider = this.providers.get(id as ProviderId);
    if (provider?.health === undefined) return Promise.resolve(null);
    return provider.health(signal);
  }

  /**
   * Resolve a requested provider/model pair, falling back to the default and to
   * the provider's first model. Throws if the requested model is not offered,
   * rather than silently substituting one.
   */
  resolve(providerId?: string, model?: string): { provider: AIProvider; model: string } {
    const provider = providerId !== undefined ? this.get(providerId) : this.getDefault();

    if (provider.availability === 'unconfigured') {
      // Implemented, but without its credentials or model. Say exactly what is
      // missing; never hand back a stand-in.
      throw new ProviderError('PROVIDER_UNCONFIGURED', {
        provider: provider.id,
        detail: provider.configuration?.().reason ?? `«${provider.label}» no está configurado.`,
      });
    }
    if (provider.availability !== 'available') {
      throw new DomainError('provider_not_configured', `Provider "${provider.id}" is not implemented yet.`, {
        status: 503,
        publicMessage: `«${provider.label}» está declarado pero aún no está implementado en esta versión. Usa uno de estos: ${this.availableIds().join(', ')}.`,
      });
    }

    const models = provider.listModels();
    const fallback = models[0];
    if (!fallback) {
      throw new DomainError('provider_not_configured', `Provider "${provider.id}" exposes no models.`, {
        status: 503,
        publicMessage: `El proveedor «${provider.label}» no ofrece ningún modelo.`,
      });
    }

    if (model === undefined) return { provider, model: fallback.id };

    if (!models.some((m) => m.id === model)) {
      throw new DomainError('provider_not_configured', `Model "${model}" is not offered by "${provider.id}".`, {
        status: 400,
        publicMessage: `El modelo «${model}» no está disponible. Opciones: ${models.map((m) => m.id).join(', ')}.`,
      });
    }

    return { provider, model };
  }
}
