import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { silentLogger, type Job } from '@acc/domain';
import { InProcessJobQueue } from './in-process-queue.ts';

const job = (n: number): Job => ({ type: 'execute-run', runId: `run-${n}`, missionId: `mission-${n}` });

describe('InProcessJobQueue', () => {
  it('refuses to start without a handler', () => {
    const queue = new InProcessJobQueue({ logger: silentLogger });
    assert.throws(() => queue.start(), /before process\(\)/);
  });

  it('returns from enqueue before the job has run', async () => {
    const queue = new InProcessJobQueue({ logger: silentLogger });
    let ran = false;
    queue.process(async () => {
      await new Promise((r) => setTimeout(r, 20));
      ran = true;
    });
    queue.start();

    await queue.enqueue(job(1));
    assert.equal(ran, false, 'enqueue must not await execution');

    await queue.drain();
    assert.equal(ran, true);
  });

  it('runs jobs sequentially at concurrency 1', async () => {
    const queue = new InProcessJobQueue({ logger: silentLogger, concurrency: 1 });
    const events: string[] = [];

    queue.process(async (j) => {
      events.push(`start:${j.runId}`);
      await new Promise((r) => setTimeout(r, 10));
      events.push(`end:${j.runId}`);
    });
    queue.start();

    await queue.enqueue(job(1));
    await queue.enqueue(job(2));
    await queue.drain();

    assert.deepEqual(events, ['start:run-1', 'end:run-1', 'start:run-2', 'end:run-2']);
  });

  it('overlaps jobs when concurrency allows it', async () => {
    const queue = new InProcessJobQueue({ logger: silentLogger, concurrency: 3 });
    let peak = 0;
    let active = 0;

    queue.process(async () => {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise((r) => setTimeout(r, 15));
      active -= 1;
    });
    queue.start();

    for (let i = 0; i < 6; i += 1) await queue.enqueue(job(i));
    await queue.drain();

    assert.equal(peak, 3);
  });

  it('isolates a failing job so the queue keeps draining', async () => {
    const queue = new InProcessJobQueue({ logger: silentLogger });
    const completed: string[] = [];

    queue.process(async (j) => {
      if (j.runId === 'run-2') throw new Error('boom');
      completed.push(j.runId);
    });
    queue.start();

    await queue.enqueue(job(1));
    await queue.enqueue(job(2));
    await queue.enqueue(job(3));
    await queue.drain();

    assert.deepEqual(completed, ['run-1', 'run-3']);
    assert.equal(queue.size(), 0);
  });

  it('holds jobs until started', async () => {
    const queue = new InProcessJobQueue({ logger: silentLogger });
    let ran = 0;
    queue.process(() => {
      ran += 1;
      return Promise.resolve();
    });

    await queue.enqueue(job(1));
    await new Promise((r) => setTimeout(r, 10));
    assert.equal(ran, 0, 'nothing should run before start()');

    queue.start();
    await queue.drain();
    assert.equal(ran, 1);
  });

  it('waits for in-flight work on stop', async () => {
    const queue = new InProcessJobQueue({ logger: silentLogger });
    let finished = false;
    queue.process(async () => {
      await new Promise((r) => setTimeout(r, 30));
      finished = true;
    });
    queue.start();

    await queue.enqueue(job(1));
    await queue.stop(1000);
    assert.equal(finished, true);
  });

  it('resolves drain immediately when idle', async () => {
    const queue = new InProcessJobQueue({ logger: silentLogger });
    queue.process(() => Promise.resolve());
    queue.start();
    await queue.drain();
    assert.equal(queue.size(), 0);
  });
});
