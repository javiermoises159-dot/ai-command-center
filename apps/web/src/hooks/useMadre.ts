/**
 * Data hooks for the MADRE endpoints. Registries are fetched once (with a
 * manual refresh); a mission's MADRE view polls only while the engine is
 * working, so an idle tab makes no requests.
 */

import { api } from '../lib/api.ts';
import { runIsLive } from '../lib/madre.ts';
import { usePolledResource } from './useApi.ts';

const never = () => false;

export function useMissionMadre(missionId: string | null, missionActive: boolean) {
  return usePolledResource(
    async (signal) => (missionId === null ? null : api.missionMadre(missionId, signal)),
    (data) => missionActive || runIsLive(data?.state ?? null),
    [missionId, missionActive],
    1200,
  );
}

export function useMadreOverview(live: boolean) {
  return usePolledResource((signal) => api.madreOverview(signal), () => live, [live], 2500);
}

export const useMadreAgents = () => usePolledResource((signal) => api.madreAgents(signal), never, []);
export const useMadreTools = () => usePolledResource((signal) => api.madreTools(signal), never, []);
export const useMadreProviders = () => usePolledResource((signal) => api.madreProviders(signal), never, []);
export const useMadrePermissions = () => usePolledResource((signal) => api.madrePermissions(signal), never, []);
export const useMadreBudget = () => usePolledResource((signal) => api.madreBudget(signal), never, []);
export const useMadreApprovals = (live: boolean) => usePolledResource((signal) => api.madreApprovals(signal), () => live, [live], 2500);
export const useMadreActivity = (limit: number) => usePolledResource((signal) => api.madreActivity(limit, signal), never, [limit]);
export const useMadreMemory = (q: string, type: string) =>
  usePolledResource((signal) => api.madreMemory({ ...(q !== '' ? { q } : {}), ...(type !== '' ? { type } : {}), limit: 100 }, signal), never, [q, type]);
