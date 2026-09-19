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
  MissionOrchestrator,
  MissionService,
  recoverUnfinishedRuns,
} from '@acc/orchestrator';
import { createProviderRegistry, type ProviderRegistry } from '@acc/providers';
import { createRepositories } from '@acc/repositories';

import type { ServerConfig } from './config.ts';
import { createLogger } from './logger.ts';

export interface Container {
  config: ServerConfig;
  logger: Logger;
  repositories: Repositories;
  providers: ProviderRegistry;
  queue: JobQueue;
  missions: MissionService;
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

  const providers = createProviderRegistry({
    mock: { minLatencyMs: config.mockMinLatencyMs, maxLatencyMs: config.mockMaxLatencyMs },
  });

  // Fail fast at boot rather than on the first mission if AI_PROVIDER is wrong.
  const resolved = providers.resolve(config.providerId, config.model);
  logger.info('provider selected', { provider: resolved.provider.id, model: resolved.model });

  const queue = new InProcessJobQueue({ concurrency: config.queueConcurrency, logger });

  const orchestrator = new MissionOrchestrator({
    repositories,
    providers,
    logger,
    options: {
      continueOnWorkerFailure: config.continueOnWorkerFailure,
      agentTimeoutMs: config.agentTimeoutMs,
    },
  });

  queue.process(async (job) => {
    await orchestrator.execute(job.runId);
  });

  // The in-process queue does not survive a restart, so anything left running
  // is closed before we start accepting traffic.
  await recoverUnfinishedRuns({ repositories, logger });
  queue.start();

  const missions = new MissionService({ repositories, providers, queue, logger });

  return {
    config,
    logger,
    repositories,
    providers,
    queue,
    missions,
    async shutdown() {
      logger.info('draining job queue');
      await queue.stop(15_000);
      await repositories.close();
    },
  };
}
