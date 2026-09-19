/**
 * MockProvider — the only provider implemented today.
 *
 * It exists to prove the orchestration machinery end to end with no API key and
 * no network. It performs NO reasoning: every result is template text assembled
 * from the mission statement, and it says so in its own output
 * (see SIMULATION_NOTICE). Nothing it returns should be read as analysis.
 *
 * It is deterministic: identical mission + agent produce identical output, so
 * the pipeline can be asserted with plain equality in tests.
 */

import {
  ProviderFailedError,
  parseMockDirectives,
  type AIProvider,
  type ProviderId,
  type ProviderModel,
  type ProviderResult,
  type ProviderTask,
} from '@acc/domain';
import { createRng, hashString, randomInt } from './rng.ts';
import { generate } from './generators.ts';

export interface MockProviderOptions {
  /** Lower bound of simulated latency per call, in ms. */
  minLatencyMs?: number;
  /** Upper bound of simulated latency per call, in ms. */
  maxLatencyMs?: number;
  /**
   * Sleep implementation. Tests inject a no-op to run the pipeline instantly
   * without making the provider itself aware of the test environment.
   */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
}

const MODELS: readonly ProviderModel[] = [
  { id: 'mock-1', label: 'Mock 1 (deterministic simulation)', contextWindow: 128_000 },
  { id: 'mock-1-fast', label: 'Mock 1 Fast (no simulated latency)', contextWindow: 128_000 },
];

export class MockProvider implements AIProvider {
  readonly id: ProviderId = 'mock';
  readonly label = 'Mock (simulated)';
  readonly availability = 'available' as const;

  private readonly minLatencyMs: number;
  private readonly maxLatencyMs: number;
  private readonly sleep: (ms: number, signal?: AbortSignal) => Promise<void>;

  constructor(options: MockProviderOptions = {}) {
    this.minLatencyMs = Math.max(0, options.minLatencyMs ?? 250);
    this.maxLatencyMs = Math.max(this.minLatencyMs, options.maxLatencyMs ?? 900);
    this.sleep = options.sleep ?? defaultSleep;
  }

  listModels(): readonly ProviderModel[] {
    return MODELS;
  }

  async execute(task: ProviderTask, signal?: AbortSignal): Promise<ProviderResult> {
    const startedAt = Date.now();
    const missionPrompt = task.context?.missionPrompt ?? task.prompt;
    const directives = parseMockDirectives(missionPrompt);

    const rng = createRng(hashString(`${task.agentId}:${missionPrompt}:latency`));
    const latency =
      task.model === 'mock-1-fast'
        ? 0
        : (directives.latencyMs ?? randomInt(rng, this.minLatencyMs, this.maxLatencyMs));

    if (latency > 0) await this.sleep(latency, signal);

    if (signal?.aborted) {
      throw new ProviderFailedError('mock', 'The agent run was cancelled.');
    }

    // Injected failure: `[fail:<agentId>]` anywhere in the mission statement.
    // This is how the error paths are exercised without breaking the server.
    if (directives.failingAgents.has(task.agentId)) {
      throw new ProviderFailedError(
        'mock',
        `Simulated failure injected via [fail:${task.agentId}] in the mission statement.`,
      );
    }

    const text = generate({
      agentId: task.agentId,
      agentName: task.agentId,
      missionPrompt,
      upstream: task.context?.upstream ?? [],
      failed: task.context?.failed ?? [],
    });

    // Token counts are a deliberate, documented approximation (~4 chars/token).
    // They exist so the usage plumbing is exercised, not to be accurate.
    const promptTokens = Math.ceil((task.systemPrompt.length + task.prompt.length) / 4);
    const completionTokens = Math.ceil(text.length / 4);

    return {
      provider: 'mock',
      model: task.model,
      text,
      usage: {
        promptTokens,
        completionTokens,
        totalTokens: promptTokens + completionTokens,
      },
      requestId: `mock_${hashString(`${task.agentId}:${missionPrompt}`).toString(16)}`,
      finishReason: 'stop',
      latencyMs: Date.now() - startedAt,
    };
  }
}

function defaultSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new ProviderFailedError('mock', 'The agent run was cancelled.'));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new ProviderFailedError('mock', 'The agent run was cancelled.'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}
