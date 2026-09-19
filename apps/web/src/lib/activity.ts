/**
 * Turns the missions the API already returns into a flat, newest-first activity
 * timeline. Pure and dependency-free so it can be unit-tested without a browser.
 *
 * Nothing here is invented: every event is derived from a timestamp that exists
 * on a mission, run or agent execution (`createdAt`, `startedAt`, `completedAt`).
 * A status with no matching timestamp (for example an agent that is still
 * pending) simply produces no event.
 */

import type { MissionDetail } from '@acc/contracts';

export type ActivityKind =
  | 'mission_created'
  | 'run_started'
  | 'agent_started'
  | 'agent_completed'
  | 'agent_failed'
  | 'agent_skipped'
  | 'run_completed'
  | 'run_failed';

export interface ActivityEvent {
  /** Stable across polls, so React keeps rows in place while the list grows. */
  id: string;
  at: string;
  kind: ActivityKind;
  missionId: string;
  missionTitle: string;
  runAttempt: number | null;
  agentName: string | null;
  /** Failure message, when there is one. */
  detail: string | null;
}

export type ActivityGroup = 'all' | 'runs' | 'agents' | 'failures';

const RUN_KINDS: ReadonlySet<ActivityKind> = new Set(['mission_created', 'run_started', 'run_completed', 'run_failed']);
const FAILURE_KINDS: ReadonlySet<ActivityKind> = new Set(['agent_failed', 'run_failed']);

export function matchesGroup(kind: ActivityKind, group: ActivityGroup): boolean {
  switch (group) {
    case 'all':
      return true;
    case 'runs':
      return RUN_KINDS.has(kind);
    case 'agents':
      return kind.startsWith('agent_');
    case 'failures':
      return FAILURE_KINDS.has(kind);
  }
}

interface Draft extends ActivityEvent {
  /** Logical order inside one mission, used to break timestamp ties. */
  seq: number;
}

export function buildActivity(missions: readonly MissionDetail[]): ActivityEvent[] {
  const drafts: Draft[] = [];
  let seq = 0;

  for (const mission of missions) {
    const base = { missionId: mission.id, missionTitle: mission.title };
    const push = (event: Omit<Draft, 'seq' | 'missionId' | 'missionTitle'>) => {
      drafts.push({ ...base, ...event, seq: seq++ });
    };

    push({
      id: `${mission.id}:created`,
      at: mission.createdAt,
      kind: 'mission_created',
      runAttempt: null,
      agentName: null,
      detail: null,
    });

    // Oldest run first, so `seq` follows the real order of events.
    for (const run of [...mission.runs].sort((a, b) => a.attempt - b.attempt)) {
      if (run.startedAt !== null) {
        push({
          id: `${run.id}:started`,
          at: run.startedAt,
          kind: 'run_started',
          runAttempt: run.attempt,
          agentName: null,
          detail: null,
        });
      }

      for (const agent of [...run.agents].sort((a, b) => a.orderIndex - b.orderIndex)) {
        const shared = { runAttempt: run.attempt, agentName: agent.name };

        if (agent.startedAt !== null) {
          push({ id: `${agent.id}:started`, at: agent.startedAt, kind: 'agent_started', detail: null, ...shared });
        }
        if (agent.completedAt !== null && agent.status === 'completed') {
          push({ id: `${agent.id}:completed`, at: agent.completedAt, kind: 'agent_completed', detail: null, ...shared });
        }
        if (agent.completedAt !== null && agent.status === 'failed') {
          push({ id: `${agent.id}:failed`, at: agent.completedAt, kind: 'agent_failed', detail: agent.error, ...shared });
        }
        if (agent.completedAt !== null && agent.status === 'skipped') {
          push({ id: `${agent.id}:skipped`, at: agent.completedAt, kind: 'agent_skipped', detail: null, ...shared });
        }
      }

      if (run.completedAt !== null && (run.status === 'completed' || run.status === 'failed')) {
        push({
          id: `${run.id}:finished`,
          at: run.completedAt,
          kind: run.status === 'completed' ? 'run_completed' : 'run_failed',
          runAttempt: run.attempt,
          agentName: null,
          detail: run.error,
        });
      }
    }
  }

  return drafts
    .sort((a, b) => {
      const byTime = Date.parse(b.at) - Date.parse(a.at);
      // Same instant: the later logical event is the more recent one.
      return byTime !== 0 ? byTime : b.seq - a.seq;
    })
    .map(({ seq: _seq, ...event }) => event);
}
