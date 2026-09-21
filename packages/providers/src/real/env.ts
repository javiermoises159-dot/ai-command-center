/**
 * Reads the real providers' configuration from the environment.
 *
 * The one place that knows the variable names. Nothing here is logged or
 * returned to a client: the result goes to the provider constructors and no
 * further.
 *
 *   OpenAI      OPENAI_API_KEY      OPENAI_MODEL      OPENAI_API_BASE_URL
 *   Anthropic   ANTHROPIC_API_KEY   ANTHROPIC_MODEL   ANTHROPIC_API_BASE_URL   ANTHROPIC_MAX_TOKENS
 *   Compatible  OPENAI_COMPAT_API_KEY  OPENAI_COMPAT_MODEL  OPENAI_COMPAT_BASE_URL (required)  OPENAI_COMPAT_LABEL
 *   Gemini      GOOGLE_API_KEY      GEMINI_MODEL      GEMINI_API_BASE_URL
 *   Cerebras    CEREBRAS_API_KEY    CEREBRAS_MODEL
 *   Mistral     MISTRAL_API_KEY     MISTRAL_MODEL
 *   Cloudflare  CLOUDFLARE_API_TOKEN  CLOUDFLARE_ACCOUNT_ID  CLOUDFLARE_MODEL
 *               (GEMINI_API_KEY is accepted as an alias: it is the name earlier
 *                versions of `.env.example` used)
 *
 * `*_MODEL` accepts one id or a comma-separated list; the first is the default.
 * There is no built-in default model: model ids age quickly, and picking one
 * for the operator would mean spending their money on a model they never chose.
 */

import type { HostedCompatOptions } from './hosted-compat.ts';
import type { OpenAICompatibleOptions } from './openai-compatible.ts';
import type { RealProviderOptions } from './real-provider.ts';

export interface RealProviderEnv {
  openai: RealProviderOptions;
  anthropic: RealProviderOptions;
  gemini: RealProviderOptions;
  openaiCompatible: OpenAICompatibleOptions;
  cerebras: HostedCompatOptions;
  mistral: HostedCompatOptions;
  cloudflare: HostedCompatOptions;
}

type Env = Readonly<Record<string, string | undefined>>;

function value(env: Env, name: string): string | undefined {
  const raw = env[name];
  return raw === undefined || raw.trim() === '' ? undefined : raw.trim();
}

function list(env: Env, name: string): string[] {
  return (value(env, name) ?? '')
    .split(',')
    .map((m) => m.trim())
    .filter((m) => m !== '');
}

function positiveInt(env: Env, name: string): number | undefined {
  const raw = value(env, name);
  if (raw === undefined) return undefined;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed <= 0) throw new Error(`Environment variable ${name} must be a positive integer, got "${raw}".`);
  return parsed;
}

export function realProviderOptionsFromEnv(env: Env): RealProviderEnv {
  const maxTokens = positiveInt(env, 'ANTHROPIC_MAX_TOKENS');
  return {
    openai: { apiKey: value(env, 'OPENAI_API_KEY'), models: list(env, 'OPENAI_MODEL'), baseUrl: value(env, 'OPENAI_API_BASE_URL') },
    anthropic: {
      apiKey: value(env, 'ANTHROPIC_API_KEY'),
      models: list(env, 'ANTHROPIC_MODEL'),
      baseUrl: value(env, 'ANTHROPIC_API_BASE_URL'),
      ...(maxTokens !== undefined ? { maxOutputTokens: maxTokens } : {}),
    },
    gemini: {
      apiKey: value(env, 'GOOGLE_API_KEY') ?? value(env, 'GEMINI_API_KEY'),
      models: list(env, 'GEMINI_MODEL'),
      baseUrl: value(env, 'GEMINI_API_BASE_URL'),
    },
    openaiCompatible: {
      apiKey: value(env, 'OPENAI_COMPAT_API_KEY'),
      models: list(env, 'OPENAI_COMPAT_MODEL'),
      baseUrl: value(env, 'OPENAI_COMPAT_BASE_URL'),
      label: value(env, 'OPENAI_COMPAT_LABEL'),
    },
    cerebras: { apiKey: value(env, 'CEREBRAS_API_KEY'), models: list(env, 'CEREBRAS_MODEL'), baseUrl: value(env, 'CEREBRAS_API_BASE_URL') },
    mistral: { apiKey: value(env, 'MISTRAL_API_KEY'), models: list(env, 'MISTRAL_MODEL'), baseUrl: value(env, 'MISTRAL_API_BASE_URL') },
    cloudflare: {
      apiKey: value(env, 'CLOUDFLARE_API_TOKEN'),
      models: list(env, 'CLOUDFLARE_MODEL'),
      accountId: value(env, 'CLOUDFLARE_ACCOUNT_ID'),
    },
  };
}
