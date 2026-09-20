import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { PermissionPolicy } from '../permissions/policy.ts';
import {
  NotConnectedDriver,
  chooseInterface,
  permissionForAction,
  runComputerUseLoop,
  type ComputerDriver,
  type Observation,
  type UiAction,
  type UiPlanner,
} from './loop.ts';

class FakeDriver implements ComputerDriver {
  readonly id = 'fake';
  readonly connected = true;
  readonly actions: UiAction[] = [];
  constructor(private screen: (actions: UiAction[]) => string) {}
  observe(): Promise<Observation> {
    return Promise.resolve({ text: this.screen(this.actions), location: 'https://example.test/', at: '2026-09-19T00:00:00Z' });
  }
  act(action: UiAction): Promise<void> {
    this.actions.push(action);
    return Promise.resolve();
  }
}

const planner = (steps: (UiAction | { kind: 'done'; summary: string } | { kind: 'give_up'; reason: string })[]): UiPlanner & { recoveringSeen: boolean[] } => {
  let i = 0;
  const recoveringSeen: boolean[] = [];
  return {
    recoveringSeen,
    next: ({ recovering }) => {
      recoveringSeen.push(recovering);
      return Promise.resolve(steps[Math.min(i++, steps.length - 1)]!);
    },
  };
};

const allow = async () => true;
const policy = new PermissionPolicy();
const instant = { wait: async () => undefined };

describe('computer use — interface choice', () => {
  const base = { apiTools: [], surface: 'web' as const, platform: null, automationAttested: [], driverConnected: true };
  it('prefers an API whenever one exists', () => {
    const c = chooseInterface({ ...base, apiTools: ['github.api'] });
    assert.deepEqual(c, { via: 'api', toolId: 'github.api', reason: c.reason });
  });
  it('refuses to automate a platform the operator has not attested', () => {
    assert.equal(chooseInterface({ ...base, platform: 'SomeSite' }).via, 'none');
    assert.equal(chooseInterface({ ...base, platform: 'SomeSite', automationAttested: ['somesite'] }).via, 'browser');
  });
  it('says so when no driver is connected', () => {
    const c = chooseInterface({ ...base, driverConnected: false });
    assert.equal(c.via, 'none');
    assert.match(c.reason, /No hay ningún controlador de uso del ordenador/);
  });
  it('uses the desktop surface for desktop apps', () => {
    assert.equal(chooseInterface({ ...base, surface: 'desktop' }).via, 'desktop');
  });
});

describe('computer use — action risk', () => {
  it('classifies actions by what they could do', () => {
    assert.equal(permissionForAction({ kind: 'navigate', target: 'https://x.test' }).level, 'READ');
    assert.equal(permissionForAction({ kind: 'read', target: 'price' }).level, 'READ');
    assert.equal(permissionForAction({ kind: 'click', target: 'Next' }).level, 'EXTERNAL_ACTION');
    assert.equal(permissionForAction({ kind: 'click', target: 'Place order' }).level, 'FINANCIAL');
    assert.equal(permissionForAction({ kind: 'click', target: 'Publish post' }).level, 'PUBLISH');
    assert.equal(permissionForAction({ kind: 'click', target: 'Delete account' }).level, 'DELETE');
    assert.equal(permissionForAction({ kind: 'type', target: 'card field', text: 'pay now' }).level, 'FINANCIAL');
  });
});

describe('computer use — loop', () => {
  it('refuses to start without a connected driver', async () => {
    const r = await runComputerUseLoop({ driver: new NotConnectedDriver(), planner: planner([]), verify: () => false, policy }, { goal: 'x' });
    assert.equal(r.status, 'refused');
    assert.match(r.summary, /No hay ningún controlador de uso del ordenador/);
  });

  it('observes, acts, observes again and stops when the goal is verified on screen', async () => {
    const driver = new FakeDriver((a) => (a.length >= 2 ? 'Welcome, you are signed in' : 'Login page'));
    const r = await runComputerUseLoop(
      { driver, planner: planner([{ kind: 'click', target: 'Sign in' }, { kind: 'click', target: 'Continue' }]), verify: (o) => /signed in/.test(o.text), policy, approve: allow, ...instant },
      { goal: 'sign in' },
    );
    assert.equal(r.status, 'done');
    assert.equal(driver.actions.length, 2);
    assert.deepEqual([...new Set(r.trace.map((t) => t.phase))].sort(), ['act', 'observe', 'plan', 'verify']);
  });

  it('does not believe the planner when the screen disagrees', async () => {
    const driver = new FakeDriver(() => 'Login page');
    const r = await runComputerUseLoop(
      { driver, planner: planner([{ kind: 'done', summary: 'All done!' }]), verify: () => false, policy, approve: allow, ...instant },
      { goal: 'sign in', maxRecoveries: 1 },
    );
    assert.equal(r.status, 'gave_up');
    assert.ok(r.trace.some((t) => /la pantalla no muestra el objetivo/.test(t.detail)));
  });

  it('detects a screen that never changes, tries to recover, then gives up', async () => {
    const driver = new FakeDriver(() => 'Same page');
    const p = planner([{ kind: 'scroll', direction: 'down' }]);
    const r = await runComputerUseLoop({ driver, planner: p, verify: () => false, policy, approve: allow, ...instant }, { goal: 'x', stuckAfter: 2, maxRecoveries: 2, maxSteps: 50 });
    assert.equal(r.status, 'gave_up');
    assert.ok(p.recoveringSeen.some(Boolean), 'the planner was told it was recovering');
    assert.ok(r.steps < 20, 'stuck detection ended the loop early');
  });

  it('stops at the step limit', async () => {
    let n = 0;
    const driver = new FakeDriver(() => `page ${n++}`);
    const r = await runComputerUseLoop({ driver, planner: planner([{ kind: 'scroll', direction: 'down' }]), verify: () => false, policy, approve: allow, ...instant }, { goal: 'x', maxSteps: 4 });
    assert.equal(r.status, 'step_limit');
    assert.equal(r.steps, 4);
  });

  it('will not click or type without approval, and blocks money outright', async () => {
    const d1 = new FakeDriver(() => 'page');
    const asked = await runComputerUseLoop({ driver: d1, planner: planner([{ kind: 'click', target: 'Next' }]), verify: () => false, policy }, { goal: 'x' });
    assert.equal(asked.status, 'refused');
    assert.equal(d1.actions.length, 0);

    const d2 = new FakeDriver(() => 'page');
    const money = await runComputerUseLoop({ driver: d2, planner: planner([{ kind: 'click', target: 'Place order' }]), verify: () => false, policy, approve: allow }, { goal: 'x' });
    assert.equal(money.status, 'refused');
    assert.equal(d2.actions.length, 0, 'financial actions are blocked even when an approver would say yes');
  });

  it('allows reads without asking', async () => {
    const driver = new FakeDriver((a) => (a.length > 0 ? 'done' : 'start'));
    const r = await runComputerUseLoop({ driver, planner: planner([{ kind: 'read', target: 'headline' }]), verify: (o) => o.text === 'done', policy }, { goal: 'x' });
    assert.equal(r.status, 'done');
  });

  it('reports driver errors and honours abort', async () => {
    const failing: ComputerDriver = { id: 'f', connected: true, observe: () => Promise.reject(new Error('browser crashed')), act: () => Promise.resolve() };
    const r = await runComputerUseLoop({ driver: failing, planner: planner([]), verify: () => false, policy }, { goal: 'x' });
    assert.equal(r.status, 'error');
    assert.match(r.summary, /browser crashed/);

    const c = new AbortController();
    c.abort();
    const a = await runComputerUseLoop({ driver: new FakeDriver(() => 'p'), planner: planner([]), verify: () => false, policy }, { goal: 'x', signal: c.signal });
    assert.equal(a.status, 'aborted');
  });
});
