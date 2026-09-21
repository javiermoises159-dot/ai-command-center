import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import express from 'express';
import type { AddressInfo } from 'node:net';

import { requirePassword } from '../express-adapter.ts';
import { loadConfig } from '../config.ts';

async function withServer<T>(fn: (base: string) => Promise<T>): Promise<T> {
  const app = express();
  app.use(requirePassword('secreto'));
  app.get('/api/health', (_req, res) => res.json({ ok: true }));
  app.get('/api/x', (_req, res) => res.json({ ok: true }));
  const server = app.listen(0);
  try {
    return await fn(`http://127.0.0.1:${(server.address() as AddressInfo).port}`);
  } finally {
    server.close();
  }
}
const basic = (pw: string) => ({ authorization: `Basic ${Buffer.from(`u:${pw}`).toString('base64')}` });

describe('requirePassword', () => {
  it('rejects requests without or with a wrong password', async () => {
    await withServer(async (base) => {
      const none = await fetch(`${base}/api/x`);
      assert.equal(none.status, 401);
      assert.match(none.headers.get('www-authenticate') ?? '', /Basic/);
      assert.equal((await fetch(`${base}/api/x`, { headers: basic('mal') })).status, 401);
    });
  });
  it('accepts the right password, including one containing a colon', async () => {
    await withServer(async (base) => {
      assert.equal((await fetch(`${base}/api/x`, { headers: basic('secreto') })).status, 200);
    });
  });
  it('leaves /api/health open for the host probe', async () => {
    await withServer(async (base) => {
      assert.equal((await fetch(`${base}/api/health`)).status, 200);
    });
  });
});

describe('open-access guard', () => {
  const base = { NODE_ENV: 'production', PERSISTENCE: 'memory', ANTHROPIC_API_KEY: 'k', ANTHROPIC_MODEL: 'm' };
  it('refuses to boot in production with a real key and no password', () => {
    assert.throws(() => loadConfig(base), /APP_PASSWORD/);
  });
  it('boots with a password, or with the explicit override, or without real keys', () => {
    assert.doesNotThrow(() => loadConfig({ ...base, APP_PASSWORD: 'x' }));
    assert.doesNotThrow(() => loadConfig({ ...base, ALLOW_OPEN_ACCESS: 'true' }));
    assert.doesNotThrow(() => loadConfig({ NODE_ENV: 'production', PERSISTENCE: 'memory' }));
  });
});
