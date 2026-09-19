/**
 * Server configuration, read from the environment once at boot.
 *
 * API keys are read HERE, on the server, and never sent to the browser. The
 * frontend receives only what `/api/providers` exposes: ids, labels and
 * availability.
 */

export interface ServerConfig {
  port: number;
  corsOrigins: string[];
  logLevel: 'debug' | 'info' | 'warn' | 'error';
  version: string;

  persistence: 'postgres' | 'memory';
  databaseUrl: string | undefined;
  dbPoolMax: number;
  dbAutoMigrate: boolean;
  dbSsl: boolean;

  providerId: string | undefined;
  model: string | undefined;
  queueConcurrency: number;
  continueOnWorkerFailure: boolean;
  agentTimeoutMs: number;

  mockMinLatencyMs: number;
  mockMaxLatencyMs: number;
}

function str(env: NodeJS.ProcessEnv, key: string): string | undefined {
  const value = env[key];
  return value === undefined || value.trim() === '' ? undefined : value.trim();
}

function int(env: NodeJS.ProcessEnv, key: string, fallback: number): number {
  const raw = str(env, key);
  if (raw === undefined) return fallback;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error(`Environment variable ${key} must be a non-negative integer, got "${raw}".`);
  }
  return parsed;
}

function bool(env: NodeJS.ProcessEnv, key: string, fallback: boolean): boolean {
  const raw = str(env, key)?.toLowerCase();
  if (raw === undefined) return fallback;
  if (raw === 'true' || raw === '1') return true;
  if (raw === 'false' || raw === '0') return false;
  throw new Error(`Environment variable ${key} must be true or false, got "${raw}".`);
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ServerConfig {
  const persistenceRaw = str(env, 'PERSISTENCE') ?? 'postgres';
  if (persistenceRaw !== 'postgres' && persistenceRaw !== 'memory') {
    throw new Error(`PERSISTENCE must be "postgres" or "memory", got "${persistenceRaw}".`);
  }

  const logLevelRaw = str(env, 'LOG_LEVEL') ?? 'info';
  if (!['debug', 'info', 'warn', 'error'].includes(logLevelRaw)) {
    throw new Error(`LOG_LEVEL must be debug, info, warn or error, got "${logLevelRaw}".`);
  }

  const databaseUrl = str(env, 'DATABASE_URL');
  if (persistenceRaw === 'postgres' && databaseUrl === undefined) {
    throw new Error('DATABASE_URL is required when PERSISTENCE=postgres. Set PERSISTENCE=memory to run without a database.');
  }

  const mockMin = int(env, 'MOCK_MIN_LATENCY_MS', 250);
  const mockMax = int(env, 'MOCK_MAX_LATENCY_MS', 900);
  if (mockMax < mockMin) {
    throw new Error('MOCK_MAX_LATENCY_MS must be greater than or equal to MOCK_MIN_LATENCY_MS.');
  }

  return {
    port: int(env, 'PORT', 3001),
    corsOrigins: (str(env, 'CORS_ORIGIN') ?? 'http://localhost:5173')
      .split(',')
      .map((o) => o.trim())
      .filter(Boolean),
    logLevel: logLevelRaw as ServerConfig['logLevel'],
    version: str(env, 'APP_VERSION') ?? '0.1.0',

    persistence: persistenceRaw,
    databaseUrl,
    dbPoolMax: int(env, 'DB_POOL_MAX', 10),
    dbAutoMigrate: bool(env, 'DB_AUTO_MIGRATE', true),
    dbSsl: bool(env, 'DB_SSL', false),

    providerId: str(env, 'AI_PROVIDER'),
    model: str(env, 'AI_MODEL'),
    queueConcurrency: Math.max(1, int(env, 'QUEUE_CONCURRENCY', 1)),
    continueOnWorkerFailure: bool(env, 'CONTINUE_ON_WORKER_FAILURE', true),
    agentTimeoutMs: int(env, 'AGENT_TIMEOUT_MS', 60_000),

    mockMinLatencyMs: mockMin,
    mockMaxLatencyMs: mockMax,
  };
}
