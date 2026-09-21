/**
 * Composition root.
 *
 * The one place that knows which concrete adapter satisfies each port. Every
 * other module receives its collaborators as constructor arguments, which is
 * what makes them testable with in-memory doubles.
 */

import type { JobQueue, Logger, Repositories } from '@acc/domain';
import {
  InProcessJobQueue,
  MissionService,
  recoverUnfinishedRuns,
} from '@acc/orchestrator';
import { createMadre, type Madre } from '@acc/madre';
import { createProviderRegistry, discoverOllamaModels, type ProviderRegistry } from '@acc/providers';
import { createRepositories } from '@acc/repositories';

import type { ServerConfig } from './config.ts';
import { GitHubPagesPublisher, parseRepo, type SitePublisher } from './publish/github-pages.ts';
import { buildMedia, CloudflareMedia, GeminiVoice, type MediaGenerator } from './content/media.ts';
import { createClipMaker, createEditPlanner, type ClipMaker } from './content/clips.ts';
import { createStudioBriefer, type StudioBriefer } from './content/studio.ts';
import { createPieceDrafter, type PieceDrafter } from './content/draft.ts';
import { createReelMaker, ffmpegAvailable, type ReelMaker } from './content/video.ts';
import { MemoryContentStore, type ContentStore } from './content/store.ts';
import { createLogger } from './logger.ts';

export interface Container {
  config: ServerConfig;
  logger: Logger;
  repositories: Repositories;
  providers: ProviderRegistry;
  queue: JobQueue;
  missions: MissionService;
  madre: Madre;
  /** Publishes finished websites to GitHub Pages; undefined without a token. */
  sitePublisher: SitePublisher | undefined;
  /** Content calendar storage and (when Cloudflare is configured) media generation. */
  content: { store: ContentStore; media: MediaGenerator | undefined; video: ReelMaker | undefined; drafter: PieceDrafter; studio: StudioBriefer; clips: ClipMaker | undefined };
  shutdown(): Promise<void>;
}

export async function createContainer(config: ServerConfig): Promise<Container> {
  const logger = createLogger(config.logLevel, { app: 'ai-command-center' });

  if (config.persistence === 'memory') {
    logger.warn('PERSISTENCE=memory — data is lost on restart. Use postgres for anything real.');
  }

  if (config.persistence === 'postgres' && config.dbAutoMigrate) {
    const { migrate } = await import('@acc/database');
    await migrate({
      connectionString: config.databaseUrl ?? '',
      ssl: config.dbSsl,
      log: (message) => logger.info(message, { component: 'migrate' }),
    });
  }

  const repositories = await createRepositories({
    mode: config.persistence,
    ...(config.databaseUrl !== undefined ? { connectionString: config.databaseUrl } : {}),
    poolMax: config.dbPoolMax,
    ssl: config.dbSsl,
  });

  // Ollama is only registered as usable when a server answers at OLLAMA_BASE_URL
  // and has at least one model. Otherwise it stays listed as NOT CONNECTED.
  const ollama = await discoverOllamaModels(config.ollamaBaseUrl);
  if (config.ollamaBaseUrl !== undefined) {
    if (ollama.error === null) logger.info('ollama connected', { models: ollama.models.length });
    else logger.warn('ollama not connected', { reason: ollama.error });
  }

  const providers = createProviderRegistry({
    mock: { minLatencyMs: config.mockMinLatencyMs, maxLatencyMs: config.mockMaxLatencyMs },
    ollama: { baseUrl: config.ollamaBaseUrl, models: ollama.models },
    openai: config.realProviders.openai,
    anthropic: config.realProviders.anthropic,
    gemini: config.realProviders.gemini,
    openaiCompatible: config.realProviders.openaiCompatible,
    cerebras: config.realProviders.cerebras,
    mistral: config.realProviders.mistral,
    cloudflare: config.realProviders.cloudflare,
    nvidia: config.realProviders.nvidia,
  });
  // Say what is configured — the names only, never a key. A missing key is a
  // normal state, not an error: the provider is simply reported as unconfigured.
  for (const descriptor of providers.describe()) {
    if (descriptor.id === 'openai' || descriptor.id === 'anthropic' || descriptor.id === 'gemini' || descriptor.id === 'openai-compatible' || descriptor.id === 'cerebras' || descriptor.id === 'mistral' || descriptor.id === 'cloudflare' || descriptor.id === 'nvidia') {
      if (descriptor.configured === true) logger.info('real provider configured', { provider: descriptor.id, models: descriptor.models.map((m) => m.id) });
      else logger.info('real provider not configured', { provider: descriptor.id, requires: descriptor.requires });
    }
  }

  // Fail fast at boot rather than on the first mission if AI_PROVIDER is wrong.
  const resolved = providers.resolve(config.providerId, config.model);
  logger.info('provider selected', { provider: resolved.provider.id, model: resolved.model });

  const queue = new InProcessJobQueue({ concurrency: config.queueConcurrency, logger });

  // What the creative studio can really do with this server's keys and tools.
  const hasRealAi = providers.availableIds().some((id) => id !== 'mock');
  const hasCloudflare = config.cloudflareAccountId !== undefined && config.cloudflareApiToken !== undefined;
  const hasVoice = config.geminiApiKey !== undefined || hasCloudflare;
  const hasFfmpeg = ffmpegAvailable();
  const studio = [
    ...(hasRealAi ? ['script'] : []),
    ...(hasCloudflare ? ['image', 'transcribe'] : []),
    ...(hasVoice ? ['voice'] : []),
    ...(hasFfmpeg ? ['edit'] : []),
    ...(hasFfmpeg && hasCloudflare && hasVoice ? ['reel'] : []),
  ];

  const madre = createMadre({
    studio,
    repositories,
    providers,
    enqueue: (job) => queue.enqueue(job),
    budget: { ...config.madre.budget, perAgentUsd: {} },
    prices: config.madre.prices,
    classic: { continueOnWorkerFailure: config.continueOnWorkerFailure },
    ollamaBaseUrl: config.ollamaBaseUrl,
    webSearchApiKey: config.webSearchApiKey,
    enableWikipedia: config.enableWikipedia,
    enableWebFetch: config.enableWebFetch,
    enableNews: config.enableNews,
    balanceProviders: config.balanceProviders,
    disabledProviders: config.disabledProviders,
    engine: {
      parallelism: config.madre.parallelism,
      maxRevisionRounds: config.madre.maxRevisionRounds,
      agentTimeoutMs: config.agentTimeoutMs,
    },
  });

  // Both modes run on the MADRE engine, so both go through routing, permissions,
  // cost limits, the audit log, the trace, recovery and cancellation. `classic`
  // only selects the planner (the fixed eight-agent pipeline). A job with no
  // mode is a classic one, as the Job type documents.
  queue.process(async (job) => {
    await madre.execute({
      runId: job.runId,
      mode: job.mode === 'madre' ? 'madre' : 'classic',
      ...(job.resume === true ? { resume: true } : {}),
    });
  });

  // The in-process queue does not survive a restart. Before accepting traffic,
  // MADRE reconciles what the last process left behind: the persisted run state
  // is the source of truth, no run or step stays `running`, and the legacy
  // rows and the mission are aligned to it. A run paused for a person is kept;
  // one whose approvals are all decided is queued to continue.
  const recovery = await madre.recover();
  if (recovery.recovered.length > 0 || recovery.conflicts.length > 0 || recovery.missionsReconciled.length > 0) {
    logger.warn('recovered runs left by a restart', {
      recovered: recovery.recovered.map((r) => ({ runId: r.runId, outcome: r.outcome, retryable: r.retryable, steps: r.stepsChanged })),
      kept: recovery.kept,
      resumed: recovery.resumable.map((r) => r.runId),
      conflicts: recovery.conflicts,
      missionsReconciled: recovery.missionsReconciled,
    });
  }
  // Safety net: legacy runs that MADRE's recovery did not cover. After the
  // pass above this should close nothing; if it does, that is worth a warning.
  const swept = await recoverUnfinishedRuns({ repositories, logger, keepRun: (runId) => madre.isPaused(runId) });
  if (swept > 0) logger.warn('the safety-net sweep had to close runs the recovery pass left open', { count: swept });
  queue.start();

  // Publishing needs both the token and the repository; one without the other is a
  // misconfiguration worth saying, not a half-working feature.
  let sitePublisher: SitePublisher | undefined;
  if (config.githubToken !== undefined && config.githubSitesRepo !== undefined) {
    if (parseRepo(config.githubSitesRepo) === null) logger.warn('GITHUB_SITES_REPO is not "owner/repository": site publishing is off');
    else {
      sitePublisher = new GitHubPagesPublisher(config.githubToken, config.githubSitesRepo);
      logger.info('site publishing configured', { repo: sitePublisher.repo });
    }
  } else if (config.githubToken !== undefined || config.githubSitesRepo !== undefined) {
    logger.warn('site publishing needs both GITHUB_TOKEN and GITHUB_SITES_REPO: it is off');
  }

  let contentStore: ContentStore;
  let closeContent: (() => Promise<void>) | undefined;
  if (config.persistence === 'postgres') {
    const { createDatabase, PgContentStore } = await import('@acc/database');
    const contentDb = createDatabase({ connectionString: config.databaseUrl ?? '', poolMax: 2, ssl: config.dbSsl });
    contentStore = new PgContentStore(contentDb.pool);
    closeContent = () => contentDb.close();
  } else {
    contentStore = new MemoryContentStore();
  }
  const cloudflare = config.cloudflareAccountId !== undefined && config.cloudflareApiToken !== undefined ? new CloudflareMedia(config.cloudflareAccountId, config.cloudflareApiToken) : undefined;
  const gemini = config.geminiApiKey !== undefined ? new GeminiVoice(config.geminiApiKey, config.geminiTtsModel) : undefined;
  const media = buildMedia({ cloudflare, gemini });
  const video = ffmpegAvailable() ? createReelMaker() : undefined;
  if (video === undefined) logger.warn('ffmpeg not found: video creation is off');
  if (cloudflare === undefined && (config.cloudflareAccountId !== undefined || config.cloudflareApiToken !== undefined)) {
    logger.warn('image and voice generation need both CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN: it is off');
  }

  const missions = new MissionService({ repositories, providers, queue, logger, defaultMode: config.defaultMissionMode });

  return {
    config,
    logger,
    repositories,
    providers,
    queue,
    missions,
    madre,
    sitePublisher,
    content: { store: contentStore, media, video, drafter: createPieceDrafter(providers), studio: createStudioBriefer(providers), clips: ffmpegAvailable() ? createClipMaker({ plan: createEditPlanner(providers), transcribe: cloudflare === undefined ? undefined : (a) => cloudflare.transcribe(a) }) : undefined },
    async shutdown() {
      logger.info('draining job queue');
      await queue.stop(15_000);
      await repositories.close();
      await closeContent?.();
    },
  };
}
