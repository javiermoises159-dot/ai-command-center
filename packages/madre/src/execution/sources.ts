/**
 * "Fuentes consultadas": the web pages the tools really returned.
 *
 * Built by the program from tool results, not written by a model, so a link can
 * neither be invented nor lost when the final report is drafted. It lists what
 * was consulted; it does not claim the report uses every one of them.
 */

import { checkSiteHtml, extractSiteHtml } from '@acc/domain';

import type { StepState } from '../types.ts';

const MAX_SOURCES = 15;

interface Source {
  url: string;
  title: string;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function add(found: Map<string, Source>, rawUrl: unknown, title: unknown): void {
  if (typeof rawUrl !== 'string' || !/^https?:\/\//i.test(rawUrl)) return;
  // Parentheses would end a markdown link early.
  const url = rawUrl.replace(/\(/g, '%28').replace(/\)/g, '%29').replace(/\s/g, '%20');
  if (found.has(url)) return;
  found.set(url, { url, title: typeof title === 'string' && title.trim() !== '' ? title.trim().replace(/[[\]]/g, '') : url });
}

export function collectSources(steps: readonly Pick<StepState, 'toolResults'>[]): Source[] {
  const found = new Map<string, Source>();
  for (const step of steps) {
    for (const result of step.toolResults ?? []) {
      if (!result.ok) continue;
      const output = asRecord(result.output);
      if (output === null) continue;
      if (result.toolId === 'web.search' && Array.isArray(output.results)) {
        for (const item of output.results) {
          const r = asRecord(item);
          if (r !== null) add(found, r.url, r.title);
        }
      } else if (result.toolId === 'news.gdelt' && Array.isArray(output.articles)) {
        for (const item of output.articles) {
          const r = asRecord(item);
          if (r !== null) add(found, r.url, r.title);
        }
      } else if (result.toolId === 'web.fetch' || result.toolId === 'research.wikipedia') {
        add(found, output.url, output.title);
      }
    }
  }
  return [...found.values()].slice(0, MAX_SOURCES);
}

/** The report with a sources section appended, or unchanged when no web source was consulted. */
export function withSources(text: string | null, steps: readonly Pick<StepState, 'toolResults'>[]): string | null {
  if (text === null) return null;
  const sources = collectSources(steps);
  if (sources.length === 0) return text;
  const lines = sources.map((s) => `- [${s.title}](${s.url})`);
  return `${text.trimEnd()}\n\n## Fuentes consultadas\n\nPáginas que las herramientas devolvieron durante la investigación (la lista no implica que el informe use todas):\n\n${lines.join('\n')}\n`;
}

// ---------------------------------------------------------------------------
// Logos: the SVG drawings the design step made, copied into the report as they
// are, so a summarising step cannot drop or damage them.
// ---------------------------------------------------------------------------

const UNSAFE_SVG = /<script|<foreignObject|<iframe|<embed|<object|javascript:|\son[a-z]+\s*=|@import|(?:href|src)\s*=\s*["']?\s*(?:https?:|data:|\/\/)|url\(\s*["']?\s*(?:https?:|data:|\/\/)/i;

/** The ```svg blocks in a text that look like a complete, self-contained drawing. */
export function svgBlocks(text: string): string[] {
  const blocks: string[] = [];
  for (const match of text.matchAll(/```svg[^\S\n]*\n([\s\S]*?)```/gi)) {
    const svg = (match[1] ?? '').trim();
    if (/^<svg[\s>]/i.test(svg) && /<\/svg>\s*$/i.test(svg) && svg.length <= 20_000 && !UNSAFE_SVG.test(svg)) blocks.push(svg);
  }
  return blocks;
}

/** The report with the logo drawings appended, or unchanged when there are none. */
export function withLogos(text: string | null, logoTexts: readonly string[]): string | null {
  if (text === null) return null;
  const blocks = logoTexts.flatMap((t) => svgBlocks(t)).slice(0, 6);
  if (blocks.length === 0) return text;
  const body = blocks.map((svg, i) => `### Opción ${i + 1}\n\n\`\`\`svg\n${svg}\n\`\`\``).join('\n\n');
  return `${text.trimEnd()}\n\n## Logotipos\n\nDibujos generados por el equipo de diseño, tal como los entregó:\n\n${body}\n`;
}

// ---------------------------------------------------------------------------
// Websites: the page the engineering step built, copied into the report as it
// is. A summarising step never sees the whole page (see `abbreviateSites`) and
// so cannot cut it short; the program attaches the original.
// ---------------------------------------------------------------------------

/** The report with the finished page appended, or unchanged when there is none. */
export function withSite(text: string | null, siteTexts: readonly string[]): string | null {
  if (text === null) return null;
  for (const source of siteTexts) {
    const html = extractSiteHtml(source);
    if (html === null) continue;
    const problems = checkSiteHtml(html);
    if (problems.length > 0) {
      return `${text.trimEnd()}\n\n## Página web\n\nEl equipo entregó una página, pero no se puede publicar tal cual porque ${problems.join('; ')}. Pide una nueva versión de la misión para corregirlo.\n`;
    }
    return `${text.trimEnd()}\n\n## Página web\n\nPágina completa generada por el equipo, tal como la entregó. Se puede ver y publicar desde esta pantalla.\n\n\`\`\`html\n${html}\n\`\`\`\n`;
  }
  return text;
}

/**
 * Replace a big ```html page inside a step's text with a one-line note, for the
 * steps that only need to know it exists. A whole page in the prompt of the
 * integrator or the reviewer costs thousands of tokens and, on a free plan
 * with a per-request limit, can make the call fail.
 */
export function abbreviateSites(text: string): string {
  return text.replace(/```html[^\S\n]*\n([\s\S]*?)\n```/gi, (block, html: string) =>
    html.length > 1_500 ? `[La página web completa (${html.length} caracteres de HTML) se adjunta tal cual al informe final; no se repite aquí.]` : block,
  );
}
