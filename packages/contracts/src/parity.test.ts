/**
 * Contract parity.
 *
 * The server validates with the dependency-free validators in `@acc/domain`;
 * this package publishes Zod schemas for the OpenAPI document and the typed
 * client. That duplication is deliberate — it keeps Zod out of the domain — but
 * it is only safe if the two agree. These tests are the guard.
 *
 * Requires `pnpm install` (they import zod).
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  AGENT_CATALOG,
  AGENT_STATUSES,
  MISSION_STATUSES,
  PROMPT_MAX_LENGTH,
  PROMPT_MIN_LENGTH,
  ValidationError,
  parseCreateMissionInput,
  parseListMissionsQuery,
} from '@acc/domain';

import {
  agentIdSchema,
  agentStatusSchema,
  createMissionRequestSchema,
  listMissionsQuerySchema,
  missionStatusSchema,
} from './schemas.ts';
import { buildOpenApiDocument } from './openapi.ts';

describe('enum parity', () => {
  it('mission statuses match', () => {
    assert.deepEqual([...missionStatusSchema.options].sort(), [...MISSION_STATUSES].sort());
  });

  it('agent statuses match', () => {
    assert.deepEqual([...agentStatusSchema.options].sort(), [...AGENT_STATUSES].sort());
  });

  it('agent ids match the catalog', () => {
    assert.deepEqual([...agentIdSchema.options].sort(), AGENT_CATALOG.map((a) => a.id).sort());
  });
});

describe('createMission validation parity', () => {
  const cases: { label: string; body: unknown; valid: boolean }[] = [
    { label: 'a normal prompt', body: { prompt: 'Launch an online cookie store in Italy' }, valid: true },
    { label: 'exactly the minimum length', body: { prompt: 'a'.repeat(PROMPT_MIN_LENGTH) }, valid: true },
    { label: 'one character short', body: { prompt: 'a'.repeat(PROMPT_MIN_LENGTH - 1) }, valid: false },
    { label: 'over the maximum', body: { prompt: 'a'.repeat(PROMPT_MAX_LENGTH + 1) }, valid: false },
    { label: 'a missing prompt', body: {}, valid: false },
    { label: 'a non-string prompt', body: { prompt: 42 }, valid: false },
    {
      label: 'a valid prompt with options',
      body: { prompt: 'Launch an online cookie store', providerId: 'mock', autoStart: false },
      valid: true,
    },
    { label: 'a non-boolean autoStart', body: { prompt: 'Launch an online cookie store', autoStart: 'yes' }, valid: false },
  ];

  for (const testCase of cases) {
    it(`agrees on ${testCase.label}`, () => {
      const zodAccepts = createMissionRequestSchema.safeParse(testCase.body).success;

      let domainAccepts = true;
      try {
        parseCreateMissionInput(testCase.body);
      } catch (error) {
        assert.ok(error instanceof ValidationError);
        domainAccepts = false;
      }

      assert.equal(
        zodAccepts,
        domainAccepts,
        `zod=${zodAccepts} domain=${domainAccepts} for ${JSON.stringify(testCase.body)}`,
      );
      assert.equal(domainAccepts, testCase.valid);
    });
  }
});

describe('list query parity', () => {
  it('agrees on defaults', () => {
    const zod = listMissionsQuerySchema.parse({});
    const domain = parseListMissionsQuery({});
    assert.equal(zod.limit, domain.limit);
    assert.equal(zod.offset, domain.offset);
  });

  it('agrees on the limit bounds', () => {
    assert.equal(listMissionsQuerySchema.safeParse({ limit: 101 }).success, false);
    assert.throws(() => parseListMissionsQuery({ limit: '101' }), ValidationError);

    assert.equal(listMissionsQuerySchema.safeParse({ limit: 100 }).success, true);
    assert.equal(parseListMissionsQuery({ limit: '100' }).limit, 100);
  });

  it('agrees on an unknown status', () => {
    assert.equal(listMissionsQuerySchema.safeParse({ status: 'exploded' }).success, false);
    assert.throws(() => parseListMissionsQuery({ status: 'exploded' }), ValidationError);
  });
});

describe('OpenAPI document', () => {
  const doc = buildOpenApiDocument('0.1.0') as any;

  it('declares every implemented route', () => {
    assert.deepEqual(Object.keys(doc.paths).sort(), [
      '/api/agents',
      '/api/health',
      '/api/madre/activity',
      '/api/madre/agents',
      '/api/madre/approvals',
      '/api/madre/approvals/{id}/approve',
      '/api/madre/approvals/{id}/deny',
      '/api/madre/budget',
      '/api/madre/compile',
      '/api/madre/memory',
      '/api/madre/memory/{id}',
      '/api/madre/overview',
      '/api/madre/permissions',
      '/api/madre/providers',
      '/api/madre/providers/health',
      '/api/madre/tools',
      '/api/missions',
      '/api/missions/{id}',
      '/api/missions/{id}/cancel',
      '/api/missions/{id}/madre',
      '/api/missions/{id}/run',
      '/api/missions/{id}/trace',
      '/api/providers',
      '/api/stats',
    ]);
  });

  it('documents mission creation as asynchronous', () => {
    assert.ok(doc.paths['/api/missions'].post.responses['202']);
    assert.match(doc.paths['/api/missions'].post.description, /background/i);
  });

  it('resolves every $ref it emits', () => {
    const names = new Set(Object.keys(doc.components.schemas));
    const refs = [...JSON.stringify(doc).matchAll(/"#\/components\/schemas\/([A-Za-z]+)"/g)].map((m) => m[1]);
    for (const refName of refs) {
      assert.ok(refName !== undefined && names.has(refName), `dangling $ref: ${refName}`);
    }
  });
});

describe('OpenAPI vs the server routes', () => {
  it('every documented MADRE path is a route the server registers, and vice versa', async () => {
    const { madreRoutes } = await import('../../../apps/server/src/http/madre-routes.ts');
    const doc = buildOpenApiDocument('0.1.0') as any;
    const documented = new Set<string>();
    for (const [path, ops] of Object.entries<any>(doc.paths)) {
      if (!path.startsWith('/api/madre') && !/^\/api\/missions\/\{id\}\/(madre|cancel|trace)$/.test(path)) continue;
      for (const method of Object.keys(ops)) documented.add(`${method.toUpperCase()} ${path.replace(/\{(\w+)\}/g, ':$1')}`);
    }
    const registered = new Set((madreRoutes({} as never) as { method: string; pattern: string }[]).map((r) => `${r.method} ${r.pattern}`));
    assert.deepEqual([...registered].sort(), [...documented].sort());
  });

  it('accepts a mode on mission requests, matching the domain', () => {
    assert.equal(createMissionRequestSchema.safeParse({ prompt: 'Launch an online cookie store', mode: 'madre' }).success, true);
    assert.equal(createMissionRequestSchema.safeParse({ prompt: 'Launch an online cookie store', mode: 'turbo' }).success, false);
    assert.throws(() => parseCreateMissionInput({ prompt: 'Launch an online cookie store', mode: 'turbo' }), ValidationError);
  });
});
