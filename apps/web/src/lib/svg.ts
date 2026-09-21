/**
 * Logos come back from the design agent as SVG text. They are shown inside an
 * <img>, which cannot run scripts or load anything by itself; on top of that a
 * drawing is only shown when it looks complete and self-contained, so agent
 * output can never inject markup or call out to another site.
 */

const UNSAFE = /<script|<foreignObject|<iframe|<embed|<object|javascript:|\son[a-z]+\s*=|@import|(?:href|src)\s*=\s*["']?\s*(?:https?:|data:|\/\/)|url\(\s*["']?\s*(?:https?:|data:|\/\/)/i;

export function isSafeSvg(source: string): boolean {
  const svg = source.trim();
  return /^<svg[\s>]/i.test(svg) && /<\/svg>\s*$/i.test(svg) && svg.length <= 20_000 && !UNSAFE.test(svg);
}

export function svgDataUrl(source: string): string {
  const svg = source.includes('xmlns=') ? source.trim() : source.trim().replace(/^<svg/i, '<svg xmlns="http://www.w3.org/2000/svg"');
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}
