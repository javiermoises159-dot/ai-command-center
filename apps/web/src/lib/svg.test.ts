import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { isSafeSvg, svgDataUrl } from './svg.ts';

describe('svg logos', () => {
  const good = '<svg viewBox="0 0 10 10"><circle cx="5" cy="5" r="4" fill="#123456"/></svg>';
  it('accepts a complete drawing and refuses anything that could run or load something', () => {
    assert.equal(isSafeSvg(good), true);
    for (const bad of ['<svg><script>1</script></svg>', '<svg onload="x()"></svg>', '<svg><image href="https://x.example/a.png"/></svg>', '<svg><a xlink:href="javascript:1"/></svg>', '<div>hola</div>', '<svg><g>', '<svg><foreignObject/></svg>']) {
      assert.equal(isSafeSvg(bad), false, bad);
    }
  });
  it('adds the namespace an <img> needs', () => {
    assert.match(decodeURIComponent(svgDataUrl(good)), /xmlns="http:\/\/www\.w3\.org\/2000\/svg"/);
  });
});
