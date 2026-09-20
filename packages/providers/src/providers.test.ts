import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { DomainError, ProviderNotConfiguredError, type ProviderTask } from '@acc/domain';
import { MockProvider } from './mock/mock-provider.ts';
import { SIMULATION_NOTICE } from './mock/generators.ts';
import { createProviderRegistry, ProviderRegistry } from './index.ts';
import { OpenAICompatibleProvider } from './planned/openai-compatible.ts';
import { createRng, hashString } from './mock/rng.ts';

const noSleep = () => Promise.resolve();

function task(overrides: Partial<ProviderTask> = {}): ProviderTask {
  return {
    agentId: 'strategy',
    systemPrompt: 'You are the Strategy agent.',
    prompt: 'MISSION\nLaunch an online cookie store in Italy',
    context: { missionPrompt: 'Launch an online cookie store in Italy', upstream: [], failed: [] },
    model: 'mock-1',
    ...overrides,
  };
}

describe('MockProvider', () => {
  const provider = new MockProvider({ sleep: noSleep });

  it('returns a normalised result with every declared field populated', async () => {
    const result = await provider.execute(task());

    assert.equal(result.provider, 'mock');
    assert.equal(result.model, 'mock-1');
    assert.equal(result.finishReason, 'stop');
    assert.ok(result.text.length > 200);
    assert.ok(result.requestId.startsWith('mock_'));
    assert.ok(result.usage.promptTokens > 0);
    assert.ok(result.usage.completionTokens > 0);
    assert.equal(result.usage.totalTokens, result.usage.promptTokens + result.usage.completionTokens);
    assert.ok(result.latencyMs >= 0);
  });

  it('labels every result as simulated so it cannot be mistaken for analysis', async () => {
    for (const agentId of ['strategy', 'research', 'code', 'design', 'marketing', 'finance'] as const) {
      const result = await provider.execute(task({ agentId }));
      assert.ok(result.text.startsWith(SIMULATION_NOTICE), `${agentId} is missing the simulation banner`);
    }
  });

  it('is deterministic for the same mission and agent', async () => {
    const [a, b] = await Promise.all([provider.execute(task()), provider.execute(task())]);
    assert.equal(a.text, b.text);
    assert.equal(a.requestId, b.requestId);
  });

  it('produces different output for different agents and different missions', async () => {
    const strategy = await provider.execute(task({ agentId: 'strategy' }));
    const finance = await provider.execute(task({ agentId: 'finance' }));
    assert.notEqual(strategy.text, finance.text);

    const other = await provider.execute(
      task({ context: { missionPrompt: 'Open a bike repair shop in Lisbon', upstream: [], failed: [] } }),
    );
    assert.notEqual(strategy.text, other.text);
  });

  it('reflects the mission subject in its output', async () => {
    const result = await provider.execute(
      task({ context: { missionPrompt: 'Launch an artisanal cookie store in Italy', upstream: [], failed: [] } }),
    );
    assert.match(result.text.toLowerCase(), /cookie/);
  });

  it('throws when the mission injects a failure for this agent', async () => {
    const failing = task({
      agentId: 'marketing',
      context: { missionPrompt: 'Launch a store [fail:marketing]', upstream: [], failed: [] },
    });

    await assert.rejects(provider.execute(failing), (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /\[fail:marketing\]/);
      return true;
    });
  });

  it('leaves other agents untouched when a failure is injected', async () => {
    const context = { missionPrompt: 'Launch a store [fail:marketing]', upstream: [], failed: [] };
    const result = await provider.execute(task({ agentId: 'strategy', context }));
    assert.ok(result.text.length > 0);
  });

  it('honours an abort signal', async () => {
    const slow = new MockProvider({ minLatencyMs: 50, maxLatencyMs: 50 });
    const controller = new AbortController();
    const promise = slow.execute(task(), controller.signal);
    controller.abort();
    await assert.rejects(promise, /cancelada/i);
  });

  it('skips simulated latency on the fast model', async () => {
    const real = new MockProvider({ minLatencyMs: 5000, maxLatencyMs: 5000 });
    const startedAt = Date.now();
    await real.execute(task({ model: 'mock-1-fast' }));
    assert.ok(Date.now() - startedAt < 500, 'mock-1-fast should not sleep');
  });
});

describe('planned providers', () => {
  it('reject execution with an explicit not-implemented error', async () => {
    await assert.rejects(new OpenAICompatibleProvider().execute(task()), (error: unknown) => {
      assert.ok(error instanceof ProviderNotConfiguredError);
      assert.equal(error.status, 503);
      assert.match(error.message, /esbozo declarado, no una implementación/);
      return true;
    });
  });

  it('never silently fall back to the mock', async () => {
    const registry = createProviderRegistry();
    assert.throws(() => registry.resolve('openai-compatible'), /not implemented/i);
  });
});

describe('ProviderRegistry', () => {
  const registry = createProviderRegistry();

  it('defaults to the only available provider', () => {
    assert.equal(registry.defaultProviderId(), 'mock');
    assert.deepEqual(registry.availableIds(), ['mock']);
  });

  it('lists planned providers so the roadmap is visible without pretending', () => {
    const described = registry.describe();
    assert.deepEqual(
      described.map((d) => d.id).sort(),
      ['anthropic', 'gemini', 'mock', 'ollama', 'openai', 'openai-compatible'],
    );
    assert.equal(described.filter((d) => d.availability === 'available').length, 1);
    // Ollama (no server) and the OpenAI-compatible stub are planned; the three
    // real vendors are implemented but unconfigured — a different state.
    assert.equal(described.filter((d) => d.availability === 'planned').length, 2);
    assert.equal(described.filter((d) => d.availability === 'unconfigured').length, 3);
  });

  it('resolves the default provider and its first model', () => {
    const { provider, model } = registry.resolve();
    assert.equal(provider.id, 'mock');
    assert.equal(model, 'mock-1');
  });

  it('rejects an unknown provider and an unknown model', () => {
    assert.throws(() => registry.resolve('does-not-exist'), /Unknown provider/);
    assert.throws(() => registry.resolve('mock', 'gpt-9'), /not offered/i);
  });

  it('gives the unknown-model error a public message that lists the options', () => {
    try {
      registry.resolve('mock', 'gpt-9');
      assert.fail('expected a throw');
    } catch (error) {
      assert.ok(error instanceof DomainError);
      assert.equal(error.status, 400);
      assert.match(error.publicMessage, /mock-1/);
    }
  });

  it('refuses to hand out a default when nothing is available', () => {
    const empty = new ProviderRegistry();
    assert.throws(() => empty.getDefault(), /No available provider/);
  });
});

describe('deterministic rng', () => {
  it('produces the same sequence for the same seed', () => {
    const a = createRng(hashString('seed'));
    const b = createRng(hashString('seed'));
    assert.deepEqual([a(), a(), a()], [b(), b(), b()]);
  });

  it('stays within [0, 1)', () => {
    const rng = createRng(1);
    for (let i = 0; i < 1000; i += 1) {
      const value = rng();
      assert.ok(value >= 0 && value < 1, `out of range: ${value}`);
    }
  });
});
