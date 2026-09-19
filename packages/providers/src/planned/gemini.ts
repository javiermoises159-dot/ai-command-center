import type { ProviderId, ProviderModel } from '@acc/domain';
import { PlannedProvider } from './planned-provider.ts';

/**
 * PLANNED — not implemented.
 *
 * Implementation sketch:
 *   1. `pnpm add @google/genai --filter @acc/providers`
 *   2. Read `GEMINI_API_KEY` from the server config.
 *   3. `client.models.generateContent({ model, contents, config: {
 *      systemInstruction: task.systemPrompt } })`.
 *   4. Map `usageMetadata.promptTokenCount` / `candidatesTokenCount` onto
 *      `ProviderUsage`. Gemini has no stable request id on every response —
 *      generate one in the adapter so `requestId` is never empty.
 */
export class GeminiProvider extends PlannedProvider {
  readonly id: ProviderId = 'gemini';
  readonly label = 'Google Gemini';
  readonly requirement = 'It will need the `@google/genai` package and a GEMINI_API_KEY on the server.';

  protected override models(): readonly ProviderModel[] {
    return [{ id: 'gemini-2.5-flash', label: 'Gemini 2.5 Flash' }];
  }
}
