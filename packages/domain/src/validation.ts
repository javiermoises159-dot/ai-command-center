/**
 * Input validation for the write side of the API.
 *
 * This lives in the domain and uses no validation library on purpose: the
 * domain enforces its own invariants and stays runnable without a dependency
 * graph. `@acc/contracts` publishes the same shapes as Zod schemas for the
 * OpenAPI document and the typed frontend client; `contracts/parity.test.ts`
 * asserts the two agree, so the duplication cannot drift silently.
 */

import { ValidationError, type FieldIssue } from './errors.ts';
import type { RunMode } from './ports.ts';
import { MISSION_STATUSES, type MissionStatus } from './types.ts';

export const PROMPT_MIN_LENGTH = 12;
export const PROMPT_MAX_LENGTH = 4000;

export interface CreateMissionInput {
  prompt: string;
  /** Optional provider override; falls back to the server default. */
  providerId?: string;
  model?: string;
  /** When false the mission is created but not queued. Defaults to true. */
  autoStart?: boolean;
  /** `classic` runs the fixed eight-agent pipeline; `madre` compiles and plans first. */
  mode?: RunMode;
}

export interface RunMissionInput {
  providerId?: string;
  model?: string;
  mode?: RunMode;
}

export const RUN_MODES = ['classic', 'madre'] as const;

function parseMode(value: unknown, issues: FieldIssue[]): RunMode | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value === 'string' && (RUN_MODES as readonly string[]).includes(value)) return value as RunMode;
  issues.push({ path: 'mode', message: `Debe ser uno de: ${RUN_MODES.join(', ')}.` });
  return undefined;
}

export interface ListMissionsQuery {
  limit: number;
  offset: number;
  status?: MissionStatus;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function optionalString(
  value: unknown,
  path: string,
  issues: FieldIssue[],
  maxLength = 120,
): string | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value !== 'string') {
    issues.push({ path, message: 'Debe ser un texto.' });
    return undefined;
  }
  const trimmed = value.trim();
  if (trimmed.length === 0) return undefined;
  if (trimmed.length > maxLength) {
    issues.push({ path, message: `Debe tener como máximo ${maxLength} caracteres.` });
    return undefined;
  }
  return trimmed;
}

export function parseCreateMissionInput(body: unknown): CreateMissionInput {
  const issues: FieldIssue[] = [];

  if (!isRecord(body)) {
    throw new ValidationError([{ path: 'body', message: 'Se esperaba un objeto JSON.' }]);
  }

  let prompt = '';
  if (typeof body['prompt'] !== 'string') {
    issues.push({ path: 'prompt', message: 'Obligatorio. Describe la misión con tus propias palabras.' });
  } else {
    prompt = body['prompt'].trim();
    if (prompt.length < PROMPT_MIN_LENGTH) {
      issues.push({
        path: 'prompt',
        message: `Debe tener al menos ${PROMPT_MIN_LENGTH} caracteres para que los agentes tengan algo con lo que trabajar.`,
      });
    } else if (prompt.length > PROMPT_MAX_LENGTH) {
      issues.push({ path: 'prompt', message: `Debe tener como máximo ${PROMPT_MAX_LENGTH} caracteres.` });
    }
  }

  const providerId = optionalString(body['providerId'], 'providerId', issues, 40);
  const model = optionalString(body['model'], 'model', issues, 120);
  const mode = parseMode(body['mode'], issues);

  let autoStart = true;
  if (body['autoStart'] !== undefined) {
    if (typeof body['autoStart'] !== 'boolean') {
      issues.push({ path: 'autoStart', message: 'Debe ser verdadero o falso.' });
    } else {
      autoStart = body['autoStart'];
    }
  }

  if (issues.length > 0) throw new ValidationError(issues);

  return {
    prompt,
    autoStart,
    ...(providerId !== undefined ? { providerId } : {}),
    ...(model !== undefined ? { model } : {}),
    ...(mode !== undefined ? { mode } : {}),
  };
}

export function parseRunMissionInput(body: unknown): RunMissionInput {
  if (body === undefined || body === null || body === '') return {};
  const issues: FieldIssue[] = [];

  if (!isRecord(body)) {
    throw new ValidationError([{ path: 'body', message: 'Se esperaba un objeto JSON.' }]);
  }

  const providerId = optionalString(body['providerId'], 'providerId', issues, 40);
  const model = optionalString(body['model'], 'model', issues, 120);
  const mode = parseMode(body['mode'], issues);

  if (issues.length > 0) throw new ValidationError(issues);

  return {
    ...(providerId !== undefined ? { providerId } : {}),
    ...(model !== undefined ? { model } : {}),
    ...(mode !== undefined ? { mode } : {}),
  };
}

export const LIST_DEFAULT_LIMIT = 20;
export const LIST_MAX_LIMIT = 100;

export function parseListMissionsQuery(query: Record<string, string | undefined>): ListMissionsQuery {
  const issues: FieldIssue[] = [];

  const limit = parseBoundedInt(query['limit'], 'limit', LIST_DEFAULT_LIMIT, 1, LIST_MAX_LIMIT, issues);
  const offset = parseBoundedInt(query['offset'], 'offset', 0, 0, Number.MAX_SAFE_INTEGER, issues);

  let status: MissionStatus | undefined;
  const rawStatus = query['status'];
  if (rawStatus !== undefined && rawStatus !== '') {
    if ((MISSION_STATUSES as readonly string[]).includes(rawStatus)) {
      status = rawStatus as MissionStatus;
    } else {
      issues.push({ path: 'status', message: `Debe ser uno de: ${MISSION_STATUSES.join(', ')}.` });
    }
  }

  if (issues.length > 0) throw new ValidationError(issues);

  return { limit, offset, ...(status !== undefined ? { status } : {}) };
}

function parseBoundedInt(
  raw: string | undefined,
  path: string,
  fallback: number,
  min: number,
  max: number,
  issues: FieldIssue[],
): number {
  if (raw === undefined || raw === '') return fallback;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed)) {
    issues.push({ path, message: 'Debe ser un número entero.' });
    return fallback;
  }
  if (parsed < min || parsed > max) {
    issues.push({ path, message: `Debe estar entre ${min} y ${max}.` });
    return fallback;
  }
  return parsed;
}

// ---------------------------------------------------------------------------
// Mock control directives
// ---------------------------------------------------------------------------

/**
 * Directives the MockProvider understands, embedded in the mission prompt so
 * failure paths can be exercised end-to-end without touching the server:
 *
 *   [fail:marketing]       -> the marketing agent throws
 *   [fail:qa]              -> QA throws, which aborts the run
 *   [slow:2000]            -> every agent call takes ~2000ms
 *
 * They are stripped from the prompt shown in the UI by `deriveTitle`, but kept
 * in the stored prompt so a re-run reproduces the same behaviour.
 */
export interface MockDirectives {
  failingAgents: Set<string>;
  latencyMs?: number;
}

export function parseMockDirectives(prompt: string): MockDirectives {
  const failingAgents = new Set<string>();
  for (const match of prompt.matchAll(/\[fail:([a-z-]+)\]/gi)) {
    const agent = match[1];
    if (agent !== undefined) failingAgents.add(agent.toLowerCase());
  }

  const slow = /\[slow:(\d{1,6})\]/i.exec(prompt);
  const latency = slow?.[1];

  return {
    failingAgents,
    ...(latency !== undefined ? { latencyMs: Number(latency) } : {}),
  };
}
