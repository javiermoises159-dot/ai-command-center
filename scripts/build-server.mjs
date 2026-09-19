/**
 * Bundles the server into a single file.
 *
 * Workspace packages are consumed as TypeScript source, so a plain `tsc` emit
 * would leave `@acc/*` path aliases unresolved at runtime. esbuild reads the
 * tsconfig paths and inlines them, which turns the whole backend into one
 * `dist/server/main.js` that `node` runs with no loader and no path mapping.
 *
 * `pg` stays external because it loads native bindings.
 */

import { build } from 'esbuild';
import { rm, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const outdir = join(root, 'dist', 'server');

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
  // Native bindings cannot be bundled; everything else is inlined so the
  // output runs from a directory containing only node_modules/pg.
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

console.log(`Server bundled to ${join('dist', 'server', 'main.js')}`);
