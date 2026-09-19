import type { ProviderId, ProviderModel } from '@acc/domain';
import { PlannedProvider } from './planned-provider.ts';

/**
 * PLANNED — not implemented.
 *
 * Implementation sketch:
 *   1. `pnpm add @anthropic-ai/sdk --filter @acc/providers`
 *   2. Read `ANTHROPIC_API_KEY` from the server config.
 *   3. `client.messages.create({ model, system: task.systemPrompt, messages:
 *      [{ role: 'user', content: task.prompt }], max_tokens })`.
 *   4. `task.context` is well suited to this vendor: render `upstream` as
 *      separate content blocks rather than one concatenated string, and put a
 *      cache breakpoint after the mission statement so re-runs are cheap.
 *   5. Map `usage.input_tokens` / `usage.output_tokens` onto `ProviderUsage`
 *      and `stop_reason` onto the normalised `finishReason`.
 */
export class AnthropicProvider extends PlannedProvider {
  readonly id: ProviderId = 'anthropic';
  readonly label = 'Anthropic';
  readonly requirement = 'It will need the `@anthropic-ai/sdk` package and an ANTHROPIC_API_KEY on the server.';

  protected override models(): readonly ProviderModel[] {
    return [{ id: 'claude-sonnet-4', label: 'Claude Sonnet 4' }];
  }
}
