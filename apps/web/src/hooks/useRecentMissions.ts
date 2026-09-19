/**
 * Full detail (runs and agent executions) for the most recent missions.
 *
 * The list endpoint returns summaries only; the Agents, Activity, Knowledge and
 * Creative screens need per-agent data, which only the detail endpoint has.
 * This hook joins them with the existing API — no new endpoint — and keeps the
 * request count down: a finished mission is fetched once and re-fetched only
 * when its `updatedAt` changes, so polling costs one list request plus a detail
 * request per mission that is actually moving.
 */

import { useCallback, useEffect, useRef, useState } from 'react';

import { api, ApiClientError } from '../lib/api.ts';
import type { MissionDetail } from '../lib/api.ts';

const POLL_MS = 1500;

export interface RecentMissionsState {
  missions: MissionDetail[];
  loading: boolean;
  error: string | null;
  /** True while any of the missions is pending or running. */
  live: boolean;
  refresh(): void;
}

const isActive = (status: string): boolean => status === 'pending' || status === 'running';

export function useRecentMissions(limit = 12): RecentMissionsState {
  const [state, setState] = useState<Omit<RecentMissionsState, 'refresh'>>({
    missions: [],
    loading: true,
    error: null,
    live: false,
  });
  const [nonce, setNonce] = useState(0);
  const cache = useRef(new Map<string, { updatedAt: string; detail: MissionDetail }>());

  useEffect(() => {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let cancelled = false;

    const tick = async (): Promise<void> => {
      try {
        const list = await api.listMissions({ limit }, controller.signal);
        const details = await Promise.all(
          list.items.map(async (summary) => {
            const cached = cache.current.get(summary.id);
            if (cached !== undefined && !isActive(summary.status) && cached.updatedAt === summary.updatedAt) {
              return cached.detail;
            }
            const detail = await api.getMission(summary.id, controller.signal);
            cache.current.set(summary.id, { updatedAt: summary.updatedAt, detail });
            return detail;
          }),
        );
        if (cancelled) return;
        const live = details.some((m) => isActive(m.status));
        setState({ missions: details, loading: false, error: null, live });
        if (live) timer = setTimeout(() => void tick(), POLL_MS);
      } catch (error) {
        if (cancelled || controller.signal.aborted || (error instanceof DOMException && error.name === 'AbortError')) {
          return;
        }
        const text = error instanceof ApiClientError || error instanceof Error ? error.message : 'Something went wrong.';
        // Keep whatever was already on screen; show the error alongside it.
        setState((prev) => ({ ...prev, loading: false, error: text }));
      }
    };

    void tick();
    return () => {
      cancelled = true;
      controller.abort();
      if (timer !== undefined) clearTimeout(timer);
    };
  }, [limit, nonce]);

  const refresh = useCallback(() => setNonce((n) => n + 1), []);
  return { ...state, refresh };
}
