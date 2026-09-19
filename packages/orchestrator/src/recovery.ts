/**
 * Boot-time recovery.
 *
 * The in-process queue does not survive a restart. Without this sweep, a run
 * that was mid-flight when the process died would sit in `running` forever and
 * the UI would poll it indefinitely. Marking it failed is the honest outcome:
 * the work really did stop, and the user can press Run again.
 *
 * When the queue is replaced by a durable one, this becomes re-enqueue instead
 * of fail — the seam is already here.
 */

import { systemClock, type Clock, type Logger, type Repositories } from '@acc/domain';

export async function recoverUnfinishedRuns(deps: {
  repositories: Repositories;
  logger: Logger;
  clock?: Clock;
}): Promise<number> {
  const clock = deps.clock ?? systemClock;
  const log = deps.logger.child({ component: 'recovery' });

  const orphans = await deps.repositories.runs.findUnfinished();
  if (orphans.length === 0) return 0;

  const at = clock.now();
  for (const run of orphans) {
    await deps.repositories.agents.markRemainingSkipped(run.id, at);
    await deps.repositories.runs.markFinished(run.id, 'failed', at, {
      error: 'The server restarted while this run was in progress.',
    });
    await deps.repositories.missions.updateStatus(run.missionId, 'failed', at);
  }

  log.warn('closed runs orphaned by a restart', { count: orphans.length });
  return orphans.length;
}
