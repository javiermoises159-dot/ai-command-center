import type { ProviderId, ProviderModel } from '@acc/domain';
import { PlannedProvider } from './planned-provider.ts';

/**
 * PLANNED — not implemented.
 *
 * Covers anything speaking the OpenAI Chat Completions shape: Groq, Together,
 * OpenRouter, Ollama, vLLM, LM Studio.
 *
 * Implementation sketch:
 *   1. No SDK strictly required — `fetch` against
 *      `${OPENAI_COMPATIBLE_BASE_URL}/chat/completions` is enough.
 *   2. Read `OPENAI_COMPATIBLE_BASE_URL` and `OPENAI_COMPATIBLE_API_KEY`.
 *   3. Model list should be discovered from `GET /models` at boot rather than
 *      hardcoded, since the catalogue differs per host.
 *   4. Usage fields are inconsistent across hosts — default missing counts to 0
 *      rather than throwing, and never guess.
 */
export class OpenAICompatibleProvider extends PlannedProvider {
  readonly id: ProviderId = 'openai-compatible';
  readonly label = 'OpenAI-compatible endpoint';
  readonly requirement =
    'It will need OPENAI_COMPATIBLE_BASE_URL (and usually OPENAI_COMPATIBLE_API_KEY) on the server.';

  protected override models(): readonly ProviderModel[] {
    return [{ id: 'configured-at-runtime', label: 'Discovered from the endpoint' }];
  }
}
