/**
 * Server configuration, read from the environment once at boot.
 *
 * API keys are read HERE, on the server, and never sent to the browser. The
 * frontend receives only what `/api/providers` exposes: ids, labels and
 * availability.
 */

import { DEFAULT_ALERT_AT_FRACTION } from '@acc/madre';
import { realProviderOptionsFromEnv, type RealProviderEnv } from '@acc/providers';

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

  /** Engine for new missions when the request names none. */
  defaultMissionMode: 'classic' | 'madre';
  /** Base URL of a local Ollama server. Unset means Ollama is NOT CONNECTED. */
  ollamaBaseUrl: string | undefined;
  webSearchApiKey: string | undefined;
  /** Fine-grained token limited to the sites repository. Never sent to the browser. */
  githubToken: string | undefined;
  /** "owner/repository" where finished websites are published (GitHub Pages). */
  githubSitesRepo: string | undefined;
  enableWikipedia: boolean;
  enableWebFetch: boolean;
  enableNews: boolean;
  balanceProviders: boolean;
  /**
   * Credentials and models for OpenAI, Anthropic and Gemini. SERVER ONLY: this
   * object holds API keys, so it is handed to the provider constructors and
   * nowhere else — never logged, never put in a response, never stored.
   */
  realProviders: RealProviderEnv;
  /** Provider ids the operator switched off with MADRE_DISABLED_PROVIDERS. */
  disabledProviders: string[];
  /**
   * Shared password for the whole site (HTTP Basic, any username). Unset means
   * open access, which is only acceptable on a trusted network: the app has no
   * user accounts, so this is the only thing standing between the internet and
   * whatever the configured providers cost.
   */
  accessPassword: string | undefined;
  /** Folder with the built web app. Unset = apps/web/dist next to the server. */
  webDistDir: string | undefined;
  /** A guard rail against runaway clients, not a security control. */
  rateLimit: {
    max: number;
    windowMs: number;
  };
  madre: {
    parallelism: number;
    maxRevisionRounds: number;
    budget: {
      perMissionUsd: number | null;
      dailyUsd: number | null;
      monthlyUsd: number | null;
      onExceed: 'block' | 'fallback_local' | 'ask';
      /** Warn once spending passes this share of a limit (0..1). null = no warning. */
      alertAtFraction: number | null;
      /** Per-tool ceilings in USD, from the operator. */
      perToolUsd: Record<string, number>;
    };
    /** Prices per 1k tokens for external models, from the operator. MADRE never guesses one. */
    prices: Record<string, { inputPer1kUsd: number; outputPer1kUsd: number }>;
  };
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

function money(env: NodeJS.ProcessEnv, key: string): number | null {
  const raw = str(env, key);
  if (raw === undefined) return null;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error(`Environment variable ${key} must be a non-negative number, got "${raw}".`);
  }
  return parsed;
}

/**
 * A percentage, read as a fraction. Absent leaves the controller's own default
 * in place; 0 switches the warning off without switching the limits off.
 */
function fraction(env: NodeJS.ProcessEnv, key: string): number | null {
  const raw = str(env, key);
  if (raw === undefined) return DEFAULT_ALERT_AT_FRACTION;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 100) {
    throw new Error(`Environment variable ${key} must be a percentage between 0 and 100, got "${raw}".`);
  }
  return parsed === 0 ? null : parsed / 100;
}

/** `MADRE_TOOL_BUDGETS_JSON={"web.search":2.5}` — ceilings the operator set, never invented. */
function toolBudgets(env: NodeJS.ProcessEnv): Record<string, number> {
  const raw = str(env, 'MADRE_TOOL_BUDGETS_JSON');
  if (raw === undefined) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error('Environment variable MADRE_TOOL_BUDGETS_JSON is not valid JSON.');
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('Environment variable MADRE_TOOL_BUDGETS_JSON must be a JSON object of toolId -> USD.');
  }
  const out: Record<string, number> = {};
  for (const [toolId, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
      throw new Error(`MADRE_TOOL_BUDGETS_JSON: "${toolId}" must be a non-negative number.`);
    }
    out[toolId] = value;
  }
  return out;
}

function prices(env: NodeJS.ProcessEnv): ServerConfig['madre']['prices'] {
  // Free-tier hosts: assumed 0 USD unless the operator says otherwise, so a
  // free key does not need a price entry to be usable. A paid plan must be
  // declared in MADRE_PRICES_JSON.
  const zero = { inputPer1kUsd: 0, outputPer1kUsd: 0 };
  const defaults: ServerConfig['madre']['prices'] = { cerebras: zero, mistral: zero, cloudflare: zero, nvidia: zero };
  const raw = str(env, 'MADRE_PRICES_JSON');
  if (raw === undefined) return defaults;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error('MADRE_PRICES_JSON must be valid JSON, e.g. {"openai:gpt-x":{"inputPer1kUsd":0.001,"outputPer1kUsd":0.002}}.');
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new Error('MADRE_PRICES_JSON must be a JSON object.');
  const out: ServerConfig['madre']['prices'] = { ...defaults };
  for (const [key, value] of Object.entries(parsed)) {
    const v = value as { inputPer1kUsd?: unknown; outputPer1kUsd?: unknown };
    if (typeof v?.inputPer1kUsd !== 'number' || typeof v?.outputPer1kUsd !== 'number' || v.inputPer1kUsd < 0 || v.outputPer1kUsd < 0) {
      throw new Error(`MADRE_PRICES_JSON entry "${key}" needs non-negative numeric inputPer1kUsd and outputPer1kUsd.`);
    }
    out[key] = { inputPer1kUsd: v.inputPer1kUsd, outputPer1kUsd: v.outputPer1kUsd };
  }
  return out;
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

  const modeRaw = str(env, 'DEFAULT_MISSION_MODE') ?? 'madre';
  if (modeRaw !== 'classic' && modeRaw !== 'madre') {
    throw new Error(`DEFAULT_MISSION_MODE must be "classic" or "madre", got "${modeRaw}".`);
  }
  const onExceedRaw = str(env, 'MADRE_BUDGET_ON_EXCEED') ?? 'block';
  if (onExceedRaw !== 'block' && onExceedRaw !== 'fallback_local' && onExceedRaw !== 'ask') {
    throw new Error(`MADRE_BUDGET_ON_EXCEED must be block, fallback_local or ask, got "${onExceedRaw}".`);
  }

  const accessPassword = str(env, 'APP_PASSWORD');
  const hasRealKey = ['OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'GOOGLE_API_KEY', 'GEMINI_API_KEY', 'OPENAI_COMPAT_API_KEY', 'CEREBRAS_API_KEY', 'MISTRAL_API_KEY', 'CLOUDFLARE_API_TOKEN', 'NVIDIA_API_KEY', 'TAVILY_API_KEY', 'GITHUB_TOKEN'].some(
    (name) => str(env, name) !== undefined,
  );
  if (env.NODE_ENV === 'production' && hasRealKey && accessPassword === undefined && !bool(env, 'ALLOW_OPEN_ACCESS', false)) {
    throw new Error(
      'Hay claves de proveedores reales pero no APP_PASSWORD: cualquiera con la URL gastaría tu crédito. ' +
        'Define APP_PASSWORD (o ALLOW_OPEN_ACCESS=true si asumes el riesgo en una red de confianza).',
    );
  }

  return {
    port: int(env, 'PORT', 3001),
    accessPassword,
    webDistDir: str(env, 'WEB_DIST_DIR'),
    corsOrigins: (str(env, 'CORS_ORIGIN') ?? 'http://localhost:5173')
      .split(',')
      .map((o) => o.trim())
      .filter(Boolean),
    logLevel: logLevelRaw as ServerConfig['logLevel'],
    version: str(env, 'APP_VERSION') ?? '0.1.0',

    // 600/min is roughly twenty times what the app's own polling needs, so a
    // normal session never meets it and a stuck loop does.
    rateLimit: {
      max: int(env, 'RATE_LIMIT_MAX', 600),
      windowMs: int(env, 'RATE_LIMIT_WINDOW_MS', 60_000),
    },

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

    defaultMissionMode: modeRaw,
    ollamaBaseUrl: str(env, 'OLLAMA_BASE_URL'),
    enableWikipedia: bool(env, 'WIKIPEDIA_ENABLED', env.NODE_ENV === 'production'),
    enableWebFetch: bool(env, 'WEB_FETCH_ENABLED', env.NODE_ENV === 'production'),
    enableNews: bool(env, 'NEWS_ENABLED', env.NODE_ENV === 'production'),
    balanceProviders: bool(env, 'MADRE_BALANCE_PROVIDERS', env.NODE_ENV === 'production'),
    webSearchApiKey: str(env, 'TAVILY_API_KEY') ?? str(env, 'SEARCH_API_KEY'),
    githubToken: str(env, 'GITHUB_TOKEN'),
    githubSitesRepo: str(env, 'GITHUB_SITES_REPO'),
    realProviders: realProviderOptionsFromEnv(env),
    disabledProviders: (str(env, 'MADRE_DISABLED_PROVIDERS') ?? '')
      .split(',')
      .map((id) => id.trim().toLowerCase())
      .filter(Boolean),
    madre: {
      parallelism: Math.max(1, int(env, 'MADRE_PARALLELISM', 2)),
      maxRevisionRounds: int(env, 'MADRE_MAX_REVISION_ROUNDS', 2),
      budget: {
        perMissionUsd: money(env, 'MADRE_BUDGET_PER_MISSION_USD'),
        dailyUsd: money(env, 'MADRE_BUDGET_DAILY_USD'),
        monthlyUsd: money(env, 'MADRE_BUDGET_MONTHLY_USD'),
        onExceed: onExceedRaw,
        alertAtFraction: fraction(env, 'MADRE_BUDGET_ALERT_AT_PERCENT'),
        perToolUsd: toolBudgets(env),
      },
      prices: prices(env),
    },
  };
}
