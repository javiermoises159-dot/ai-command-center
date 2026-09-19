/**
 * Data hooks.
 *
 * Polling rather than websockets, deliberately: the mission pipeline is a
 * handful of rows and a poll is far simpler to reason about and to keep correct
 * across a phone going to sleep. Polling stops as soon as nothing is running, so
 * an idle tab makes no requests.
 */

import { useCallback, useEffect, useRef, useState } from 'react';

import { api, ApiClientError } from '../lib/api.ts';
import type {
  AgentDefinition,
  MissionDetail,
  MissionStatus,
  MissionSummary,
  Provider,
  StatsResponse,
} from '../lib/api.ts';

export interface AsyncState<T> {
  data: T | null;
  error: string | null;
  loading: boolean;
}

const IDLE_POLL_MS = 1200;

function message(error: unknown): string {
  if (error instanceof ApiClientError) return error.message;
  if (error instanceof Error) return error.message;
  return 'Something went wrong.';
}

/**
 * Fetch on mount, then re-fetch on an interval while `shouldPoll` says the data
 * is still moving. `silent` refreshes never flip `loading`, so a polled update
 * does not make the UI flash a skeleton every second.
 */
function usePolledResource<T>(
  fetcher: (signal: AbortSignal) => Promise<T>,
  shouldPoll: (data: T | null) => boolean,
  deps: unknown[],
  intervalMs = IDLE_POLL_MS,
) {
  const [state, setState] = useState<AsyncState<T>>({ data: null, error: null, loading: true });

  const fetcherRef = useRef(fetcher);
  const shouldPollRef = useRef(shouldPoll);
  fetcherRef.current = fetcher;
  shouldPollRef.current = shouldPoll;

  // The latest data, mirrored outside React state. The scheduling decision is
  // read from here rather than from inside a setState updater: React may invoke
  // an updater more than once (StrictMode does, in development), and scheduling
  // a timer from one would leave an orphaned timer polling forever.
  const dataRef = useRef<T | null>(null);

  const load = useCallback(async (signal: AbortSignal, silent: boolean): Promise<void> => {
    if (!silent) setState((prev) => ({ ...prev, loading: true }));
    try {
      const data = await fetcherRef.current(signal);
      if (signal.aborted) return;
      dataRef.current = data;
      setState({ data, error: null, loading: false });
    } catch (error) {
      if (signal.aborted || (error instanceof DOMException && error.name === 'AbortError')) return;
      // A failed silent poll keeps the last good data on screen and shows the
      // error alongside it, rather than blanking the pipeline.
      setState((prev) => ({ data: prev.data, error: message(error), loading: false }));
    }
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let cancelled = false;

    const tick = async (silent: boolean): Promise<void> => {
      await load(controller.signal, silent);
      if (cancelled || controller.signal.aborted) return;
      if (shouldPollRef.current(dataRef.current)) {
        timer = setTimeout(() => void tick(true), intervalMs);
      }
    };

    void tick(false);

    return () => {
      cancelled = true;
      controller.abort();
      if (timer !== undefined) clearTimeout(timer);
    };
    // `deps` is spread by the caller; each hook below passes a stable list.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, intervalMs, load]);

  // Manual refresh (retry button, or after a mutation). Its own controller, so
  // it never cancels the polling loop.
  const refresh = useCallback(() => {
    void load(new AbortController().signal, true);
  }, [load]);

  return { ...state, refresh };
}

const missionIsActive = (status: MissionStatus | undefined): boolean =>
  status === 'pending' || status === 'running';

export function useMission(id: string) {
  return usePolledResource<MissionDetail>(
    (signal) => api.getMission(id, signal),
    (data) => data === null || missionIsActive(data.status),
    [id],
  );
}

export function useMissions(filter: { status?: MissionStatus; limit?: number } = {}) {
  const { status, limit = 50 } = filter;
  return usePolledResource<{ items: MissionSummary[]; total: number }>(
    (signal) => api.listMissions({ limit, ...(status !== undefined ? { status } : {}) }, signal),
    (data) => data !== null && data.items.some((m) => missionIsActive(m.status)),
    [status, limit],
    2000,
  );
}

export function useStats(active: boolean) {
  return usePolledResource<StatsResponse>(
    (signal) => api.stats(signal),
    () => active,
    [active],
    2500,
  );
}

/** The agent catalog never changes at runtime, so it is fetched once. */
export function useAgentCatalog() {
  const [agents, setAgents] = useState<AgentDefinition[]>([]);

  useEffect(() => {
    const controller = new AbortController();
    api
      .listAgents(controller.signal)
      .then((response) => setAgents(response.items))
      .catch(() => undefined);
    return () => controller.abort();
  }, []);

  return agents;
}

export function useProviders() {
  const [providers, setProviders] = useState<Provider[]>([]);

  useEffect(() => {
    const controller = new AbortController();
    api
      .listProviders(controller.signal)
      .then((response) => setProviders(response.items))
      .catch(() => undefined);
    return () => controller.abort();
  }, []);

  return providers;
}
