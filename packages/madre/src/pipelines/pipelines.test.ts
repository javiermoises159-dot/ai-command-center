import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { createAgentRegistry } from '../registry/agents.ts';
import { createToolRegistry } from '../registry/tools.ts';
import { PermissionPolicy } from '../permissions/policy.ts';
import { createDistributionAdapters, NotConnectedError, planContentPipeline } from './content.ts';
import { planFacelessFactory, COMPLIANCE_REQUIREMENTS } from './faceless.ts';
import { planMediaPipeline } from './media.ts';

const deps = () => ({ agents: createAgentRegistry(), tools: createToolRegistry(), policy: new PermissionPolicy() });

describe('content pipeline', () => {
  it('lists the ten stages in order', () => {
    const r = planContentPipeline(deps());
    assert.deepEqual(r.stages.map((s) => s.id), ['idea', 'research', 'script', 'visuals', 'voice', 'editing', 'qa', 'publish', 'analytics', 'iterate']);
  });

  it('reports publish and analytics as blocked while no channel is connected', () => {
    const r = planContentPipeline(deps());
    const publish = r.stages.find((s) => s.id === 'publish');
    assert.equal(publish?.status, 'blocked');
    assert.ok(publish?.missing.includes('distribution.tiktok'));
    assert.equal(publish?.needsApproval, true);
    assert.equal(r.stages.find((s) => s.id === 'analytics')?.status, 'blocked');
  });

  it('marks stages an active agent can only prepare as partial, not ready', () => {
    const r = planContentPipeline(deps());
    assert.equal(r.stages.find((s) => s.id === 'idea')?.status, 'ready');
    assert.equal(r.stages.find((s) => s.id === 'research')?.status, 'partial');
    assert.equal(r.stages.find((s) => s.id === 'visuals')?.status, 'partial');
    assert.match(r.summary, /pueden ejecutarse hoy/);
    assert.ok(!/\(s\)/.test(r.summary));
  });

  it('needs both an active agent and a connected tool, and publishing still asks for approval', () => {
    const d = deps();
    d.tools.setStatus('distribution.youtube', 'CONNECTED', 'test');
    assert.equal(planContentPipeline(d).stages.find((s) => s.id === 'publish')?.status, 'blocked'); // social agent not active
    d.agents.setStatus('social', 'active');
    const publish = planContentPipeline(d).stages.find((s) => s.id === 'publish');
    assert.equal(publish?.status, 'ready');
    assert.equal(publish?.needsApproval, true);
  });

  it('every adapter refuses and says NOT CONNECTED', async () => {
    const a = createDistributionAdapters();
    assert.equal(a.distribution.length, 3);
    for (const adapter of a.distribution) {
      assert.equal(adapter.connected, false);
      await assert.rejects(() => adapter.publish({ title: 't', body: 'b', mediaPaths: [] }), (e: unknown) => e instanceof NotConnectedError && e.adapterId === adapter.id && /SIN CONEXIÓN/.test(e.message));
    }
    for (const adapter of a.analytics) await assert.rejects(() => adapter.fetch('x'), NotConnectedError);
    for (const adapter of a.generation) await assert.rejects(() => adapter.generate('x'), NotConnectedError);
  });
});

describe('media pipeline', () => {
  it('is local first and blocked while the local tools are only planned', () => {
    const r = planMediaPipeline(deps());
    assert.deepEqual(r.localFirst, ['media.whisper', 'media.ffmpeg', 'media.autoclip', 'media.moneyprinter']);
    assert.equal(r.stages.find((s) => s.id === 'transcribe')?.status, 'blocked');
    assert.equal(r.blocked >= 3, true);
  });
});

describe('faceless factory', () => {
  it('never allows publishing until compliance is confirmed and a channel is connected', () => {
    const d = deps();
    const plan = planFacelessFactory({ niche: 'history facts' }, d);
    assert.equal(plan.publishAllowed, false);
    assert.equal(plan.compliance.every((c) => c.status === 'unknown'), true);
    assert.ok(plan.blockers.some((b) => /requisitos de cumplimiento sin confirmar/.test(b)));
    assert.ok(plan.blockers.some((b) => /canal de publicación/.test(b)));
    assert.ok(plan.blockers.every((b) => !/\(s\)/.test(b)));

    const confirmed = planFacelessFactory({ niche: 'history facts', confirmations: COMPLIANCE_REQUIREMENTS.map((r) => r.id) }, d);
    assert.equal(confirmed.compliance.every((c) => c.status === 'confirmed'), true);
    assert.equal(confirmed.publishAllowed, false); // still no channel
  });

  it('carries no revenue figure', () => {
    const plan = planFacelessFactory({ niche: 'x' }, deps());
    assert.match(plan.revenueNote, /No se da por supuesto ningún ingreso/);
    assert.equal(/\d+\s?(USD|EUR|\$|€)/.test(JSON.stringify(plan)), false);
  });
});

describe('creative studio capabilities', () => {
  const status = (r: ReturnType<typeof planContentPipeline>, id: string) => r.stages.find((s) => s.id === id)?.status;

  it('marks the stages the studio can really do as ready, and leaves the rest as they were', () => {
    const before = planContentPipeline(deps());
    assert.equal(status(before, 'voice'), 'blocked');
    const after = planContentPipeline({ ...deps(), studio: new Set(['script', 'image', 'voice', 'edit']) });
    for (const id of ['script', 'visuals', 'voice', 'editing']) assert.equal(status(after, id), 'ready', id);
    assert.match(after.stages.find((s) => s.id === 'editing')?.note ?? '', /Estudio/);
    assert.equal(status(after, 'publish'), 'blocked'); // nothing publishes on its own
  });

  it('needs every capability a stage asks for', () => {
    const media = planMediaPipeline({ ...deps(), studio: new Set(['edit']) });
    assert.equal(media.stages.find((s) => s.id === 'clip')?.status, 'ready');
    assert.notEqual(media.stages.find((s) => s.id === 'captions')?.status, 'ready'); // captions also need transcription
    assert.equal(planMediaPipeline({ ...deps(), studio: new Set(['edit', 'transcribe']) }).stages.find((s) => s.id === 'captions')?.status, 'ready');
  });
});
