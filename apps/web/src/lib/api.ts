/**
 * The app's single API client instance.
 *
 * Same-origin by default: in dev Vite proxies /api to the server, in production
 * the built assets are served by the same host. No API keys ever reach this
 * bundle — provider credentials live only in the server's environment.
 */

import { createApiClient } from '@acc/contracts';

const baseUrl = import.meta.env['VITE_API_BASE_URL'] ?? '';

export const api = createApiClient({ baseUrl });

export { ApiClientError } from '@acc/contracts';
export type {
  AgentDefinition,
  AgentExecution,
  AgentStatus,
  HealthResponse,
  ListProvidersResponse,
  MissionDetail,
  MissionStatus,
  MissionSummary,
  Provider,
  Run,
  RunDetail,
  StatsResponse,
} from '@acc/contracts';
