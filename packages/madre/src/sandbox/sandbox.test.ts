import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';

import { LocalSandbox, SandboxError } from './local-sandbox.ts';

const base = path.join(tmpdir(), `madre-sandbox-test-${process.pid}`);
after(async () => {
  await fs.rm(base, { recursive: true, force: true });
});

const create = (limits = {}) => LocalSandbox.create('t', { baseDir: base, limits });
const code = (fn: () => unknown, expected: SandboxError['code']) =>
  assert.rejects(async () => fn(), (e: unknown) => e instanceof SandboxError && e.code === expected);

describe('local sandbox', () => {
  it('writes, reads, lists and reports usage inside its own directory', async () => {
    const box = await create();
    await box.write('notes/a.txt', 'hello');
    await box.write('outputs/report.md', '# report');
    assert.equal(await box.read('notes/a.txt'), 'hello');
    assert.deepEqual((await box.list()).map((f) => f.path), ['notes/a.txt', 'outputs/report.md']);
    assert.deepEqual((await box.artifacts()).map((f) => f.path), ['outputs/report.md']);
    assert.deepEqual({ files: (await box.usage()).files, bytes: (await box.usage()).bytes }, { files: 2, bytes: 13 });
    assert.ok(box.root.startsWith(base));
    await box.cleanup();
  });

  it('rejects every way out of the root', async () => {
    const box = await create();
    for (const bad of ['../x', 'a/../../x', '/etc/passwd', 'C:\\Windows\\x', '\\\\server\\share']) {
      await code(() => box.write(bad, 'x'), 'path_escape');
      await code(() => box.read(bad), 'path_escape');
    }
    await code(() => box.write('', 'x'), 'invalid_path');
    await code(() => box.write('a\0b', 'x'), 'invalid_path');
    await code(() => box.write('.', 'x'), 'invalid_path');
    await box.cleanup();
  });

  it('refuses to follow a symbolic link out of the sandbox', async () => {
    const box = await create();
    const outside = path.join(base, 'outside.txt');
    await fs.mkdir(base, { recursive: true });
    await fs.writeFile(outside, 'secret');
    await fs.symlink(outside, path.join(box.root, 'link.txt'));
    await code(() => box.read('link.txt'), 'path_escape');
    await code(() => box.write('link.txt', 'overwrite'), 'path_escape');
    assert.equal(await fs.readFile(outside, 'utf8'), 'secret');
    await box.cleanup();
  });

  it('enforces size, count, total and depth limits', async () => {
    const box = await create({ maxFileBytes: 10, maxTotalBytes: 15, maxFiles: 2, maxDepth: 2 });
    await code(() => box.write('big.txt', 'x'.repeat(11)), 'limit_exceeded');
    await box.write('a.txt', '1234567890');
    await code(() => box.write('b.txt', '123456'), 'limit_exceeded'); // total
    await box.write('b.txt', '12345');
    await code(() => box.write('c.txt', '1'), 'limit_exceeded'); // count
    await box.write('a.txt', '12'); // overwriting does not count twice
    await code(() => box.write('x/y/z.txt', '1'), 'limit_exceeded'); // depth
    await box.cleanup();
  });

  it('never executes code', async () => {
    const box = await create();
    assert.throws(() => box.exec('echo hi'), (e: unknown) => e instanceof SandboxError && e.code === 'exec_disabled');
    await box.cleanup();
  });

  it('keeps a bounded log and cleans up completely', async () => {
    const box = await create({ maxLogEntries: 3 });
    for (let i = 0; i < 6; i++) box.log('info', `m${i}`);
    assert.deepEqual(box.logEntries().map((l) => l.message), ['m3', 'm4', 'm5']);
    await box.write('a.txt', 'x');
    await box.cleanup();
    await assert.rejects(fs.access(box.root));
    await code(() => box.read('a.txt'), 'closed');
    await box.cleanup(); // safe to repeat
  });

  it('rejects unsafe sandbox ids', async () => {
    await code(() => LocalSandbox.create('../evil', { baseDir: base }), 'invalid_path');
  });
});
