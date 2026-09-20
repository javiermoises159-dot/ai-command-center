/**
 * Provider health checks.
 *
 * A health check answers one question: can this provider be reached *right
 * now*? It never answers it from configuration. A provider with an API key set
 * is not healthy — it is `unknown` until something actually talked to it. A
 * provider with nothing configured is `not_connected`, which is different from
 * `down`: there is no service to be down.
 *
 * Checks never throw and never call a paid endpoint. Reachability is probed
 * with the cheapest thing a vendor offers (a model listing, typically); for a
 * provider whose adapter is still a stub there is nothing to probe, so the
 * check reports `not_connected` without making a request.
 */

import type { ProviderHealth, ProviderProfile, ProviderHealthStatus } from '../types.ts';

/** What an adapter's own probe answers. Same shape as `ProviderHealthReport` in the domain. */
export interface ProbeReport {
  status: 'ok' | 'degraded' | 'down' | 'not_connected';
  detail: string;
  latencyMs?: number;
}

/** Same shape as `fetch`, narrowed to what a check needs, so tests can inject one. */
export type FetchLike = (
  url: string,
  init?: { method?: string; signal?: AbortSignal },
) => Promise<{ ok: boolean; status: number }>;

export interface HealthCheckDeps {
  fetch?: FetchLike;
  /** Injected so tests do not depend on the wall clock. */
  now?: () => Date;
  timeoutMs?: number;
  /** Only read for providers that expose a local endpoint. */
  ollamaBaseUrl?: string | undefined;
  /**
   * Ask an adapter to probe itself (a cheap, unbilled call such as listing
   * models). Resolves to null for an adapter with no probe. Never rejects: an
   * adapter reports its own failure as `down`.
   */
  probe?: (providerId: string) => Promise<ProbeReport | null>;
}

/** How long a probe may take before it counts as unreachable. */
const DEFAULT_TIMEOUT_MS = 3_000;

/** Above this, a reachable provider is reported as `degraded` rather than `ok`. */
const SLOW_MS = 2_000;

function result(
  status: ProviderHealthStatus,
  detail: string,
  at: Date,
  latencyMs: number | null = null,
): ProviderHealth {
  return { status, checkedAt: at.toISOString(), latencyMs, detail };
}

/**
 * Probe one provider.
 *
 * Returns a `ProviderHealth` in every case, including when the probe throws:
 * a health check that can fail loudly is a health check nobody runs.
 */
export async function checkProviderHealth(
  provider: Pick<ProviderProfile, 'id' | 'executable' | 'tier'>,
  deps: HealthCheckDeps = {},
): Promise<ProviderHealth> {
  const now = deps.now ?? (() => new Date());
  const at = now();

  // The simulation runs in this process. There is no endpoint and no network.
  if (provider.tier === 'mock') {
    return result('ok', 'Simulación local: siempre disponible, sin valor analítico.', at, 0);
  }

  // Nothing configured, or the adapter is still a stub: nothing to probe.
  if (!provider.executable) {
    return result('not_connected', 'No hay nada que comprobar: el proveedor no está configurado.', at);
  }

  if (provider.id === 'ollama') {
    const base = deps.ollamaBaseUrl?.trim().replace(/\/+$/, '');
    if (base === undefined || base === '') {
      return result('not_connected', 'OLLAMA_BASE_URL no está definida.', at);
    }
    return probe(`${base}/api/tags`, at, deps, {
      ok: 'El servidor de Ollama responde.',
      slow: 'El servidor de Ollama responde, pero lento.',
      down: 'No se pudo conectar con el servidor de Ollama.',
    });
  }

  // The adapter's own probe: the vendor answered, or it did not.
  if (deps.probe !== undefined) {
    const report = await deps.probe(provider.id);
    if (report !== null) return result(report.status, report.detail, at, report.latencyMs ?? null);
  }

  // An executable provider with no probe of its own: say so rather than guess.
  return result('unknown', 'Este proveedor no expone ninguna comprobación de estado.', at);
}

async function probe(
  url: string,
  at: Date,
  deps: HealthCheckDeps,
  messages: { ok: string; slow: string; down: string },
): Promise<ProviderHealth> {
  const doFetch = deps.fetch ?? (globalThis.fetch as unknown as FetchLike);
  const timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const startedAt = Date.now();

  try {
    const response = await doFetch(url, { method: 'GET', signal: controller.signal });
    const latencyMs = Date.now() - startedAt;
    if (!response.ok) {
      return result('down', `${messages.down} HTTP ${response.status}.`, at, latencyMs);
    }
    return latencyMs > SLOW_MS
      ? result('degraded', `${messages.slow} ${latencyMs} ms.`, at, latencyMs)
      : result('ok', messages.ok, at, latencyMs);
  } catch (error) {
    const latencyMs = Date.now() - startedAt;
    const reason = controller.signal.aborted
      ? `no respondió en ${timeoutMs} ms`
      : error instanceof Error
        ? error.message
        : String(error);
    return result('down', `${messages.down} ${reason}.`, at, latencyMs);
  } finally {
    clearTimeout(timer);
  }
}

/** Probe every provider in the catalog. Runs them together; none can fail the batch. */
export async function checkAllProviders(
  providers: readonly Pick<ProviderProfile, 'id' | 'executable' | 'tier'>[],
  deps: HealthCheckDeps = {},
): Promise<Map<string, ProviderHealth>> {
  const entries = await Promise.all(
    providers.map(async (provider) => [provider.id, await checkProviderHealth(provider, deps)] as const),
  );
  return new Map(entries);
}
