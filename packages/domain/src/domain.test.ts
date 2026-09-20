import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { canTransitionAgent, canTransitionRun, countAgents, runProgress } from './types.ts';
import type { AgentExecution } from './types.ts';
import { deriveTitle } from './ids.ts';
import {
  PROMPT_MIN_LENGTH,
  parseCreateMissionInput,
  parseListMissionsQuery,
  parseMockDirectives,
  parseRunMissionInput,
} from './validation.ts';
import { ValidationError } from './errors.ts';
import { AGENT_CATALOG, integratorAgent, pipelineOrder, qaAgent, workerAgents } from './agents.ts';

function agent(partial: Partial<AgentExecution>): AgentExecution {
  return {
    id: 'a',
    missionId: 'm',
    runId: 'r',
    agentId: 'strategy',
    name: 'Strategy',
    orderIndex: 0,
    status: 'pending',
    task: 'task',
    result: null,
    error: null,
    usage: null,
    startedAt: null,
    completedAt: null,
    ...partial,
  };
}

describe('agent catalog', () => {
  it('contains the eight declared agents in pipeline order', () => {
    assert.deepEqual(
      pipelineOrder().map((a) => a.id),
      ['strategy', 'research', 'code', 'design', 'marketing', 'finance', 'qa', 'integrator'],
    );
  });

  it('has exactly one QA and one integrator, and they run last', () => {
    assert.equal(AGENT_CATALOG.filter((a) => a.kind === 'qa').length, 1);
    assert.equal(AGENT_CATALOG.filter((a) => a.kind === 'integrator').length, 1);
    assert.equal(workerAgents().length, 6);

    const order = pipelineOrder();
    assert.equal(order.at(-2)?.id, qaAgent().id);
    assert.equal(order.at(-1)?.id, integratorAgent().id);
  });

  it('uses unique ids and orders', () => {
    assert.equal(new Set(AGENT_CATALOG.map((a) => a.id)).size, AGENT_CATALOG.length);
    assert.equal(new Set(AGENT_CATALOG.map((a) => a.order)).size, AGENT_CATALOG.length);
  });
});

describe('state machine', () => {
  it('permits the documented agent transitions only', () => {
    assert.ok(canTransitionAgent('pending', 'running'));
    assert.ok(canTransitionAgent('pending', 'skipped'));
    assert.ok(canTransitionAgent('running', 'completed'));
    assert.ok(canTransitionAgent('running', 'failed'));

    assert.ok(!canTransitionAgent('completed', 'running'));
    assert.ok(!canTransitionAgent('failed', 'completed'));
    assert.ok(!canTransitionAgent('pending', 'completed'), 'an agent cannot complete without running');
    assert.ok(!canTransitionAgent('skipped', 'running'));
  });

  it('permits the documented run transitions only', () => {
    assert.ok(canTransitionRun('pending', 'running'));
    assert.ok(canTransitionRun('running', 'completed'));
    assert.ok(!canTransitionRun('completed', 'failed'));
    assert.ok(!canTransitionRun('pending', 'completed'));
  });
});

describe('progress helpers', () => {
  it('counts skipped agents as settled so an aborted run reaches 100%', () => {
    const agents = [
      agent({ status: 'completed' }),
      agent({ status: 'failed' }),
      agent({ status: 'skipped' }),
      agent({ status: 'skipped' }),
    ];
    assert.equal(runProgress(agents), 1);
  });

  it('reports partial progress while agents are pending', () => {
    assert.equal(runProgress([agent({ status: 'completed' }), agent({ status: 'pending' })]), 0.5);
    assert.equal(runProgress([]), 0);
  });

  it('tallies agents by status', () => {
    const counts = countAgents([agent({ status: 'completed' }), agent({ status: 'completed' }), agent({})]);
    assert.equal(counts.completed, 2);
    assert.equal(counts.pending, 1);
    assert.equal(counts.failed, 0);
  });
});

describe('deriveTitle', () => {
  it('strips mock directives so they never reach the UI', () => {
    assert.equal(
      deriveTitle('Launch an online cookie store in Italy [fail:marketing]'),
      'Launch an online cookie store in Italy',
    );
  });

  it('cuts at the first sentence boundary when there is an early one', () => {
    assert.equal(deriveTitle('Open a bakery. Then expand to three cities.'), 'Open a bakery');
  });

  it('truncates long prompts on a word boundary', () => {
    const title = deriveTitle('word '.repeat(60));
    assert.ok(title.length <= 81, `title was ${title.length} chars`);
    assert.ok(title.endsWith('…'));
  });

  it('never returns an empty string', () => {
    assert.equal(deriveTitle('   '), 'Misión sin título');
    assert.equal(deriveTitle('[fail:qa]'), 'Misión sin título');
  });
});

describe('parseCreateMissionInput', () => {
  it('accepts a valid payload and defaults autoStart to true', () => {
    const input = parseCreateMissionInput({ prompt: '  Launch a cookie store in Italy  ' });
    assert.equal(input.prompt, 'Launch a cookie store in Italy');
    assert.equal(input.autoStart, true);
    assert.equal(input.providerId, undefined);
  });

  it('rejects a prompt that is too short, naming the field', () => {
    try {
      parseCreateMissionInput({ prompt: 'too short' });
      assert.fail('expected a ValidationError');
    } catch (error) {
      assert.ok(error instanceof ValidationError);
      assert.equal(error.status, 400);
      assert.equal(error.issues[0]?.path, 'prompt');
      assert.match(error.issues[0]?.message ?? '', new RegExp(String(PROMPT_MIN_LENGTH)));
    }
  });

  it('rejects a non-object body', () => {
    assert.throws(() => parseCreateMissionInput('nope'), ValidationError);
    assert.throws(() => parseCreateMissionInput(null), ValidationError);
    assert.throws(() => parseCreateMissionInput([1, 2]), ValidationError);
  });

  it('collects every issue at once rather than failing on the first', () => {
    try {
      parseCreateMissionInput({ prompt: 'x', autoStart: 'yes', providerId: 42 });
      assert.fail('expected a ValidationError');
    } catch (error) {
      assert.ok(error instanceof ValidationError);
      assert.equal(error.issues.length, 3);
    }
  });

  it('treats empty optional strings as absent', () => {
    const input = parseCreateMissionInput({ prompt: 'Launch a cookie store', providerId: '', model: '   ' });
    assert.equal(input.providerId, undefined);
    assert.equal(input.model, undefined);
  });
});

describe('parseRunMissionInput', () => {
  it('accepts an empty body', () => {
    assert.deepEqual(parseRunMissionInput(undefined), {});
    assert.deepEqual(parseRunMissionInput({}), {});
  });

  it('passes through a provider override', () => {
    assert.deepEqual(parseRunMissionInput({ providerId: 'mock' }), { providerId: 'mock' });
  });
});

describe('parseListMissionsQuery', () => {
  it('applies defaults', () => {
    assert.deepEqual(parseListMissionsQuery({}), { limit: 20, offset: 0 });
  });

  it('rejects an out-of-range limit and an unknown status', () => {
    assert.throws(() => parseListMissionsQuery({ limit: '5000' }), ValidationError);
    assert.throws(() => parseListMissionsQuery({ status: 'exploded' }), ValidationError);
  });

  it('accepts a known status', () => {
    assert.equal(parseListMissionsQuery({ status: 'running' }).status, 'running');
  });
});

describe('parseMockDirectives', () => {
  it('extracts one or many failing agents', () => {
    assert.deepEqual([...parseMockDirectives('do a thing [fail:marketing]').failingAgents], ['marketing']);
    assert.deepEqual(
      [...parseMockDirectives('[fail:qa] and [fail:finance]').failingAgents].sort(),
      ['finance', 'qa'],
    );
  });

  it('extracts a latency override', () => {
    assert.equal(parseMockDirectives('go [slow:1500]').latencyMs, 1500);
    assert.equal(parseMockDirectives('go').latencyMs, undefined);
  });

  it('finds nothing in a clean prompt', () => {
    assert.equal(parseMockDirectives('Launch a cookie store in Italy').failingAgents.size, 0);
  });
});
