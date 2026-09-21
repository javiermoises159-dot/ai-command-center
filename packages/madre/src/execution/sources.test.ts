import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { collectSources, withSources } from './sources.ts';

const ok = (toolId: string, output: unknown) => ({ toolId, requestId: 'r', ok: true, output, error: null, verified: false });

describe('sources section', () => {
  const steps = [
    { toolResults: [ok('web.search', { results: [{ title: 'Precios GBP', url: 'https://a.example/p' }, { title: 'x', url: 'javascript:alert(1)' }] }), ok('memory.recall', { entries: [] })] },
    { toolResults: [ok('web.fetch', { url: 'https://b.example/', title: 'Página [B]' }), ok('web.search', { results: [{ title: 'Repetida', url: 'https://a.example/p' }] }), { toolId: 'web.search', requestId: 'r', ok: false, output: null, error: 'x', verified: false }] },
  ];

  it('lists each real url once and ignores anything that is not http(s)', () => {
    const list = collectSources(steps as never);
    assert.deepEqual(list.map((s) => s.url), ['https://a.example/p', 'https://b.example/']);
    assert.equal(list[1]?.title, 'Página B');
  });

  it('appends a section to the report and leaves it alone when there are no sources', () => {
    const text = withSources('# Informe', steps as never)!;
    assert.match(text, /^# Informe\n\n## Fuentes consultadas/);
    assert.match(text, /- \[Precios GBP\]\(https:\/\/a\.example\/p\)/);
    assert.equal(withSources('# Informe', [{ toolResults: [] }] as never), '# Informe');
    assert.equal(withSources(null, steps as never), null);
  });
});

import { svgBlocks, withLogos } from './sources.ts';

describe('logos section', () => {
  const good = '<svg viewBox="0 0 512 512" xmlns="http://www.w3.org/2000/svg"><circle cx="256" cy="256" r="200" fill="#3e2723"/></svg>';
  const text = `Opción A\n\`\`\`svg\n${good}\n\`\`\`\nOpción B\n\`\`\`svg\n<svg><script>alert(1)</script></svg>\n\`\`\`\nOpción C\n\`\`\`svg\n<svg><image href="https://evil.example/x.png"/></svg>\n\`\`\``;

  it('keeps only complete, self-contained drawings', () => {
    assert.deepEqual(svgBlocks(text), [good]);
  });

  it('appends them to the report, or leaves it alone', () => {
    const out = withLogos('# Informe', [text])!;
    assert.match(out, /## Logotipos/);
    assert.ok(out.includes(good));
    assert.doesNotMatch(out, /script|evil\.example/);
    assert.equal(withLogos('# Informe', ['sin dibujos']), '# Informe');
    assert.equal(withLogos(null, [text]), null);
  });
});
