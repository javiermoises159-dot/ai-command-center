/**
 * Runs the API and the web app together with one command, and makes sure that
 * killing one kills the other — a stray server holding port 3001 after Ctrl-C
 * is a bad first five minutes with a project.
 */

import { spawn } from 'node:child_process';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const npx = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm';

const children = [
  spawn(npx, ['--filter', '@acc/server', 'dev'], { cwd: root, stdio: 'inherit' }),
  spawn(npx, ['--filter', '@acc/web', 'dev'], { cwd: root, stdio: 'inherit' }),
];

let shuttingDown = false;
function shutdown(code = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const child of children) child.kill('SIGTERM');
  setTimeout(() => process.exit(code), 500).unref();
}

for (const child of children) {
  child.on('exit', (code) => shutdown(code ?? 0));
}

process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));
