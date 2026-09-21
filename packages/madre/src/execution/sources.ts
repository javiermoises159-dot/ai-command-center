/**
 * "Fuentes consultadas": the web pages the tools really returned.
 *
 * Built by the program from tool results, not written by a model, so a link can
 * neither be invented nor lost when the final report is drafted. It lists what
 * was consulted; it does not claim the report uses every one of them.
 */

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
