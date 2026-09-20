/**
 * MADRE endpoints. Registered only when the server has a MADRE core.
 *
 * Bodies are validated by hand and answered with plain JSON documents; the
 * shapes are declared in @acc/contracts.
 */

import { DomainError, ValidationError, type FieldIssue } from '@acc/domain';
import { ApprovalError, MadreNotFoundError, type Budget, type MadreService, type MemoryScope, type MemoryType } from '@acc/madre';

import { json, type HttpRequest, type Route, type RouteParams } from './types.ts';

const MEMORY_TYPES: readonly MemoryType[] = ['user_context', 'project_context', 'mission_history', 'fact', 'decision', 'preference', 'result', 'lesson', 'external_source', 'temporary'];
const MEMORY_SCOPES: readonly MemoryScope[] = ['user', 'project', 'mission', 'session'];
const ON_EXCEED = ['block', 'fallback_local', 'ask'] as const;

function bodyObject(body: unknown): Record<string, unknown> {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw new ValidationError([{ path: '', message: 'Se esperaba un objeto JSON.' }]);
  }
  return body as Record<string, unknown>;
}

function text(body: Record<string, unknown>, key: string, max: number, issues: FieldIssue[], required = true): string | undefined {
  const value = body[key];
  if (value === undefined || value === null) {
    if (required) issues.push({ path: key, message: 'Obligatorio.' });
    return undefined;
  }
  if (typeof value !== 'string' || (required && value.trim() === '')) {
    issues.push({ path: key, message: 'Debe ser un texto no vacío.' });
    return undefined;
  }
  if (value.length > max) {
    issues.push({ path: key, message: `No puede superar los ${max} caracteres.` });
    return undefined;
  }
  return value.trim();
}

function limit(request: HttpRequest, fallback: number, max: number): number {
  const raw = request.query['limit'];
  if (raw === undefined) return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1) throw new ValidationError([{ path: 'limit', message: 'Debe ser un número entero positivo.' }]);
  return Math.min(n, max);
}

function param(params: RouteParams, name: string): string {
  const v = params[name];
  if (v === undefined) throw new Error(`Route parameter ":${name}" was not captured.`);
  return v;
}

function money(body: Record<string, unknown>, key: string, issues: FieldIssue[]): number | null | undefined {
  if (!(key in body)) return undefined;
  const v = body[key];
  if (v === null) return null;
  if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) {
    issues.push({ path: key, message: 'Debe ser un número mayor o igual que cero, o nulo.' });
    return undefined;
  }
  return v;
}

/** Translate MADRE's own errors into the API's error shape. */
async function guarded<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    if (error instanceof MadreNotFoundError) throw new DomainError('not_found', error.message, { status: 404, publicMessage: error.message });
    if (error instanceof ApprovalError) {
      throw error.code === 'not_found'
        ? new DomainError('not_found', error.message, { status: 404, publicMessage: 'No se encontró la aprobación.' })
        : new DomainError('conflict', error.message, { status: 409, publicMessage: error.message });
    }
    throw error;
  }
}

export function madreRoutes(madre: MadreService): Route[] {
  return [
    { method: 'GET', pattern: '/api/madre/overview', handler: async () => json(200, await madre.overview()) },
    { method: 'GET', pattern: '/api/madre/agents', handler: async () => json(200, { items: madre.agents() }) },
    { method: 'GET', pattern: '/api/madre/providers', handler: async () => json(200, { items: madre.providers() }) },
    { method: 'GET', pattern: '/api/madre/tools', handler: async () => json(200, { items: madre.tools() }) },
    { method: 'GET', pattern: '/api/madre/permissions', handler: async () => json(200, { modes: madre.permissions() }) },
    { method: 'GET', pattern: '/api/madre/activity', handler: async (request) => json(200, { items: await madre.recentAudit(limit(request, 60, 300)) }) },

    {
      method: 'POST',
      pattern: '/api/madre/compile',
      handler: async (request) => {
        const body = bodyObject(request.body);
        const issues: FieldIssue[] = [];
        const prompt = text(body, 'prompt', 4000, issues);
        if (issues.length > 0 || prompt === undefined) throw new ValidationError(issues);
        return json(200, await madre.compile(prompt));
      },
    },

    {
      method: 'GET',
      pattern: '/api/madre/memory',
      handler: async (request) => {
        const q = request.query['q']?.trim();
        const type = request.query['type'];
        if (type !== undefined && !MEMORY_TYPES.includes(type as MemoryType)) throw new ValidationError([{ path: 'type', message: `Debe ser uno de estos valores: ${MEMORY_TYPES.join(', ')}.` }]);
        const max = limit(request, 100, 300);
        const [stats, items] = await Promise.all([
          madre.memoryStats(),
          q !== undefined && q !== ''
            ? madre.recall({ query: q, ...(type !== undefined ? { type: type as MemoryType } : {}), limit: max }).then((r) => r.map((x) => x.entry))
            : madre.listMemory({ ...(type !== undefined ? { type: type as MemoryType } : {}), limit: max }),
        ]);
        return json(200, { items, stats });
      },
    },

    {
      method: 'POST',
      pattern: '/api/madre/memory',
      handler: async (request) => {
        const body = bodyObject(request.body);
        const issues: FieldIssue[] = [];
        const title = text(body, 'title', 160, issues);
        const content = text(body, 'content', 8000, issues);
        const type = (body['type'] ?? 'user_context') as MemoryType;
        const scope = (body['scope'] ?? 'user') as MemoryScope;
        if (!MEMORY_TYPES.includes(type)) issues.push({ path: 'type', message: `Debe ser uno de estos valores: ${MEMORY_TYPES.join(', ')}.` });
        if (!MEMORY_SCOPES.includes(scope)) issues.push({ path: 'scope', message: `Debe ser uno de estos valores: ${MEMORY_SCOPES.join(', ')}.` });
        const ref = text(body, 'ref', 500, issues, false);
        if (issues.length > 0 || title === undefined || content === undefined) throw new ValidationError(issues);
        const outcome = await madre.remember({ type, scope, title, content, ref: ref ?? null });
        return json(201, outcome);
      },
    },

    {
      method: 'DELETE',
      pattern: '/api/madre/memory/:id',
      handler: async (_request, params) => {
        const removed = await madre.forget(param(params, 'id'));
        if (!removed) throw new DomainError('not_found', 'No se encontró la entrada de memoria.', { status: 404 });
        return json(200, { deleted: true });
      },
    },

    {
      method: 'GET',
      pattern: '/api/madre/budget',
      handler: async () => json(200, { budget: madre.budget(), cost: await madre.costSummary() }),
    },

    {
      method: 'PATCH',
      pattern: '/api/madre/budget',
      handler: async (request) => {
        const body = bodyObject(request.body);
        const issues: FieldIssue[] = [];
        const current = madre.budget();
        const perMissionUsd = money(body, 'perMissionUsd', issues);
        const dailyUsd = money(body, 'dailyUsd', issues);
        const monthlyUsd = money(body, 'monthlyUsd', issues);
        let onExceed = current.onExceed;
        if ('onExceed' in body) {
          if (typeof body['onExceed'] === 'string' && (ON_EXCEED as readonly string[]).includes(body['onExceed'])) onExceed = body['onExceed'] as Budget['onExceed'];
          else issues.push({ path: 'onExceed', message: `Debe ser uno de estos valores: ${ON_EXCEED.join(', ')}.` });
        }
        if (issues.length > 0) throw new ValidationError(issues);
        madre.setBudget({
          ...current,
          ...(perMissionUsd !== undefined ? { perMissionUsd } : {}),
          ...(dailyUsd !== undefined ? { dailyUsd } : {}),
          ...(monthlyUsd !== undefined ? { monthlyUsd } : {}),
          onExceed,
        });
        return json(200, { budget: madre.budget() });
      },
    },

    { method: 'GET', pattern: '/api/madre/approvals', handler: async () => json(200, { items: await madre.pendingApprovals() }) },

    ...(['approve', 'deny'] as const).map(
      (verb): Route => ({
        method: 'POST',
        pattern: `/api/madre/approvals/:id/${verb}`,
        handler: async (request, params) => {
          const body = request.body === undefined || request.body === null ? {} : bodyObject(request.body);
          const issues: FieldIssue[] = [];
          const note = text(body, 'note', 8000, issues, false);
          if (issues.length > 0) throw new ValidationError(issues);
          const approval = await guarded(() => madre.decide(param(params, 'id'), verb === 'approve' ? 'approved' : 'denied', note ?? null));
          return json(200, { approval });
        },
      }),
    ),

    {
      method: 'GET',
      pattern: '/api/missions/:id/madre',
      handler: async (_request, params) => json(200, await guarded(() => madre.snapshot(param(params, 'id')))),
    },

    {
      method: 'GET',
      pattern: '/api/missions/:id/trace',
      handler: async (_request, params) => json(200, { trace: await guarded(() => madre.trace(param(params, 'id'))) }),
    },

    {
      // A real probe, so it is a POST: it reaches out to each provider.
      method: 'POST',
      pattern: '/api/madre/providers/health',
      handler: async () => json(200, { items: await madre.checkProviderHealth() }),
    },

    {
      method: 'POST',
      pattern: '/api/missions/:id/cancel',
      handler: async (_request, params) => {
        const cancelled = await guarded(() => madre.cancel(param(params, 'id')));
        return json(200, { cancelled });
      },
    },
  ];
}
