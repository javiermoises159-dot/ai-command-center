/**
 * GeminiProvider — the Google AI Studio Gemini API (`generativelanguage`),
 * over plain `fetch`. This is the API-key path; Vertex AI is not used.
 *
 * Configured by `GOOGLE_API_KEY` (or the older `GEMINI_API_KEY`) and
 * `GEMINI_MODEL`, server side only. The endpoint can be overridden with
 * `GEMINI_API_BASE_URL`.
 *
 * The key travels in the `x-goog-api-key` header, never in the URL, so it cannot
 * end up in a proxy log or an error message that quotes the URL.
 */

import type { ProviderResult, ProviderTask } from '@acc/domain';

import { count, invalidResponse, type FailureContext, type HttpResponse } from './http.ts';
import { dig, RealProvider, type BuiltRequest, type ParsedCompletion, type RealProviderOptions } from './real-provider.ts';

export const GEMINI_DEFAULT_BASE_URL = 'https://generativelanguage.googleapis.com/v1beta';

const BLOCKED_FINISH = new Set(['SAFETY', 'RECITATION', 'BLOCKLIST', 'PROHIBITED_CONTENT', 'SPII', 'IMAGE_SAFETY']);

export class GeminiProvider extends RealProvider {
  readonly id = 'gemini' as const;
  readonly label = 'Google Gemini';
  readonly keyVariable = 'GOOGLE_API_KEY';
  readonly modelVariable = 'GEMINI_MODEL';
  protected readonly defaultBaseUrl = GEMINI_DEFAULT_BASE_URL;

  constructor(options: RealProviderOptions = {}) {
    super(options, GEMINI_DEFAULT_BASE_URL);
  }

  private headers(key: string): Record<string, string> {
    return { 'x-goog-api-key': key, 'content-type': 'application/json' };
  }

  protected buildRequest(task: ProviderTask, model: string): BuiltRequest {
    const maxTokens = task.maxTokens ?? this.maxOutputTokens;
    const generationConfig: Record<string, unknown> = {
      ...(task.temperature !== undefined ? { temperature: task.temperature } : {}),
      ...(maxTokens !== null && maxTokens !== undefined ? { maxOutputTokens: maxTokens } : {}),
    };
    const bare = model.replace(/^models\//, '');
    return {
      url: `${this.baseUrl}/models/${encodeURIComponent(bare)}:generateContent`,
      headers: this.headers(this.apiKey ?? ''),
      body: {
        systemInstruction: { parts: [{ text: task.systemPrompt }] },
        contents: [{ role: 'user', parts: [{ text: task.prompt }] }],
        ...(Object.keys(generationConfig).length > 0 ? { generationConfig } : {}),
      },
    };
  }

  protected parse(response: HttpResponse, ctx: FailureContext): ParsedCompletion {
    const json = response.json;
    const candidate = dig(json, 'candidates', 0);
    if (candidate === undefined) {
      // No candidate: Gemini reports why in `promptFeedback`. That is a refusal to
      // answer this prompt, and repeating it unchanged gets the same verdict.
      const blocked = dig(json, 'promptFeedback', 'blockReason');
      if (typeof blocked === 'string') throw invalidResponse(ctx, `Gemini bloqueó la petición (${blocked})`, { retryable: false });
      throw invalidResponse(ctx, 'la respuesta no trae ningún candidato (`candidates`)');
    }

    const finish = dig(candidate, 'finishReason');
    if (typeof finish === 'string' && BLOCKED_FINISH.has(finish)) {
      throw invalidResponse(ctx, `Gemini detuvo la respuesta por sus filtros (${finish})`, { retryable: false });
    }

    const parts = dig(candidate, 'content', 'parts');
    if (!Array.isArray(parts)) throw invalidResponse(ctx, 'el candidato no trae contenido (`content.parts`)');
    // Thought parts (`thought: true`) are the model's reasoning, not the answer.
    const text = parts
      .map((part) => (typeof dig(part, 'text') === 'string' && dig(part, 'thought') !== true ? (dig(part, 'text') as string) : ''))
      .join('');

    const usage = dig(json, 'usageMetadata');
    if (usage === undefined) throw invalidResponse(ctx, 'la respuesta no informa del uso de tokens (`usageMetadata`)');
    const promptTokens = count(dig(usage, 'promptTokenCount'));
    // Reasoning tokens are billed as output but reported apart, so they are added.
    const completionTokens = count(dig(usage, 'candidatesTokenCount')) + count(dig(usage, 'thoughtsTokenCount'));

    const responseId = dig(json, 'responseId');
    return {
      text,
      promptTokens,
      completionTokens,
      finishReason: finishReason(finish),
      vendorRequestId: typeof responseId === 'string' ? responseId : null,
    };
  }

  protected probeRequest(key: string): { url: string; headers: Record<string, string> } {
    return { url: `${this.baseUrl}/models?pageSize=1`, headers: this.headers(key) };
  }
}

function finishReason(value: unknown): ProviderResult['finishReason'] {
  switch (value) {
    case 'STOP':
      return 'stop';
    case 'MAX_TOKENS':
      return 'length';
    default:
      return 'other';
  }
}
