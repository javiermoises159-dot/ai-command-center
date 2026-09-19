/** Writes the OpenAPI document to disk: `pnpm --filter @acc/contracts openapi`. */

import { writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildOpenApiDocument } from './openapi.ts';

const target = join(dirname(dirname(fileURLToPath(import.meta.url))), 'openapi.json');

await writeFile(target, `${JSON.stringify(buildOpenApiDocument(), null, 2)}\n`, 'utf8');
console.log(`Wrote ${target}`);
