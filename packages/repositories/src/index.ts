/**
 * Repository factory.
 *
 * `PERSISTENCE=postgres` (the default) uses Drizzle; `PERSISTENCE=memory` uses
 * the in-memory adapter for demos and tests. The Drizzle module is imported
 * dynamically so that selecting `memory` never loads `pg` or `drizzle-orm`.
 */

import type { Repositories } from '@acc/domain';
import { createMemoryRepositories } from './memory/index.ts';

export { createMemoryRepositories } from './memory/index.ts';

export type PersistenceMode = 'postgres' | 'memory';

export interface PersistenceConfig {
  mode: PersistenceMode;
  /** Required when mode is 'postgres'. */
  connectionString?: string;
  poolMax?: number;
  ssl?: boolean;
}

export async function createRepositories(config: PersistenceConfig): Promise<Repositories> {
  if (config.mode === 'memory') return createMemoryRepositories();

  if (config.connectionString === undefined || config.connectionString === '') {
    throw new Error('DATABASE_URL is required when PERSISTENCE=postgres.');
  }

  const [{ createDatabase }, { createDrizzleRepositories }] = await Promise.all([
    import('@acc/database'),
    import('./drizzle/index.ts'),
  ]);

  const database = createDatabase({
    connectionString: config.connectionString,
    ...(config.poolMax !== undefined ? { poolMax: config.poolMax } : {}),
    ...(config.ssl !== undefined ? { ssl: config.ssl } : {}),
  });

  await database.ping();
  return createDrizzleRepositories(database.db, database.close);
}
