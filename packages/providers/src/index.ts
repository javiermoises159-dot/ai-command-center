import { MockProvider, type MockProviderOptions } from './mock/mock-provider.ts';
import { AnthropicProvider } from './planned/anthropic.ts';
import { GeminiProvider } from './planned/gemini.ts';
import { OpenAICompatibleProvider } from './planned/openai-compatible.ts';
import { OpenAIProvider } from './planned/openai.ts';
import { ProviderRegistry } from './registry.ts';

export { MockProvider, type MockProviderOptions } from './mock/mock-provider.ts';
export { SIMULATION_NOTICE } from './mock/generators.ts';
export { ProviderRegistry } from './registry.ts';
export { PlannedProvider } from './planned/planned-provider.ts';
export { OpenAIProvider } from './planned/openai.ts';
export { AnthropicProvider } from './planned/anthropic.ts';
export { GeminiProvider } from './planned/gemini.ts';
export { OpenAICompatibleProvider } from './planned/openai-compatible.ts';

/**
 * Build the registry the server uses.
 *
 * Only the mock is available. The other four are registered as planned so the
 * `/api/providers` endpoint and the UI can show the roadmap without pretending
 * anything works — selecting one returns 503 with an explanation.
 */
export function createProviderRegistry(options: { mock?: MockProviderOptions } = {}): ProviderRegistry {
  const notImplemented = 'Declared adapter, not implemented yet. Selecting it returns an error.';

  return new ProviderRegistry()
    .register(new MockProvider(options.mock ?? {}), {
      makeDefault: true,
      note: 'Deterministic local simulation. Performs no reasoning; every result is labelled as simulated.',
    })
    .register(new OpenAIProvider(), { note: notImplemented })
    .register(new AnthropicProvider(), { note: notImplemented })
    .register(new GeminiProvider(), { note: notImplemented })
    .register(new OpenAICompatibleProvider(), { note: notImplemented });
}
