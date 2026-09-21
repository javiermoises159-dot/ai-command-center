/**
 * Single-file websites made by the crew.
 *
 * The engineering step delivers ONE complete HTML document in a ```html block.
 * This module finds it and decides whether it is safe to show and to publish.
 * It is pure and isomorphic: the model runner, the server and the browser all
 * use the same rules, so what the preview accepts is exactly what gets published.
 *
 * The check is a defence in depth, not a proof. A page the crew wrote is code
 * that will run in a visitor's browser under the owner's name, and its inputs
 * include web text nobody vetted, so anything that could send data elsewhere,
 * load code from elsewhere or run dynamic code is refused. Ordinary links
 * (a WhatsApp or mail link the visitor taps) are fine.
 */

export const MAX_SITE_BYTES = 400_000;

const CHECKS: readonly { test: RegExp; problem: string }[] = [
  { test: /<script\b[^>]*\bsrc\s*=/i, problem: 'carga un script externo' },
  { test: /<(?:iframe|object|embed|applet|base)\b/i, problem: 'incrusta contenido externo (iframe, object, embed o base)' },
  { test: /<link\b[^>]*\bhref\s*=\s*["']?\s*(?:https?:)?\/\//i, problem: 'carga una hoja de estilos o un recurso externo' },
  { test: /@import\b/i, problem: 'importa CSS externo' },
  { test: /url\(\s*["']?\s*(?:https?:|\/\/)/i, problem: 'carga una imagen o fuente externa desde CSS' },
  { test: /<(?:img|source|video|audio|track|input)\b[^>]*\bsrc\s*=\s*["']?\s*(?:https?:)?\/\//i, problem: 'carga una imagen o un archivo externo' },
  { test: /<form\b[^>]*\baction\s*=\s*["']?\s*(?:https?:)?\/\//i, problem: 'envía un formulario a otro sitio' },
  { test: /<meta\b[^>]*http-equiv\s*=\s*["']?\s*refresh/i, problem: 'redirige automáticamente' },
  { test: /\b(?:fetch|XMLHttpRequest|WebSocket|EventSource|sendBeacon|importScripts)\b\s*[(.]?/, problem: 'usa la red desde el código (fetch, XHR, WebSocket…)' },
  { test: /\b(?:eval|Function)\s*\(|\bnew\s+Function\b|\bsetTimeout\s*\(\s*["'`]|\bsetInterval\s*\(\s*["'`]/, problem: 'ejecuta código dinámico (eval, new Function…)' },
  { test: /document\s*\.\s*cookie|indexedDB|serviceWorker/i, problem: 'accede a cookies o almacenamiento avanzado' },
  { test: /javascript\s*:/i, problem: 'usa enlaces javascript:' },
];

/** What is wrong with a page, in plain Spanish. Empty when it may be published. */
export function checkSiteHtml(html: string): string[] {
  const problems: string[] = [];
  if (!/^\s*(?:<!doctype html|<html[\s>])/i.test(html) || !/<\/html>\s*$/i.test(html)) problems.push('no es un documento HTML completo');
  if (new TextEncoder().encode(html).length > MAX_SITE_BYTES) problems.push(`pesa más de ${Math.round(MAX_SITE_BYTES / 1000)} KB`);
  for (const { test, problem } of CHECKS) if (test.test(html)) problems.push(problem);
  return problems;
}

/** The first complete HTML document in a ```html block, or null. */
export function extractSiteHtml(text: string | null | undefined): string | null {
  if (text == null) return null;
  for (const match of text.matchAll(/```html[^\S\n]*\n([\s\S]*?)\n```/gi)) {
    const html = (match[1] ?? '').trim();
    if (/^(?:<!doctype html|<html[\s>])/i.test(html) && /<\/html>\s*$/i.test(html)) return html;
  }
  return null;
}

export function siteTitle(html: string): string {
  const m = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html);
  return (m?.[1] ?? '').replace(/\s+/g, ' ').trim().slice(0, 120);
}

/** A folder name that is safe in a URL and a path: a-z, 0-9 and dashes, plus a short unique suffix. */
export function siteSlug(title: string, uniqueId: string): string {
  const base = title
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/-+$/g, '');
  const suffix = uniqueId.toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 6) || 'site';
  return `${base === '' ? 'sitio' : base}-${suffix}`;
}
