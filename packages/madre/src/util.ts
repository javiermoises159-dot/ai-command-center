/** Small shared helpers. No I/O, no dependencies. */

import type { ExecutionResult, ResultSource } from './types.ts';

export interface Clock {
  now(): Date;
}

export const systemClock: Clock = { now: () => new Date() };

export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/** Round to a fixed number of decimals without the float noise of `toFixed` strings. */
export function round(value: number, decimals = 2): number {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

export function unique<T>(items: readonly T[]): T[] {
  return [...new Set(items)];
}

export function slug(text: string, max = 40): string {
  return text
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, max);
}

/** Deterministic, non-cryptographic hash. Used for stable ids, never for security. */
export function hash(text: string): string {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function assertNever(value: never, message = 'Unexpected value'): never {
  throw new Error(`${message}: ${String(value)}`);
}

/** Sleep that rejects promptly on abort. */
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error('Aborted'));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new Error('Aborted'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * The real reason an infrastructure operation failed, on one line.
 *
 * `errorMessage` from the domain deliberately hides the message of anything that
 * is not a curated domain error ("Se produjo un error inesperado"), which is right
 * for an HTTP response and wrong for an audit log, where the reason IS the record.
 * Used for storage, persistence and other internal failures, never for text
 * that came from a provider.
 */
export function errorDetail(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  return raw.replace(/\s+/g, ' ').trim().slice(0, 300) || 'error sin descripción';
}

/**
 * Remove anything shaped like a credential from text that is about to be stored
 * or shown (audit, trace, API). Adapters already scrub what they raise; this is
 * the second line, for messages that reach MADRE by another route.
 */
export function redactSecrets(text: string): string {
  return text
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi, 'Bearer [clave oculta]')
    .replace(/(?:sk-(?:ant-|proj-)?[A-Za-z0-9_-]{8,}|AIza[0-9A-Za-z_-]{16,})/g, '[clave oculta]')
    .replace(/([?&](?:key|api_key|apikey|access_token)=)[^&\s]+/gi, '$1[clave oculta]');
}

/**
 * Provenance of a result, whatever generation wrote it. A result stored before
 * provenance existed is derived from its provider id — the same rule the mock
 * has always followed — and never guessed any other way.
 */
export function provenanceOf(result: Pick<ExecutionResult, 'provider' | 'source' | 'simulated'>): { source: ResultSource; simulated: boolean } {
  const source: ResultSource = result.source ?? (result.provider === 'mock' ? 'mock' : 'real');
  return { source, simulated: result.simulated ?? source === 'mock' };
}
