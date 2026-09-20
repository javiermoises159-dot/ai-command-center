import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { CostController } from '../cost/controller.ts';
import { PermissionPolicy } from '../permissions/policy.ts';
import { MemoryService } from '../memory/service.ts';
import { ToolRegistry, createToolRegistry } from '../registry/tools.ts';
import { validateToolInput } from '../registry/validation.ts';
import { createHarness } from '../testing.ts';
import type { Budget, ToolRequest, ToolResult, ToolSpec } from '../types.ts';
import { LocalToolExecutor, type ToolContext, type ToolExecutor } from './executor.ts';
import { ToolPipeline, type ToolCall } from './pipeline.ts';

/** A registry with the real catalog plus a few purpose-built tools. */
function registryWith(extra: Partial<ToolSpec>[] = []): ToolRegistry {
  const registry = createToolRegistry();
  const base = registry.require('memory.recall');
  for (const spec of extra) {
    registry.register({ ...structuredClone(base), id: 'test.tool', name: 'Herramienta de prueba', version: '1.0.0', ...spec } as ToolSpec);
  }
  return registry;
}

class SpyExecutor implements ToolExecutor {
  readonly calls: ToolRequest[] = [];
  constructor(
    private readonly behaviour: (request: ToolRequest, context: ToolContext) => Promise<ToolResult> | ToolResult = (request) => ({
      toolId: request.toolId,
      requestId: request.id,
      ok: true,
      output: { done: true },
      error: null,
      verified: false,
    }),
    private readonly implemented: (id: string) => boolean = () => true,
  ) {}
  canRun(toolId: string): boolean {
    return this.implemented(toolId);
  }
  async execute(request: ToolRequest, context: ToolContext): Promise<ToolResult> {
    this.calls.push(request);
    return this.behaviour(request, context);
  }
}

function setup(options: { tools?: ToolRegistry; executor?: ToolExecutor; budget?: Budget; overrides?: ConstructorParameters<typeof PermissionPolicy>[0] } = {}) {
  const { store, audit, clock } = createHarness();
  const tools = options.tools ?? createToolRegistry();
  const cost = new CostController(store, options.budget);
  const memory = new MemoryService(store);
  const executor = options.executor ?? new SpyExecutor();
  const pipeline = new ToolPipeline({ tools, policy: new PermissionPolicy(options.overrides), cost, audit, executor });
  let n = 0;
  const call = (toolId: string, input: Record<string, unknown>, more: Partial<ToolRequest> & { approved?: boolean; signal?: AbortSignal } = {}): ToolCall => {
    const { approved, signal, ...request } = more;
    n += 1;
    return {
      request: { id: `r${n}`, toolId, purpose: 'prueba', input, permission: 'READ', required: false, ...request },
      missionId: 'm1',
      runId: 'run1',
      stepId: 's1',
      agentId: 'strategy',
      approved: approved ?? false,
      ...(signal === undefined ? {} : { signal }),
    };
  };
  const events = async (type?: string) => (await audit.forMission('m1')).filter((e) => type === undefined || e.type === type);
  return { pipeline, tools, cost, audit, store, memory, executor, clock, call, events };
}

const FREE_TOOL = { cost: { model: 'free' as const, note: '' }, status: 'AVAILABLE' as const };

describe('tool pipeline — input validation', () => {
  it('runs a call whose input satisfies the schema', async () => {
    const t = setup({ executor: undefined });
    await t.memory.remember({ type: 'fact', title: 'cookies', content: 'Las galletas de Turín', origin: 'user' });
    const real = new ToolPipeline({ tools: t.tools, policy: new PermissionPolicy(), cost: t.cost, audit: t.audit, executor: new LocalToolExecutor(t.tools, t.memory) });
    const result = await real.run(t.call('memory.recall', { query: 'cookies', limit: 3 }));
    assert.equal(result.ok, true, result.error ?? '');
    assert.ok(Array.isArray((result.output as { entries: unknown[] }).entries));
    assert.equal(result.stage ?? null, null);
  });

  it('refuses a call with a required field missing — before the tool runs', async () => {
    const executor = new SpyExecutor();
    const t = setup({ executor });
    const result = await t.pipeline.run(t.call('memory.recall', {}));
    assert.equal(result.ok, false);
    assert.equal(result.stage, 'validation');
    assert.equal(result.code, 'invalid_input');
    assert.match(result.error ?? '', /Falta el campo obligatorio «query»/);
    assert.equal(executor.calls.length, 0, 'the tool must not run on invalid input');
  });

  it('refuses a field of the wrong type', async () => {
    const executor = new SpyExecutor();
    const t = setup({ executor });
    const result = await t.pipeline.run(t.call('memory.recall', { query: 42 }));
    assert.equal(result.code, 'invalid_input');
    assert.match(result.error ?? '', /«query» debe ser un texto; se recibió un número/);
    assert.equal(executor.calls.length, 0);
  });

  it('refuses a field the schema does not declare, because the catalog schemas are strict', async () => {
    const executor = new SpyExecutor();
    const t = setup({ executor });
    const result = await t.pipeline.run(t.call('memory.recall', { query: 'x', quey: 'typo' }));
    assert.equal(result.code, 'invalid_input');
    assert.match(result.error ?? '', /«quey» no existe/);
    assert.equal(executor.calls.length, 0);
  });

  it('lets an undeclared field through only when the schema allows it', () => {
    const strict = createToolRegistry().require('memory.recall');
    assert.equal(validateToolInput(strict, { query: 'x', extra: 1 }).ok, false);
    const lenient = { ...strict, inputSchema: { fields: strict.inputSchema.fields } };
    assert.equal(validateToolInput(lenient, { query: 'x', extra: 1 }).ok, true);
  });

  it('refuses an input above the size ceiling', async () => {
    const executor = new SpyExecutor();
    const t = setup({ executor });
    const result = await t.pipeline.run(t.call('memory.recall', { query: 'x'.repeat(9_000) }));
    assert.equal(result.code, 'invalid_input');
    assert.match(result.error ?? '', /bytes/);
    assert.equal(executor.calls.length, 0);
  });
});

describe('tool pipeline — lookup, switch and availability', () => {
  it('refuses a tool that does not exist, and does not call it a disabled one', async () => {
    const executor = new SpyExecutor();
    const t = setup({ executor });
    const result = await t.pipeline.run(t.call('no.such.tool', { query: 'x' }));
    assert.equal(result.ok, false);
    assert.equal(result.stage, 'lookup');
    assert.equal(result.code, 'unknown_tool');
    assert.equal(executor.calls.length, 0);
  });

  it('refuses a disabled tool with the operator’s reason, and runs it again once re-enabled', async () => {
    const executor = new SpyExecutor();
    const t = setup({ executor });
    t.tools.disable('memory.recall', 'En mantenimiento');
    const refused = await t.pipeline.run(t.call('memory.recall', { query: 'x' }));
    assert.equal(refused.stage, 'enabled');
    assert.equal(refused.code, 'tool_disabled');
    assert.match(refused.error ?? '', /En mantenimiento/);
    assert.equal(executor.calls.length, 0);

    t.tools.enable('memory.recall');
    const ok = await t.pipeline.run(t.call('memory.recall', { query: 'x' }));
    assert.equal(ok.ok, true);
    assert.equal(executor.calls.length, 1);
  });

  it('refuses a tool that is declared but not connected, and says what its status is', async () => {
    const executor = new SpyExecutor();
    const t = setup({ executor });
    const result = await t.pipeline.run(t.call('web.search', { query: 'galletas' }));
    assert.equal(result.stage, 'availability');
    assert.equal(result.code, 'tool_unavailable');
    assert.match(result.error ?? '', /NOT_CONNECTED/);
    assert.equal(executor.calls.length, 0);
  });

  it('refuses a usable tool that has no implementation behind it', async () => {
    const executor = new SpyExecutor(undefined, () => false);
    const t = setup({ executor });
    const result = await t.pipeline.run(t.call('memory.recall', { query: 'x' }));
    assert.equal(result.stage, 'executor');
    assert.equal(result.code, 'no_executor');
    assert.equal(executor.calls.length, 0);
  });
});

describe('tool pipeline — permissions', () => {
  it('refuses an action the policy blocks, before anything else', async () => {
    const executor = new SpyExecutor();
    const t = setup({ executor });
    // EXECUTE is BLOCK by default. Even for a tool that does not exist.
    const result = await t.pipeline.run(t.call('memory.recall', { query: 'x' }, { permission: 'EXECUTE' }));
    assert.equal(result.stage, 'permission');
    assert.equal(result.code, 'permission_denied');
    assert.match(result.error ?? '', /EXECUTE/);
    assert.equal(executor.calls.length, 0);
    const blocked = await t.pipeline.run(t.call('no.such.tool', {}, { permission: 'FINANCIAL' }));
    assert.equal(blocked.code, 'permission_denied', 'permission is checked before lookup');
  });

  it('holds an ASK permission until a person has approved, then lets the call through', async () => {
    const executor = new SpyExecutor();
    const t = setup({ executor });
    const waiting = await t.pipeline.run(t.call('memory.recall', { query: 'x' }, { permission: 'DELETE' }));
    assert.equal(waiting.stage, 'permission');
    assert.equal(waiting.code, 'approval_required');
    assert.equal(executor.calls.length, 0);

    const approved = await t.pipeline.run(t.call('memory.recall', { query: 'x' }, { permission: 'DELETE', approved: true }));
    assert.equal(approved.ok, true);
    assert.equal(executor.calls.length, 1);
  });

  it('checks every permission the tool itself demands, not only the one the plan asked for', async () => {
    const tools = registryWith([{ id: 'test.exec', permissions: ['READ', 'EXECUTE'], ...FREE_TOOL }]);
    const executor = new SpyExecutor();
    const t = setup({ tools, executor });
    const result = await t.pipeline.run(t.call('test.exec', { query: 'x' }, { permission: 'READ' }));
    assert.equal(result.code, 'permission_denied');
    assert.equal(executor.calls.length, 0);
  });
});

describe('tool pipeline — limits and cost', () => {
  it('stops a tool at its per-run call limit', async () => {
    const tools = registryWith([{ id: 'test.limited', limits: { maxCallsPerRun: 2, maxInputBytes: null }, ...FREE_TOOL }]);
    const executor = new SpyExecutor();
    const t = setup({ tools, executor });
    assert.equal((await t.pipeline.run(t.call('test.limited', { query: 'a' }))).ok, true);
    assert.equal((await t.pipeline.run(t.call('test.limited', { query: 'b' }))).ok, true);
    const third = await t.pipeline.run(t.call('test.limited', { query: 'c' }));
    assert.equal(third.ok, false);
    assert.equal(third.stage, 'call_limit');
    assert.equal(third.code, 'call_limit_exceeded');
    assert.equal(executor.calls.length, 2);
  });

  it('refuses a tool with an unknown price the moment any budget is in force — it never assumes zero', async () => {
    const tools = registryWith([{ id: 'test.paid', cost: { model: 'per_call', note: 'sin precio conocido' }, status: 'AVAILABLE' }]);
    const executor = new SpyExecutor();
    const t = setup({ tools, executor, budget: { perMissionUsd: 5, dailyUsd: null, monthlyUsd: null, perAgentUsd: {}, perToolUsd: {}, alertAtFraction: 0.8, onExceed: 'block' } });
    const result = await t.pipeline.run(t.call('test.paid', { query: 'x' }));
    assert.equal(result.ok, false);
    assert.equal(result.stage, 'cost');
    assert.equal(result.code, 'cost_blocked');
    assert.match(result.error ?? '', /precio/);
    assert.equal(executor.calls.length, 0);
    assert.equal((await t.cost.summary({ runId: 'run1' })).calls, 0, 'a refused call is not a call');
  });

  it('lets an unpriced tool run when no budget is in force, and records it as unpriced', async () => {
    const tools = registryWith([{ id: 'test.paid', cost: { model: 'per_call', note: '' }, status: 'AVAILABLE' }]);
    const executor = new SpyExecutor();
    const t = setup({ tools, executor });
    const result = await t.pipeline.run(t.call('test.paid', { query: 'x' }));
    assert.equal(result.ok, true);
    const summary = await t.cost.summary({ runId: 'run1' });
    assert.equal(summary.byTool['test.paid']?.calls, 1);
    assert.equal(summary.unpricedCalls, 1, 'the ledger must say the price is unknown, not zero');
  });

  it('applies the per-tool ceiling — the tool id reaches the cost controller', async () => {
    const executor = new SpyExecutor();
    const budget: Budget = { perMissionUsd: null, dailyUsd: null, monthlyUsd: null, perAgentUsd: {}, perToolUsd: { 'memory.recall': 0.4 }, alertAtFraction: 0.8, onExceed: 'block' };
    const t = setup({ executor, budget });
    // The ledger already shows this tool cost 0.5 USD on this mission.
    await t.cost.record({ missionId: 'm1', runId: 'run0', kind: 'tool', provider: 'memory.recall', actualUsd: 0.5 });
    const result = await t.pipeline.run(t.call('memory.recall', { query: 'x' }));
    assert.equal(result.stage, 'cost');
    assert.match(result.error ?? '', /presupuesto de la herramienta memory\.recall/);
    assert.equal(executor.calls.length, 0);

    // A tool with no ceiling of its own is untouched by that one.
    const other = setup({ executor, budget: { ...budget, perToolUsd: { 'other.tool': 0.4 } } });
    await other.cost.record({ missionId: 'm1', runId: 'run0', kind: 'tool', provider: 'memory.recall', actualUsd: 0.5 });
    assert.equal((await other.pipeline.run(other.call('memory.recall', { query: 'x' }))).ok, true);
  });

  it('warns in the audit log when a call brings a tool close to its ceiling', async () => {
    const executor = new SpyExecutor();
    const budget: Budget = { perMissionUsd: null, dailyUsd: null, monthlyUsd: null, perAgentUsd: {}, perToolUsd: { 'memory.recall': 1 }, alertAtFraction: 0.8, onExceed: 'block' };
    const t = setup({ executor, budget });
    await t.cost.record({ missionId: 'm1', runId: 'run0', kind: 'tool', provider: 'memory.recall', actualUsd: 0.9 });
    assert.equal((await t.pipeline.run(t.call('memory.recall', { query: 'x' }))).ok, true);
    const alerts = await t.events('cost.alert');
    assert.equal(alerts.length, 1);
    assert.match(alerts[0]!.message, /memory\.recall/);
  });
});

describe('tool pipeline — execution', () => {
  it('turns a tool that hangs into a timeout, using the tool’s own limit', async () => {
    const tools = registryWith([{ id: 'test.slow', timeoutMs: 25, ...FREE_TOOL }]);
    const executor = new SpyExecutor(() => new Promise(() => undefined));
    const t = setup({ tools, executor });
    const started = Date.now();
    const result = await t.pipeline.run(t.call('test.slow', { query: 'x' }));
    assert.equal(result.ok, false);
    assert.equal(result.stage, 'execution');
    assert.equal(result.code, 'timeout');
    assert.ok(Date.now() - started < 2_000);
  });

  it('turns a throwing tool into a structured error instead of an exception', async () => {
    const executor = new SpyExecutor(() => {
      throw 'not even an Error';
    });
    const t = setup({ executor });
    const result = await t.pipeline.run(t.call('memory.recall', { query: 'x' }));
    assert.equal(result.ok, false);
    assert.equal(result.code, 'execution_error');
    assert.match(result.error ?? '', /not even an Error/);
  });

  it('stops promptly when the caller cancels', async () => {
    const executor = new SpyExecutor(() => new Promise(() => undefined));
    const t = setup({ executor });
    const controller = new AbortController();
    const running = t.pipeline.run(t.call('memory.recall', { query: 'x' }, { signal: controller.signal }));
    setTimeout(() => controller.abort(), 10);
    const result = await running;
    assert.equal(result.code, 'cancelled');
  });

  it('records what ran and what was refused, and only what ran costs a call', async () => {
    const executor = new SpyExecutor();
    const t = setup({ executor });
    await t.pipeline.run(t.call('memory.recall', { query: 'x' }));
    await t.pipeline.run(t.call('memory.recall', {}));
    await t.pipeline.run(t.call('no.such.tool', {}));

    const executed = await t.events('tool.executed');
    const refused = await t.events('tool.refused');
    assert.equal(executed.length, 1);
    assert.equal(refused.length, 2);
    assert.deepEqual(refused.map((e) => (e.data as { code: string }).code).sort(), ['invalid_input', 'unknown_tool']);
    assert.ok(refused.every((e) => e.stepId === 's1' && e.runId === 'run1'));
    assert.equal((await t.cost.summary({ runId: 'run1' })).byTool['memory.recall']?.calls, 1);
  });
});
