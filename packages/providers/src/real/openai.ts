/**
 * OpenAIProvider — the OpenAI Chat Completions API, over plain `fetch`.
 *
 * Configured by `OPENAI_API_KEY` and `OPENAI_MODEL` (server side only). A
 * different endpoint (a proxy, an Azure-style gateway) can be set with
 * `OPENAI_API_BASE_URL`.
 *
 * Chat Completions is used rather than the newer Responses API because it is
 * the one surface every current OpenAI model still serves and the one the
 * OpenAI-compatible adapter will share. `max_completion_tokens` is sent instead
 * of the deprecated `max_tokens`; `temperature` is only sent when the task sets
 * one, because reasoning models reject it.
 */

import type { ProviderResult, ProviderTask } from '@acc/domain';

import { count, invalidResponse, type FailureContext, type HttpResponse } from './http.ts';
import { dig, RealProvider, type BuiltRequest, type ParsedCompletion, type RealProviderOptions } from './real-provider.ts';

export const OPENAI_DEFAULT_BASE_URL = 'https://api.openai.com/v1';

export class OpenAIProvider extends RealProvider {
  readonly id = 'openai' as const;
  readonly label = 'OpenAI';
  readonly keyVariable = 'OPENAI_API_KEY';
  readonly modelVariable = 'OPENAI_MODEL';
  protected readonly defaultBaseUrl = OPENAI_DEFAULT_BASE_URL;

  constructor(options: RealProviderOptions = {}) {
    super(options, OPENAI_DEFAULT_BASE_URL);
  }

  private headers(key: string): Record<string, string> {
    return { authorization: `Bearer ${key}`, 'content-type': 'application/json' };
  }

  protected buildRequest(task: ProviderTask, model: string): BuiltRequest {
    const maxTokens = task.maxTokens ?? this.maxOutputTokens;
    return {
      url: `${this.baseUrl}/chat/completions`,
      headers: this.headers(this.apiKey ?? ''),
      body: {
        model,
        messages: [
          { role: 'system', content: task.systemPrompt },
          { role: 'user', content: task.prompt },
        ],
        ...(task.temperature !== undefined ? { temperature: task.temperature } : {}),
        ...(maxTokens !== null && maxTokens !== undefined ? { max_completion_tokens: maxTokens } : {}),
      },
    };
  }

  protected parse(response: HttpResponse, ctx: FailureContext): ParsedCompletion {
    const json = response.json;
    const choice = dig(json, 'choices', 0);
    if (choice === undefined) throw invalidResponse(ctx, 'la respuesta no trae ninguna opción (`choices`)');

    const refusal = dig(choice, 'message', 'refusal');
    if (typeof refusal === 'string' && refusal.trim() !== '') {
      // The model declined. That is an answer from the vendor, but not one this
      // step can use, and asking again unchanged would get the same refusal.
      throw invalidResponse(ctx, `el modelo se negó a responder: ${refusal.slice(0, 200)}`, { retryable: false });
    }
    const content = dig(choice, 'message', 'content');
    if (typeof content !== 'string') throw invalidResponse(ctx, 'la opción no trae texto (`message.content`)');

    const usage = dig(json, 'usage');
    if (usage === undefined) throw invalidResponse(ctx, 'la respuesta no informa del uso de tokens (`usage`)');
    const id = dig(json, 'id');

    return {
      text: content,
      promptTokens: count(dig(usage, 'prompt_tokens')),
      completionTokens: count(dig(usage, 'completion_tokens')),
      finishReason: finishReason(dig(choice, 'finish_reason')),
      vendorRequestId: response.headers.get('x-request-id') ?? (typeof id === 'string' ? id : null),
    };
  }

  protected probeRequest(key: string): { url: string; headers: Record<string, string> } {
    return { url: `${this.baseUrl}/models`, headers: this.headers(key) };
  }
}

function finishReason(value: unknown): ProviderResult['finishReason'] {
  switch (value) {
    case 'stop':
      return 'stop';
    case 'length':
      return 'length';
    case 'content_filter':
      return 'content_filter';
    default:
      return 'other';
  }
}
