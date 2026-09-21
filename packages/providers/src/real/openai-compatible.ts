/**
 * OpenAICompatibleProvider — any host that speaks the OpenAI Chat Completions
 * shape: OpenRouter (many models, several free), Groq, Cerebras, Mistral,
 * GitHub Models, Together, LM Studio, vLLM…
 *
 * One endpoint per deployment, configured by:
 *   OPENAI_COMPAT_BASE_URL   e.g. https://openrouter.ai/api/v1   (required, no default)
 *   OPENAI_COMPAT_API_KEY
 *   OPENAI_COMPAT_MODEL      one id or a comma-separated list; first is the default
 *   OPENAI_COMPAT_LABEL      optional display name ("OpenRouter")
 *
 * Differences from the OpenAI adapter: the base URL has no default (guessing a
 * host would send a key to the wrong place), `max_tokens` is used because it is
 * the name every host accepts, and a missing `usage` block counts as 0 tokens
 * instead of failing — hosts are inconsistent there, and nothing is guessed.
 */

import type { ProviderConfiguration, ProviderId, ProviderResult, ProviderTask } from '@acc/domain';

import { count, invalidResponse, type FailureContext, type HttpResponse } from './http.ts';
import { dig, RealProvider, type BuiltRequest, type ParsedCompletion, type RealProviderOptions } from './real-provider.ts';

export interface OpenAICompatibleOptions extends RealProviderOptions {
  /** Display name of the host, e.g. "OpenRouter". */
  label?: string | undefined;
}

export class OpenAICompatibleProvider extends RealProvider {
  readonly id: ProviderId = 'openai-compatible';
  readonly label: string;
  readonly keyVariable: string = 'OPENAI_COMPAT_API_KEY';
  readonly modelVariable: string = 'OPENAI_COMPAT_MODEL';
  /** Variable that must hold the host URL when there is no built-in one (for messages). */
  protected readonly baseUrlVariable: string = 'OPENAI_COMPAT_BASE_URL';
  protected readonly defaultBaseUrl: string = '';
  private readonly hasBaseUrl: boolean;

  constructor(options: OpenAICompatibleOptions = {}) {
    const hasBaseUrl = (options.baseUrl?.trim() ?? '') !== '';
    // Without a base URL there is nowhere to send anything: force `unconfigured`.
    super(hasBaseUrl ? options : { ...options, models: [] }, '');
    this.hasBaseUrl = hasBaseUrl;
    const label = options.label?.trim();
    this.label = label !== undefined && label !== '' ? label : 'Endpoint compatible con OpenAI';
  }

  override configuration(): ProviderConfiguration {
    const base = super.configuration();
    if (this.hasBaseUrl) return base;
    const rest = base.requires.filter((r) => r !== this.modelVariable);
    return {
      configured: false,
      reason: `Sin configurar: falta ${this.baseUrlVariable}${this.apiKey === null ? `, ${this.keyVariable}` : ''} y ${this.modelVariable}. No se sustituye por una simulación.`,
      requires: [this.baseUrlVariable, ...rest, this.modelVariable],
    };
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
        ...(maxTokens !== null && maxTokens !== undefined ? { max_tokens: maxTokens } : {}),
      },
    };
  }

  protected parse(response: HttpResponse, ctx: FailureContext): ParsedCompletion {
    const json = response.json;
    // Some hosts return HTTP 200 with an `error` object when a free model is busy.
    const err = dig(json, 'error', 'message');
    if (typeof err === 'string') throw invalidResponse(ctx, `el host devolvió un error: ${err.slice(0, 200)}`);
    const choice = dig(json, 'choices', 0);
    if (choice === undefined) throw invalidResponse(ctx, 'la respuesta no trae ninguna opción (`choices`)');
    const content = dig(choice, 'message', 'content');
    if (typeof content !== 'string' || content.trim() === '') throw invalidResponse(ctx, 'la opción no trae texto (`message.content`)');
    const usage = dig(json, 'usage');
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
