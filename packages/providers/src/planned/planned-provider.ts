/**
 * Base for provider adapters that are declared but NOT implemented.
 *
 * These are real registry entries so the API and UI can honestly show what is
 * coming, but `execute` always throws. Nothing here silently degrades to the
 * mock — a planned provider that gets executed fails loudly and says exactly
 * what is missing.
 *
 * To make one real: write an adapter on `RealProvider` (see `real/`) and
 * register it in place of the stub. OpenAI, Anthropic and Gemini were promoted
 * that way; nothing else in the system changed.
 */

import {
  ProviderNotConfiguredError,
  type AIProvider,
  type ProviderHealthReport,
  type ProviderId,
  type ProviderModel,
  type ProviderResult,
  type ProviderTask,
} from '@acc/domain';

export abstract class PlannedProvider implements AIProvider {
  abstract readonly id: ProviderId;
  abstract readonly label: string;
  /** Which env vars and SDK the real implementation will need. */
  abstract readonly requirement: string;

  readonly availability = 'planned' as const;
  readonly implemented = false;

  protected abstract models(): readonly ProviderModel[];

  listModels(): readonly ProviderModel[] {
    return this.models();
  }

  /**
   * Nothing to probe: there is no endpoint and no credential behind a declared
   * adapter, so this is `not_connected` rather than `down`. A real adapter
   * replaces this with a cheap vendor call (list models, or a one-token
   * request) and returns `ok` only when the vendor actually answers.
   */
  health(): Promise<ProviderHealthReport> {
    return Promise.resolve({
      status: 'not_connected',
      detail: `Sin conectar: este adaptador está declarado pero todavía no implementado, así que no hay nada que comprobar. ${this.requirement}`,
    });
  }

  execute(_task: ProviderTask, _signal?: AbortSignal): Promise<ProviderResult> {
    return Promise.reject(
      new ProviderNotConfiguredError(
        this.id,
        `este adaptador es un esbozo declarado, no una implementación. ${this.requirement}`,
      ),
    );
  }
}
