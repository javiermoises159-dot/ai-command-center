/**
 * Migration runner.
 *
 * Applies every `.sql` file in `./migrations` in filename order, inside a
 * transaction, recording what was applied in `_acc_migrations`. Re-running is a
 * no-op.
 *
 * Deliberately not `drizzle-kit migrate`: the server calls this on boot when
 * DB_AUTO_MIGRATE is on, and that path should not depend on a dev CLI.
 */

import { readdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

/**
 * Default location: a `migrations` folder beside the running module.
 *
 * Under tsx that is `packages/database/src/migrations`. In the bundled server
 * it is `apps/server/dist/migrations`, which the build script populates — so
 * boot-time auto-migration works in production without a special case here.
 */
const DEFAULT_MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), 'migrations');

export interface MigrateOptions {
  connectionString: string;
  ssl?: boolean;
  log?: (message: string) => void;
  /** Override the SQL directory. Defaults to `migrations` beside this module. */
  migrationsDir?: string;
}

export async function migrate(options: MigrateOptions): Promise<string[]> {
  const log = options.log ?? ((message: string) => console.log(`[migrate] ${message}`));
  const migrationsDir = options.migrationsDir ?? DEFAULT_MIGRATIONS_DIR;
  const client = new pg.Client({
    connectionString: options.connectionString,
    ...(options.ssl === true ? { ssl: { rejectUnauthorized: false } } : {}),
  });

  await client.connect();
  const applied: string[] = [];

  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS _acc_migrations (
        name       text        PRIMARY KEY,
        applied_at timestamptz NOT NULL DEFAULT now()
      )
    `);

    const files = (await readdir(migrationsDir)).filter((f) => f.endsWith('.sql')).sort();

    const { rows } = await client.query<{ name: string }>('SELECT name FROM _acc_migrations');
    const done = new Set(rows.map((r) => r.name));

    for (const file of files) {
      if (done.has(file)) continue;

      const sql = await readFile(join(migrationsDir, file), 'utf8');
      log(`applying ${file}`);

      await client.query('BEGIN');
      try {
        await client.query(sql);
        await client.query('INSERT INTO _acc_migrations (name) VALUES ($1)', [file]);
        await client.query('COMMIT');
        applied.push(file);
      } catch (error) {
        await client.query('ROLLBACK');
        throw new Error(`Migration ${file} failed: ${error instanceof Error ? error.message : String(error)}`, {
          cause: error,
        });
      }
    }

    log(applied.length === 0 ? 'database is up to date' : `applied ${applied.length} migration(s)`);
    return applied;
  } finally {
    await client.end();
  }
}

// `pnpm --filter @acc/database migrate`
//
// Only when this file itself is the entry point. In the bundled server the
// bundle IS the entry point, so `import.meta.url` alone matches too and the CLI
// branch would run a second, concurrent migration next to the container's own —
// on a fresh database the two race and one dies with a duplicate-type error.
const isCliEntry =
  process.argv[1] !== undefined &&
  import.meta.url === `file://${process.argv[1]}` &&
  /(^|[\\/])migrate\.(ts|js|mjs|cjs)$/.test(process.argv[1]);
if (isCliEntry) {
  const connectionString = process.env['DATABASE_URL'];
  if (connectionString === undefined || connectionString === '') {
    console.error('DATABASE_URL is not set.');
    process.exit(1);
  }
  migrate({ connectionString, ssl: process.env['DB_SSL'] === 'true' }).catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
