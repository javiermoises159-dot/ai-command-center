/**
 * Per-agent live state, derived from mission details the API already returns.
 * Pure, so it is unit-tested without a browser.
 */

import type { AgentStatus, MissionDetail } from '@acc/contracts';

export interface CrewMemberState {
  /** Set while some run has this agent in `running`. */
  working: { missionId: string; missionTitle: string } | null;
  /** The most recent execution that has started, whatever its outcome. */
  last: { status: AgentStatus; at: string; missionId: string; missionTitle: string } | null;
  completed: number;
  failed: number;
  /** Mean duration of completed executions; null when there are none. */
  avgDurationMs: number | null;
}

const EMPTY: CrewMemberState = { working: null, last: null, completed: 0, failed: 0, avgDurationMs: null };

export function deriveCrewState(missions: readonly MissionDetail[]): Map<string, CrewMemberState> {
  const acc = new Map<string, CrewMemberState & { totalMs: number; timed: number }>();

  for (const mission of missions) {
    for (const run of mission.runs) {
      for (const agent of run.agents) {
        const entry =
          acc.get(agent.agentId) ?? { ...EMPTY, totalMs: 0, timed: 0 };
        acc.set(agent.agentId, entry);

        // A `running` agent only counts as working while its run is still active; a
        // stale row inside a finished run (e.g. left by a crash) is not live work.
        if (agent.status === 'running' && run.status === 'running' && entry.working === null) {
          entry.working = { missionId: mission.id, missionTitle: mission.title };
        }
        if (agent.status === 'completed') {
          entry.completed += 1;
          if (agent.durationMs !== null) {
            entry.totalMs += agent.durationMs;
            entry.timed += 1;
          }
        }
        if (agent.status === 'failed') entry.failed += 1;

        // "Last" only considers executions that actually began.
        const at = agent.startedAt;
        if (at !== null && agent.status !== 'pending' && (entry.last === null || Date.parse(at) > Date.parse(entry.last.at))) {
          entry.last = { status: agent.status, at, missionId: mission.id, missionTitle: mission.title };
        }
      }
    }
  }

  const result = new Map<string, CrewMemberState>();
  for (const [id, { totalMs, timed, ...state }] of acc) {
    result.set(id, { ...state, avgDurationMs: timed === 0 ? null : Math.round(totalMs / timed) });
  }
  return result;
}

export function emptyCrewState(): CrewMemberState {
  return { ...EMPTY };
}
