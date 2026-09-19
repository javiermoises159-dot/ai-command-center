/**
 * Base for provider adapters that are declared but NOT implemented.
 *
 * These are real registry entries so the API and UI can honestly show what is
 * coming, but `execute` always throws. Nothing here silently degrades to the
 * mock — a planned provider that gets executed fails loudly and says exactly
 * what is missing.
 *
 * To make one real: replace the subclass's `execute` with a vendor call that
 * returns a `ProviderResult`, and flip `availability` to 'available'. Nothing
 * else in the system changes.
 */

import {
  ProviderNotConfiguredError,
  type AIProvider,
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

  protected abstract models(): readonly ProviderModel[];

  listModels(): readonly ProviderModel[] {
    return this.models();
  }

  execute(_task: ProviderTask, _signal?: AbortSignal): Promise<ProviderResult> {
    return Promise.reject(
      new ProviderNotConfiguredError(
        this.id,
        `this adapter is a declared stub, not an implementation. ${this.requirement}`,
      ),
    );
  }
}
