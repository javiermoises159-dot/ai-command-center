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
}

export interface RunMissionInput {
  providerId?: string;
  model?: string;
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
    issues.push({ path, message: 'Must be a string.' });
    return undefined;
  }
  const trimmed = value.trim();
  if (trimmed.length === 0) return undefined;
  if (trimmed.length > maxLength) {
    issues.push({ path, message: `Must be at most ${maxLength} characters.` });
    return undefined;
  }
  return trimmed;
}

export function parseCreateMissionInput(body: unknown): CreateMissionInput {
  const issues: FieldIssue[] = [];

  if (!isRecord(body)) {
    throw new ValidationError([{ path: 'body', message: 'Expected a JSON object.' }]);
  }

  let prompt = '';
  if (typeof body['prompt'] !== 'string') {
    issues.push({ path: 'prompt', message: 'Required. Describe the mission in plain language.' });
  } else {
    prompt = body['prompt'].trim();
    if (prompt.length < PROMPT_MIN_LENGTH) {
      issues.push({
        path: 'prompt',
        message: `Must be at least ${PROMPT_MIN_LENGTH} characters so the agents have something to work with.`,
      });
    } else if (prompt.length > PROMPT_MAX_LENGTH) {
      issues.push({ path: 'prompt', message: `Must be at most ${PROMPT_MAX_LENGTH} characters.` });
    }
  }

  const providerId = optionalString(body['providerId'], 'providerId', issues, 40);
  const model = optionalString(body['model'], 'model', issues, 120);

  let autoStart = true;
  if (body['autoStart'] !== undefined) {
    if (typeof body['autoStart'] !== 'boolean') {
      issues.push({ path: 'autoStart', message: 'Must be a boolean.' });
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
  };
}

export function parseRunMissionInput(body: unknown): RunMissionInput {
  if (body === undefined || body === null || body === '') return {};
  const issues: FieldIssue[] = [];

  if (!isRecord(body)) {
    throw new ValidationError([{ path: 'body', message: 'Expected a JSON object.' }]);
  }

  const providerId = optionalString(body['providerId'], 'providerId', issues, 40);
  const model = optionalString(body['model'], 'model', issues, 120);

  if (issues.length > 0) throw new ValidationError(issues);

  return {
    ...(providerId !== undefined ? { providerId } : {}),
    ...(model !== undefined ? { model } : {}),
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
      issues.push({ path: 'status', message: `Must be one of: ${MISSION_STATUSES.join(', ')}.` });
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
    issues.push({ path, message: 'Must be an integer.' });
    return fallback;
  }
  if (parsed < min || parsed > max) {
    issues.push({ path, message: `Must be between ${min} and ${max}.` });
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
