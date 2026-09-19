/**
 * Server entry point.
 *
 * Boots the container, starts Express, and shuts down cleanly so an in-flight
 * mission gets a chance to finish rather than being killed mid-agent.
 */

import { loadConfig } from './config.ts';
import { createContainer } from './container.ts';
import { createExpressApp } from './express-adapter.ts';

async function main(): Promise<void> {
  const config = loadConfig();
  const container = await createContainer(config);
  const app = createExpressApp(container);

  const server = app.listen(config.port, () => {
    container.logger.info('server listening', {
      port: config.port,
      persistence: config.persistence,
      docs: `http://localhost:${config.port}/api/openapi.json`,
    });
  });

  let shuttingDown = false;
  const shutdown = (signal: string): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    container.logger.info('shutting down', { signal });

    server.close(() => {
      void container
        .shutdown()
        .then(() => process.exit(0))
        .catch(() => process.exit(1));
    });

    // Never hang forever waiting for a stuck connection.
    setTimeout(() => {
      container.logger.error('shutdown timed out, forcing exit');
      process.exit(1);
    }, 20_000).unref();
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

main().catch((error: unknown) => {
  console.error('[fatal]', error instanceof Error ? error.stack ?? error.message : error);
  process.exit(1);
});
