import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { AgentExecution, MissionDetail, RunDetail } from '@acc/contracts';

import { buildActivity, matchesGroup } from './activity.ts';
import { deriveCrewState } from './crew.ts';
import { excerpt } from './format.ts';

const T = (seconds: number): string => new Date(Date.UTC(2026, 0, 1, 10, 0, seconds)).toISOString();

function agent(over: Partial<AgentExecution> & Pick<AgentExecution, 'id' | 'agentId' | 'orderIndex' | 'status'>): AgentExecution {
  return {
    missionId: 'm1',
    runId: 'r1',
    name: over.agentId,
    task: 't',
    result: null,
    error: null,
    usage: null,
    startedAt: null,
    completedAt: null,
    durationMs: null,
    ...over,
  };
}

function run(over: Partial<RunDetail> & Pick<RunDetail, 'id' | 'attempt' | 'status' | 'agents'>): RunDetail {
  return {
    missionId: 'm1',
    providerId: 'mock',
    model: 'mock-1',
    finalResult: null,
    error: null,
    createdAt: T(0),
    startedAt: null,
    completedAt: null,
    progress: 0,
    ...over,
  };
}

function mission(runs: RunDetail[], over: Partial<MissionDetail> = {}): MissionDetail {
  return {
    id: 'm1',
    prompt: 'Lanzar una tienda de cookies',
    title: 'Lanzar una tienda de cookies',
    status: 'failed',
    finalResult: null,
    createdAt: T(0),
    updatedAt: T(30),
    runs,
    ...over,
  };
}

/** One run: strategy done, research failed, code skipped. */
const failedMission = mission([
  run({
    id: 'r1',
    attempt: 1,
    status: 'failed',
    startedAt: T(1),
    completedAt: T(20),
    error: 'boom',
    agents: [
      agent({ id: 'a1', agentId: 'strategy', orderIndex: 0, status: 'completed', startedAt: T(1), completedAt: T(5), durationMs: 4000 }),
      agent({ id: 'a2', agentId: 'research', orderIndex: 1, status: 'failed', startedAt: T(5), completedAt: T(9), error: 'timeout' }),
      agent({ id: 'a3', agentId: 'code', orderIndex: 2, status: 'skipped', completedAt: T(20) }),
      agent({ id: 'a4', agentId: 'design', orderIndex: 3, status: 'pending' }),
    ],
  }),
]);

describe('buildActivity', () => {
  it('derives events only from timestamps that exist', () => {
    const kinds = buildActivity([failedMission]).map((e) => e.kind);
    assert.deepEqual(kinds.sort(), [
      'agent_completed',
      'agent_failed',
      'agent_skipped',
      'agent_started',
      'agent_started',
      'mission_created',
      'run_failed',
      'run_started',
    ]);
    // The pending agent produced nothing.
    assert.equal(buildActivity([failedMission]).some((e) => e.agentName === 'design'), false);
  });

  it('is newest first and carries the failure message', () => {
    const events = buildActivity([failedMission]);
    assert.equal(events[0]?.kind, 'run_failed');
    assert.equal(events[0]?.detail, 'boom');
    assert.equal(events.find((e) => e.kind === 'agent_failed')?.detail, 'timeout');
    for (let i = 1; i < events.length; i += 1) {
      assert.ok(Date.parse(events[i - 1]!.at) >= Date.parse(events[i]!.at));
    }
  });

  it('orders events sharing one timestamp by their logical sequence', () => {
    // Agent 1 completes at T(5) exactly when agent 2 starts: the start is later.
    const events = buildActivity([failedMission]).filter((e) => e.at === T(5));
    assert.deepEqual(
      events.map((e) => `${e.kind}:${e.agentName}`),
      ['agent_started:research', 'agent_completed:strategy'],
    );
  });

  it('gives every event a unique, stable id', () => {
    const ids = buildActivity([failedMission]).map((e) => e.id);
    assert.equal(new Set(ids).size, ids.length);
    assert.deepEqual(ids, buildActivity([failedMission]).map((e) => e.id));
  });

  it('merges several missions and several runs into one timeline', () => {
    const second = mission(
      [run({ id: 'r9', missionId: 'm2', attempt: 1, status: 'completed', startedAt: T(100), completedAt: T(110), agents: [] })],
      { id: 'm2', title: 'Segunda misión', status: 'completed', createdAt: T(99) },
    );
    const events = buildActivity([failedMission, second]);
    assert.equal(events[0]?.missionId, 'm2');
    assert.equal(events[0]?.kind, 'run_completed');
    assert.equal(new Set(events.map((e) => e.missionId)).size, 2);
  });

  it('filters by group', () => {
    const events = buildActivity([failedMission]);
    assert.equal(events.filter((e) => matchesGroup(e.kind, 'failures')).length, 2);
    assert.equal(events.filter((e) => matchesGroup(e.kind, 'agents')).length, 5);
    assert.equal(events.filter((e) => matchesGroup(e.kind, 'runs')).length, 3);
    assert.equal(events.filter((e) => matchesGroup(e.kind, 'all')).length, events.length);
  });

  it('returns nothing for no missions', () => {
    assert.deepEqual(buildActivity([]), []);
  });
});

describe('deriveCrewState', () => {
  it('counts outcomes and averages only completed durations', () => {
    const crew = deriveCrewState([failedMission]);
    assert.equal(crew.get('strategy')?.completed, 1);
    assert.equal(crew.get('strategy')?.avgDurationMs, 4000);
    assert.equal(crew.get('research')?.failed, 1);
    assert.equal(crew.get('research')?.avgDurationMs, null);
  });

  it('reports the agent currently working and where', () => {
    const live = mission(
      [
        run({
          id: 'r2',
          attempt: 1,
          status: 'running',
          startedAt: T(1),
          agents: [agent({ id: 'b1', agentId: 'design', orderIndex: 0, status: 'running', startedAt: T(2) })],
        }),
      ],
      { id: 'm3', title: 'Misión en curso', status: 'running' },
    );
    const crew = deriveCrewState([live]);
    assert.deepEqual(crew.get('design')?.working, { missionId: 'm3', missionTitle: 'Misión en curso' });
    assert.equal(crew.get('design')?.last?.status, 'running');
  });

  it('does not report an agent as working when its run already finished', () => {
    const stale = mission(
      [
        run({
          id: 'r9',
          attempt: 1,
          status: 'completed',
          startedAt: T(1),
          agents: [agent({ id: 'z1', agentId: 'design', orderIndex: 0, status: 'running', startedAt: T(2) })],
        }),
      ],
      { id: 'm9', status: 'completed' },
    );
    assert.equal(deriveCrewState([stale]).get('design')?.working, null);
  });

  it('ignores agents that never started when picking the last execution', () => {
    const crew = deriveCrewState([failedMission]);
    assert.equal(crew.get('design')?.last, null);
    assert.equal(crew.get('code')?.last, null);
    assert.equal(crew.get('research')?.last?.status, 'failed');
  });

  it('picks the most recent execution across runs', () => {
    const later = mission(
      [
        run({
          id: 'r5',
          attempt: 2,
          status: 'completed',
          startedAt: T(200),
          agents: [agent({ id: 'c1', agentId: 'strategy', orderIndex: 0, status: 'completed', startedAt: T(201), completedAt: T(205), durationMs: 2000 })],
        }),
        ...failedMission.runs,
      ],
      { id: 'm4' },
    );
    const crew = deriveCrewState([later]);
    assert.equal(crew.get('strategy')?.last?.at, T(201));
    assert.equal(crew.get('strategy')?.avgDurationMs, 3000);
  });
});

describe('excerpt', () => {
  it('skips headings, quotes and short lines and strips markdown', () => {
    const md = '# Título\n> aviso sobre la simulación\n\ncorto\n**Posicionamiento:** una oferta `nítida` para las panaderías de [Turín](https://x.io).\nmás';
    assert.equal(excerpt(md), 'Posicionamiento: una oferta nítida para las panaderías de Turín.');
  });

  it('truncates with an ellipsis and handles null', () => {
    assert.equal(excerpt(null), '');
    assert.equal(excerpt('a'.repeat(300), 20), `${'a'.repeat(19)}…`);
  });
});
