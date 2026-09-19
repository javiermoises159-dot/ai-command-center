import type { ProviderId, ProviderModel } from '@acc/domain';
import { PlannedProvider } from './planned-provider.ts';

/**
 * PLANNED — not implemented.
 *
 * Implementation sketch for whoever picks this up:
 *   1. `pnpm add openai --filter @acc/providers`
 *   2. Read `OPENAI_API_KEY` from the server config (never from the client).
 *   3. In `execute`, call `client.responses.create({ model, instructions:
 *      task.systemPrompt, input: task.prompt, signal })`.
 *   4. Map the response onto `ProviderResult`: `text`, `usage` from
 *      `response.usage`, `requestId` from `response.id`, and translate
 *      `finish_reason` onto the normalised union.
 *   5. Wrap any vendor error in `ProviderFailedError` — vendor error types must
 *      not cross this boundary.
 *   6. Set `availability` to 'available' and drop the `PlannedProvider` base.
 */
export class OpenAIProvider extends PlannedProvider {
  readonly id: ProviderId = 'openai';
  readonly label = 'OpenAI';
  readonly requirement = 'It will need the `openai` package and an OPENAI_API_KEY on the server.';

  protected override models(): readonly ProviderModel[] {
    return [{ id: 'gpt-4.1-mini', label: 'GPT-4.1 mini' }];
  }
}
