/**
 * In-process JobQueue.
 *
 * This is what makes `POST /api/missions` return in milliseconds while the
 * eight agents keep working behind it.
 *
 * Scope, stated plainly: jobs live in this process's memory. A restart loses
 * anything queued, which is why the server sweeps unfinished runs on boot and
 * marks them failed rather than pretending they are still going. Swapping in a
 * durable queue (pg-boss on the existing Postgres, or BullMQ) means writing one
 * class against `JobQueue` — no caller changes.
 */

import type { Job, JobHandler, JobQueue, Logger } from '@acc/domain';
import { errorMessage } from '@acc/domain';

export interface InProcessJobQueueOptions {
  /** How many jobs may run at once. Each job is a whole mission run. */
  concurrency?: number;
  logger: Logger;
}

export class InProcessJobQueue implements JobQueue {
  private readonly queue: Job[] = [];
  private readonly inFlight = new Set<Promise<void>>();
  private readonly concurrency: number;
  private readonly logger: Logger;
  private handler: JobHandler | null = null;
  private running = false;
  private drainWaiters: Array<() => void> = [];

  constructor(options: InProcessJobQueueOptions) {
    this.concurrency = Math.max(1, options.concurrency ?? 1);
    this.logger = options.logger.child({ component: 'queue' });
  }

  process(handler: JobHandler): void {
    this.handler = handler;
  }

  enqueue(job: Job): Promise<void> {
    this.queue.push(job);
    this.logger.debug('job enqueued', { type: job.type, runId: job.runId, depth: this.queue.length });
    if (this.running) this.pump();
    return Promise.resolve();
  }

  start(): void {
    if (this.handler === null) {
      throw new Error('InProcessJobQueue.start() called before process() registered a handler.');
    }
    this.running = true;
    this.pump();
  }

  async stop(timeoutMs = 10_000): Promise<void> {
    this.running = false;
    if (this.inFlight.size === 0) return;

    this.logger.info('waiting for in-flight jobs', { count: this.inFlight.size });
    await Promise.race([
      Promise.allSettled([...this.inFlight]),
      new Promise((resolve) => setTimeout(resolve, timeoutMs)),
    ]);
  }

  size(): number {
    return this.queue.length + this.inFlight.size;
  }

  drain(): Promise<void> {
    if (this.size() === 0) return Promise.resolve();
    return new Promise<void>((resolve) => {
      this.drainWaiters.push(resolve);
    });
  }

  private pump(): void {
    if (!this.running || this.handler === null) return;

    while (this.inFlight.size < this.concurrency && this.queue.length > 0) {
      const job = this.queue.shift();
      if (job === undefined) break;
      this.runJob(job, this.handler);
    }

    if (this.size() === 0) this.notifyDrained();
  }

  private runJob(job: Job, handler: JobHandler): void {
    // A job that throws must never take the process down, and must never wedge
    // the queue: the failure is logged and the pump continues.
    const task = handler(job)
      .catch((error: unknown) => {
        this.logger.error('job failed', {
          type: job.type,
          runId: job.runId,
          missionId: job.missionId,
          error: errorMessage(error),
        });
      })
      .finally(() => {
        this.inFlight.delete(task);
        this.pump();
      });

    this.inFlight.add(task);
  }

  private notifyDrained(): void {
    const waiters = this.drainWaiters;
    this.drainWaiters = [];
    for (const resolve of waiters) resolve();
  }
}
