import { MockProvider, type MockProviderOptions } from './mock/mock-provider.ts';
import { createCerebras, createCloudflare, createMistral, createNvidia, type HostedCompatOptions } from './real/hosted-compat.ts';
import { OpenAICompatibleProvider, type OpenAICompatibleOptions } from './real/openai-compatible.ts';
import { AnthropicProvider } from './real/anthropic.ts';
import { GeminiProvider } from './real/gemini.ts';
import { OpenAIProvider } from './real/openai.ts';
import type { RealProviderOptions } from './real/real-provider.ts';
import { OllamaProvider, type OllamaOptions } from './local/ollama.ts';
import { ProviderRegistry } from './registry.ts';

export { MockProvider, type MockProviderOptions } from './mock/mock-provider.ts';
export { SIMULATION_NOTICE } from './mock/generators.ts';
export { ProviderRegistry } from './registry.ts';
export { PlannedProvider } from './planned/planned-provider.ts';
export { OpenAIProvider } from './real/openai.ts';
export { AnthropicProvider } from './real/anthropic.ts';
export { GeminiProvider } from './real/gemini.ts';
export { RealProvider, TEXT_ONLY, type RealProviderOptions } from './real/real-provider.ts';
export { realProviderOptionsFromEnv, type RealProviderEnv } from './real/env.ts';
export { scrub, type HttpFetch } from './real/http.ts';
export { HostedCompatProvider, createCerebras, createCloudflare, createMistral, createNvidia, type HostedCompatOptions } from './real/hosted-compat.ts';
export { OpenAICompatibleProvider, type OpenAICompatibleOptions } from './real/openai-compatible.ts';
export { OllamaProvider, discoverOllamaModels, type FetchLike, type OllamaOptions } from './local/ollama.ts';

export interface ProviderRegistryOptions {
  mock?: MockProviderOptions;
  ollama?: OllamaOptions;
  /** OpenAI, Anthropic and Gemini. Absent fields mean "not configured", never "simulated". */
  openai?: RealProviderOptions;
  anthropic?: RealProviderOptions;
  gemini?: RealProviderOptions;
  openaiCompatible?: OpenAICompatibleOptions;
  cerebras?: HostedCompatOptions;
  mistral?: HostedCompatOptions;
  cloudflare?: HostedCompatOptions;
  nvidia?: HostedCompatOptions;
}

/**
 * Build the registry the server uses.
 *
 * The mock is always registered (it is the default and the last resort of the
 * router). OpenAI, Anthropic and Gemini are real adapters: `available` only when
 * their key and model are configured, `unconfigured` otherwise — and an
 * unconfigured one fails when executed; it does not fall back to the mock.
 * Ollama is available when a server answers. The OpenAI-compatible adapter
 * (OpenRouter, Groq, Cerebras, Mistral…) is real too, and needs its own base URL.
 */
export function createProviderRegistry(options: ProviderRegistryOptions = {}): ProviderRegistry {
  const ollama = new OllamaProvider(options.ollama);
  const openai = new OpenAIProvider(options.openai);
  const anthropic = new AnthropicProvider(options.anthropic);
  const gemini = new GeminiProvider(options.gemini);
  const compat = new OpenAICompatibleProvider(options.openaiCompatible);

  return new ProviderRegistry()
    .register(new MockProvider(options.mock ?? {}), {
      makeDefault: true,
      note: 'Simulación local determinista. No razona: todos los resultados se marcan como simulados.',
    })
    .register(ollama, {
      note: ollama.unavailableReason() === null ? 'Modelos locales servidos por tu instancia de Ollama. Sin clave de API y sin coste por llamada.' : `NO CONECTADO.${ollama.unavailableReason()}`,
    })
    .register(openai)
    .register(anthropic)
    .register(gemini)
    .register(compat)
    .register(createCerebras(options.cerebras))
    .register(createMistral(options.mistral))
    .register(createNvidia(options.nvidia))
    .register(createCloudflare(options.cloudflare));
}
