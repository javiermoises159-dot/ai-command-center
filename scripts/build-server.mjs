/**
 * Bundles the server into a single file.
 *
 * Workspace packages are consumed as TypeScript source, so a plain `tsc` emit
 * would leave `@acc/*` path aliases unresolved at runtime. esbuild reads the
 * tsconfig paths and inlines them, which turns the whole backend into one
 * `apps/server/dist/main.js` that `node` runs with no loader and no path mapping.
 *
 * Two things deliberately do NOT get bundled:
 *
 *  - `pg`, because it loads native bindings. The output therefore lives inside
 *    apps/server so Node's resolution finds apps/server/node_modules/pg — which
 *    is why `pg` is a declared dependency of the server app even though the
 *    import lives in @acc/database.
 *  - the SQL migrations, which are read from disk at boot. They are copied next
 *    to the bundle so `migrate()`'s default lookup (a `migrations` folder beside
 *    the running module) resolves in both dev and production.
 */

import { build } from 'esbuild';
import { cp, mkdir, readdir, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const outdir = join(root, 'apps', 'server', 'dist');
const migrationsSrc = join(root, 'packages', 'database', 'src', 'migrations');

await rm(outdir, { recursive: true, force: true });
await mkdir(outdir, { recursive: true });

const result = await build({
  entryPoints: [join(root, 'apps', 'server', 'src', 'main.ts')],
  outfile: join(outdir, 'main.js'),
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'esm',
  sourcemap: true,
  minify: false,
  external: ['pg', 'pg-native'],
  tsconfig: join(root, 'tsconfig.json'),
  logLevel: 'info',
  banner: {
    // Some CJS dependencies reach for `require` at runtime under ESM.
    js: "import { createRequire as __acc_cr } from 'node:module'; const require = __acc_cr(import.meta.url);",
  },
});

if (result.errors.length > 0) {
  console.error(`Build failed with ${result.errors.length} error(s).`);
  process.exit(1);
}

await cp(migrationsSrc, join(outdir, 'migrations'), { recursive: true });
const copied = (await readdir(join(outdir, 'migrations'))).filter((f) => f.endsWith('.sql'));

console.log(`Server bundled to apps/server/dist/main.js (+${copied.length} migration file(s))`);
