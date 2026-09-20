import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { NO_BUDGET } from '../cost/controller.ts';
import { ANTHROPIC, MOCK, OLLAMA_MIXED, PLANNED_OPENAI, ScriptedRunner, createEngineHarness } from '../testing.ts';
import { buildWorldModel } from './builder.ts';

const build = (h: ReturnType<typeof createEngineHarness>) =>
  buildWorldModel({ missions: h.repos.missions, memory: h.memory, approvals: h.approvals, agents: h.agents, tools: h.tools, providers: h.catalog, policy: h.policy, cost: h.cost, clock: h.clock });

describe('world model', () => {
  it('describes an empty, simulation-only installation honestly', async () => {
    const h = createEngineHarness({ descriptors: [MOCK, PLANNED_OPENAI] });
    const w = await build(h);
    assert.equal(w.missions.total, 0);
    assert.equal(w.agents.active, 8);
    assert.ok(w.agents.planned >= 10);
    assert.deepEqual(w.resources.executableProviders, ['mock']);
    assert.ok(w.gaps.some((g) => /proveedor simulado/.test(g)));
    assert.ok(w.gaps.some((g) => /búsqueda web conectada/.test(g)));
    assert.ok(w.gaps.some((g) => /ejecución de código está desactivada/i.test(g)));
    assert.ok(w.gaps.some((g) => /no publicarlo/.test(g)));
    assert.ok(w.next.some((n) => /OLLAMA_BASE_URL/.test(n)));
    assert.ok(w.next.some((n) => /primera misión/.test(n)));
    assert.equal(w.providers.mock, 1);
    assert.equal(w.constraints.budget.onExceed, NO_BUDGET.onExceed);
    assert.equal(w.constraints.permissions.FINANCIAL, 'BLOCK');
    assert.equal(w.constraints.permissions.PUBLISH, 'ASK');
  });

  it('drops the "simulated" gap once a real provider exists and lists what it can do', async () => {
    const h = createEngineHarness({ descriptors: [OLLAMA_MIXED, ANTHROPIC] });
    const w = await build(h);
    assert.ok(!w.gaps.some((g) => /proveedor simulado/.test(g)));
    assert.ok(!w.next.some((n) => /OLLAMA_BASE_URL/.test(n)));
    assert.ok(w.canDo.some((c) => /Ollama/.test(c) && /Anthropic/.test(c)));
    assert.equal(w.providers.local, 1);
    assert.equal(w.providers.connected, 1);
  });

  it('reflects missions, waiting approvals and memory', async () => {
    const h = createEngineHarness({ runner: new ScriptedRunner() });
    await h.memory.remember({ type: 'preference', title: 'Tone', content: 'Prefers short answers.', origin: 'user', scope: 'user' });
    await h.memory.remember({ type: 'project_context', title: 'Shop', content: 'Cookie shop.', origin: 'user', scope: 'project' });
    const { runId } = await h.startRun('Analiza estos documentos y dime las acciones prioritarias.');
    await h.engine.execute({ runId });
    const w = await build(h);
    assert.equal(w.missions.total, 1);
    assert.equal(w.missions.waiting, 1);
    assert.equal(w.goals[0]?.status, 'waiting');
    assert.deepEqual(w.user.preferences, ['Prefers short answers.']);
    assert.equal(w.projects.entries, 1);
    assert.equal(w.knowledge.entries, 2);
    assert.ok(w.next.some((n) => /aprobación pendiente|aprobaciones pendientes/.test(n)));
  });
});
