/**
 * AnthropicProvider — the Anthropic Messages API, over plain `fetch`.
 *
 * Configured by `ANTHROPIC_API_KEY` and `ANTHROPIC_MODEL` (server side only).
 * The endpoint can be overridden with `ANTHROPIC_API_BASE_URL`. That name is
 * deliberate: `ANTHROPIC_BASE_URL` is what the Anthropic SDKs and tools read,
 * and reusing it would silently send MADRE's traffic wherever another tool on
 * the same machine was pointed.
 *
 * `max_tokens` is mandatory in this API, so one is always sent: the task's, else
 * the adapter's `maxOutputTokens` (`ANTHROPIC_MAX_TOKENS`), else 4096.
 */

import type { ProviderResult, ProviderTask } from '@acc/domain';

import { count, invalidResponse, type FailureContext, type HttpResponse } from './http.ts';
import { dig, RealProvider, type BuiltRequest, type ParsedCompletion, type RealProviderOptions } from './real-provider.ts';

export const ANTHROPIC_DEFAULT_BASE_URL = 'https://api.anthropic.com/v1';
export const ANTHROPIC_VERSION = '2023-06-01';
export const ANTHROPIC_DEFAULT_MAX_TOKENS = 4096;

export class AnthropicProvider extends RealProvider {
  readonly id = 'anthropic' as const;
  readonly label = 'Anthropic';
  readonly keyVariable = 'ANTHROPIC_API_KEY';
  readonly modelVariable = 'ANTHROPIC_MODEL';
  protected readonly defaultBaseUrl = ANTHROPIC_DEFAULT_BASE_URL;

  constructor(options: RealProviderOptions = {}) {
    super(options, ANTHROPIC_DEFAULT_BASE_URL);
  }

  private headers(key: string): Record<string, string> {
    return { 'x-api-key': key, 'anthropic-version': ANTHROPIC_VERSION, 'content-type': 'application/json' };
  }

  protected buildRequest(task: ProviderTask, model: string): BuiltRequest {
    return {
      url: `${this.baseUrl}/messages`,
      headers: this.headers(this.apiKey ?? ''),
      body: {
        model,
        max_tokens: task.maxTokens ?? this.maxOutputTokens ?? ANTHROPIC_DEFAULT_MAX_TOKENS,
        system: task.systemPrompt,
        messages: [{ role: 'user', content: task.prompt }],
        ...(task.temperature !== undefined ? { temperature: task.temperature } : {}),
      },
    };
  }

  protected parse(response: HttpResponse, ctx: FailureContext): ParsedCompletion {
    const json = response.json;
    const content = dig(json, 'content');
    if (!Array.isArray(content)) throw invalidResponse(ctx, 'la respuesta no trae `content`');

    const text = content
      .map((block) => (dig(block, 'type') === 'text' && typeof dig(block, 'text') === 'string' ? (dig(block, 'text') as string) : ''))
      .join('');
    const usage = dig(json, 'usage');
    if (usage === undefined) throw invalidResponse(ctx, 'la respuesta no informa del uso de tokens (`usage`)');

    const stopReason = dig(json, 'stop_reason');
    if (stopReason === 'refusal') {
      throw invalidResponse(ctx, 'el modelo se negó a responder', { retryable: false });
    }
    if (text === '' && content.length > 0 && !content.some((block) => dig(block, 'type') === 'text')) {
      throw invalidResponse(ctx, 'la respuesta no contiene ningún bloque de texto');
    }

    const id = dig(json, 'id');
    return {
      text,
      promptTokens: count(dig(usage, 'input_tokens')),
      completionTokens: count(dig(usage, 'output_tokens')),
      finishReason: finishReason(stopReason),
      vendorRequestId: response.headers.get('request-id') ?? (typeof id === 'string' ? id : null),
    };
  }

  protected probeRequest(key: string): { url: string; headers: Record<string, string> } {
    return { url: `${this.baseUrl}/models`, headers: this.headers(key) };
  }
}

function finishReason(value: unknown): ProviderResult['finishReason'] {
  switch (value) {
    case 'end_turn':
    case 'stop_sequence':
      return 'stop';
    case 'max_tokens':
      return 'length';
    default:
      return 'other';
  }
}
