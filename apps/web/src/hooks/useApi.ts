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
  HealthResponse,
  ListProvidersResponse,
  Provider,
  StatsResponse,
} from '../lib/api.ts';

export interface AsyncState<T> {
  data: T | null;
  error: string | null;
  loading: boolean;
}

const IDLE_POLL_MS = 1200;

export function message(error: unknown): string {
  if (error instanceof ApiClientError) return error.message;
  if (error instanceof Error) return error.message;
  return 'Something went wrong.';
}

/**
 * Fetch on mount, then re-fetch on an interval while `shouldPoll` says the data
 * is still moving. `silent` refreshes never flip `loading`, so a polled update
 * does not make the UI flash a skeleton every second.
 */
export function usePolledResource<T>(
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

  // Set by the polling effect: refetch now and (re)start the loop. Polling stops
  // once nothing is active, so a mutation such as "Run again" must be able to
  // wake it up again; a bare refetch would show the new run once and go quiet.
  const restartRef = useRef<() => void>(() => undefined);

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

    restartRef.current = () => {
      if (timer !== undefined) clearTimeout(timer);
      void tick(true);
    };

    return () => {
      restartRef.current = () => undefined;
      cancelled = true;
      controller.abort();
      if (timer !== undefined) clearTimeout(timer);
    };
    // `deps` is spread by the caller; each hook below passes a stable list.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, intervalMs, load]);

  // Manual refresh (retry button, or after a mutation). Reuses the loop's
  // controller, so it is cancelled with the component like any other poll.
  const refresh = useCallback(() => {
    restartRef.current();
  }, []);

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

/**
 * The catalog and provider list only decorate the screens (names, accents, the
 * provider picker); a failure to load them leaves the lists empty but must not
 * be silent, so it is reported to the console unless the request was aborted
 * on purpose (the component went away).
 */
function warnUnlessAborted(controller: AbortController, what: string, error: unknown): void {
  if (controller.signal.aborted) return;
  console.warn(`No se pudo cargar ${what}.`, error);
}

/** The agent catalog never changes at runtime, so it is fetched once. */
export function useAgentCatalog() {
  const [agents, setAgents] = useState<AgentDefinition[]>([]);

  useEffect(() => {
    const controller = new AbortController();
    api
      .listAgents(controller.signal)
      .then((response) => setAgents(response.items))
      .catch((error: unknown) => warnUnlessAborted(controller, 'agent catalog', error));
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
      .catch((error: unknown) => warnUnlessAborted(controller, 'provider list', error));
    return () => controller.abort();
  }, []);

  return providers;
}

/** Providers plus which one is the default, with loading/error state for Settings. */
export function useProviderInfo() {
  const [state, setState] = useState<AsyncState<ListProvidersResponse>>({ data: null, error: null, loading: true });

  useEffect(() => {
    const controller = new AbortController();
    api
      .listProviders(controller.signal)
      .then((data) => setState({ data, error: null, loading: false }))
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        setState({ data: null, error: message(error), loading: false });
      });
    return () => controller.abort();
  }, []);

  return state;
}

export interface HealthSnapshot {
  health: HealthResponse;
  /** Round-trip time of the health request, measured in the browser. */
  latencyMs: number;
}

/**
 * Liveness of the API, polled slowly. This is what the sidebar's status light
 * and the Settings "System status" panel read — it is a real request, so a
 * stopped server turns the light red instead of showing a stale green.
 */
export function useHealth() {
  return usePolledResource<HealthSnapshot>(
    async (signal) => {
      const startedAt = performance.now();
      const health = await api.health(signal);
      return { health, latencyMs: Math.round(performance.now() - startedAt) };
    },
    () => true,
    [],
    15_000,
  );
}
