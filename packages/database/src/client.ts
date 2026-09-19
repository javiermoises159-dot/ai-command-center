/**
 * Postgres connection and Drizzle instance.
 *
 * Owned by this package so nothing else has to know how the pool is built.
 */

import { drizzle } from 'drizzle-orm/node-postgres';
import pg from 'pg';

import * as schema from './schema.ts';

export type Database = ReturnType<typeof createDatabase>['db'];

export interface DatabaseOptions {
  connectionString: string;
  poolMax?: number;
  /** Required by most hosted providers; off by default for local Postgres. */
  ssl?: boolean;
}

export function createDatabase(options: DatabaseOptions) {
  const pool = new pg.Pool({
    connectionString: options.connectionString,
    max: options.poolMax ?? 10,
    ...(options.ssl === true ? { ssl: { rejectUnauthorized: false } } : {}),
  });

  // A pool error with no listener takes the process down in Node. Agents can
  // run for a while, so a dropped backend must not kill an in-flight mission.
  pool.on('error', (error) => {
    console.error('[database] idle client error', error.message);
  });

  const db = drizzle(pool, { schema });

  return {
    db,
    pool,
    close: () => pool.end(),
    ping: async () => {
      const client = await pool.connect();
      try {
        await client.query('SELECT 1');
        return true;
      } finally {
        client.release();
      }
    },
  };
}

export { schema };
