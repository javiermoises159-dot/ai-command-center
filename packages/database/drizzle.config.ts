import { defineConfig } from 'drizzle-kit';

/**
 * drizzle-kit is used for DIFFING ONLY, not as the migration runner.
 *
 * `src/migrations/*.sql` is hand-authored and is the single source of truth for
 * what actually runs (applied by `src/migrate.ts`). Letting drizzle-kit write
 * into that folder would mix two numbering schemes and two journals in one
 * directory, and the generated SQL is not idempotent.
 *
 * So `pnpm db:diff` writes a proposed migration into `drizzle-generated/`, which
 * is gitignored. Review it, then copy the statements into a new numbered file in
 * `src/migrations/`.
 */
export default defineConfig({
  schema: './src/schema.ts',
  out: './drizzle-generated',
  dialect: 'postgresql',
  dbCredentials: {
    url: process.env['DATABASE_URL'] ?? 'postgres://postgres:postgres@localhost:5432/ai_command_center',
  },
  verbose: true,
  strict: true,
});
