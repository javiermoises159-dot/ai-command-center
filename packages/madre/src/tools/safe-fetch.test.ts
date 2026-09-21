import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { assertSafeUrl, extractText, extractTitle, fetchPage, isPrivateAddress, UnsafeUrlError } from './safe-fetch.ts';

describe('isPrivateAddress', () => {
  it('refuses loopback, private, link-local, metadata, CGNAT and mapped addresses', () => {
    for (const a of ['127.0.0.1', '10.1.2.3', '172.16.0.1', '172.31.255.255', '192.168.1.1', '169.254.169.254', '100.64.0.1', '0.0.0.0', '224.0.0.1', '::1', '::', 'fe80::1', 'fd00::1', '::ffff:127.0.0.1', '::ffff:7f00:1']) {
      assert.equal(isPrivateAddress(a), true, a);
    }
  });
  it('allows public addresses', () => {
    for (const a of ['8.8.8.8', '1.1.1.1', '172.32.0.1', '93.184.216.34', '2606:4700:4700::1111']) assert.equal(isPrivateAddress(a), false, a);
  });
});

describe('assertSafeUrl', () => {
  it('refuses what an attacker would try', () => {
    for (const u of ['file:///etc/passwd', 'ftp://example.com', 'http://localhost/', 'http://127.0.0.1/', 'http://[::1]/', 'http://169.254.169.254/latest/meta-data', 'http://user:pw@example.com/', 'https://example.com:8443/', 'http://intranet/', 'not a url']) {
      assert.throws(() => assertSafeUrl(u), UnsafeUrlError, u);
    }
  });
  it('accepts an ordinary public page', () => {
    assert.equal(assertSafeUrl('https://example.com/a?b=1').hostname, 'example.com');
  });
});

describe('fetchPage', () => {
  it('never reaches localhost, even by name', async () => {
    await assert.rejects(fetchPage('http://localhost/'), UnsafeUrlError);
    await assert.rejects(fetchPage('http://127.0.0.1:80/'), UnsafeUrlError);
  });
});

describe('text extraction', () => {
  it('keeps the readable text and drops scripts, styles and tags', () => {
    const html = '<html><head><title>Hola &amp; adiós</title><style>p{}</style></head><body><script>alert(1)</script><h1>Precios</h1><p>Desde 200&nbsp;&euro; al mes</p></body></html>';
    assert.equal(extractTitle(html), 'Hola & adiós');
    const text = extractText(html);
    assert.match(text, /Precios/);
    assert.match(text, /200 € al mes/);
    assert.doesNotMatch(text, /alert|p\{\}|<h1>/);
  });
});
