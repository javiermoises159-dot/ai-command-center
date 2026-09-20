/**
 * Test support for the real adapters: a fake `fetch` at the HTTP level and the
 * response bodies each vendor really sends. No network is ever touched.
 *
 * The keys used here are obviously fake and are only ever compared against, to
 * prove they do not leak.
 */

import type { HttpFetch } from './http.ts';

export interface RecordedRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
  signal: AbortSignal | undefined;
}

export interface FakeReply {
  status?: number;
  body?: unknown;
  /** Sent as the raw body instead of JSON. */
  raw?: string;
  headers?: Record<string, string>;
  /** Wait this long (or until aborted) before answering. */
  delayMs?: number;
  /** Reject like a dropped connection. */
  networkError?: string;
}

export function fakeFetch(reply: FakeReply | ((request: RecordedRequest, index: number) => FakeReply)) {
  const requests: RecordedRequest[] = [];
  const fetch: HttpFetch = async (url, init) => {
    const request: RecordedRequest = {
      url,
      method: init?.method ?? 'GET',
      headers: init?.headers ?? {},
      body: init?.body === undefined ? undefined : JSON.parse(init.body),
      signal: init?.signal,
    };
    requests.push(request);
    const r = typeof reply === 'function' ? reply(request, requests.length - 1) : reply;
    if (r.delayMs !== undefined) {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(resolve, r.delayMs);
        init?.signal?.addEventListener('abort', () => {
          clearTimeout(timer);
          reject(new DOMException('This operation was aborted', 'AbortError'));
        });
      });
    }
    if (r.networkError !== undefined) throw new TypeError(r.networkError);
    const status = r.status ?? 200;
    const headers = Object.fromEntries(Object.entries(r.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v]));
    return {
      ok: status >= 200 && status < 300,
      status,
      text: async () => r.raw ?? JSON.stringify(r.body ?? {}),
      headers: { get: (name: string) => headers[name.toLowerCase()] ?? null },
    };
  };
  return { fetch, requests };
}

export const FAKE_KEYS = {
  openai: 'sk-test-FAKEFAKEFAKE1234567890',
  anthropic: 'sk-ant-test-FAKEFAKEFAKE1234567890',
  google: 'AIzaFAKEFAKEFAKEFAKEFAKE1234567890',
} as const;

export const TEXT = 'Una cookie es un pequeño archivo de texto que un sitio web guarda en tu navegador para recordar quién eres.';

// ---- what each vendor answers ----------------------------------------------

export const openaiOk = (text = TEXT) => ({
  id: 'chatcmpl-abc123',
  object: 'chat.completion',
  model: 'gpt-test',
  choices: [{ index: 0, message: { role: 'assistant', content: text }, finish_reason: 'stop' }],
  usage: { prompt_tokens: 120, completion_tokens: 30, total_tokens: 150 },
});

export const anthropicOk = (text = TEXT) => ({
  id: 'msg_01ABC',
  type: 'message',
  role: 'assistant',
  model: 'claude-test',
  content: [{ type: 'text', text }],
  stop_reason: 'end_turn',
  usage: { input_tokens: 120, output_tokens: 30 },
});

export const geminiOk = (text = TEXT) => ({
  candidates: [{ content: { role: 'model', parts: [{ text }] }, finishReason: 'STOP' }],
  usageMetadata: { promptTokenCount: 120, candidatesTokenCount: 30, totalTokenCount: 150 },
  responseId: 'resp-xyz',
});
