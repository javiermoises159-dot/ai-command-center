/**
 * A small Markdown renderer covering exactly what the agents produce:
 * headings, paragraphs, bullet and ordered lists, blockquotes, fenced code,
 * tables, horizontal rules, and inline bold / italic / code / links.
 *
 * It renders to React elements rather than HTML strings, so there is no
 * `dangerouslySetInnerHTML` anywhere and agent output cannot inject markup —
 * which also means no sanitiser dependency is needed.
 */

import type { ReactNode } from 'react';

import { isSafeSvg, svgDataUrl } from './svg.ts';

type Block =
  | { kind: 'heading'; level: number; text: string }
  | { kind: 'paragraph'; text: string }
  | { kind: 'list'; ordered: boolean; items: string[] }
  | { kind: 'quote'; lines: string[] }
  | { kind: 'code'; language: string; lines: string[] }
  | { kind: 'table'; header: string[]; rows: string[][] }
  | { kind: 'rule' };

function splitRow(line: string): string[] {
  return line
    .replace(/^\s*\|/, '')
    .replace(/\|\s*$/, '')
    .split('|')
    .map((cell) => cell.trim());
}

function isTableDivider(line: string): boolean {
  return /^\s*\|?[\s:|-]+\|[\s:|-]*$/.test(line) && line.includes('-');
}

function parseBlocks(markdown: string): Block[] {
  const lines = markdown.replace(/\r\n/g, '\n').split('\n');
  const blocks: Block[] = [];
  let index = 0;

  while (index < lines.length) {
    const line = lines[index] ?? '';

    if (line.trim() === '') {
      index += 1;
      continue;
    }

    // Fenced code
    const fence = /^\s*```(\w*)\s*$/.exec(line);
    if (fence) {
      const language = fence[1] ?? '';
      const body: string[] = [];
      index += 1;
      while (index < lines.length && !/^\s*```\s*$/.test(lines[index] ?? '')) {
        body.push(lines[index] ?? '');
        index += 1;
      }
      index += 1; // closing fence
      blocks.push({ kind: 'code', language, lines: body });
      continue;
    }

    // Horizontal rule
    if (/^\s*([-*_])\1{2,}\s*$/.test(line)) {
      blocks.push({ kind: 'rule' });
      index += 1;
      continue;
    }

    // Heading
    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) {
      blocks.push({ kind: 'heading', level: heading[1]?.length ?? 1, text: heading[2] ?? '' });
      index += 1;
      continue;
    }

    // Table: a pipe row followed by a divider row
    if (line.includes('|') && isTableDivider(lines[index + 1] ?? '')) {
      const header = splitRow(line);
      const rows: string[][] = [];
      index += 2;
      while (index < lines.length && (lines[index] ?? '').includes('|') && (lines[index] ?? '').trim() !== '') {
        rows.push(splitRow(lines[index] ?? ''));
        index += 1;
      }
      blocks.push({ kind: 'table', header, rows });
      continue;
    }

    // Blockquote
    if (/^\s*>/.test(line)) {
      const body: string[] = [];
      while (index < lines.length && /^\s*>/.test(lines[index] ?? '')) {
        body.push((lines[index] ?? '').replace(/^\s*>\s?/, ''));
        index += 1;
      }
      blocks.push({ kind: 'quote', lines: body });
      continue;
    }

    // Lists
    const bullet = /^\s*[-*+]\s+(.*)$/.exec(line);
    const ordered = /^\s*\d+[.)]\s+(.*)$/.exec(line);
    if (bullet || ordered) {
      const isOrdered = ordered !== null;
      const items: string[] = [];
      while (index < lines.length) {
        const current = lines[index] ?? '';
        const match = isOrdered ? /^\s*\d+[.)]\s+(.*)$/.exec(current) : /^\s*[-*+]\s+(.*)$/.exec(current);
        if (!match) break;
        items.push(match[1] ?? '');
        index += 1;
      }
      blocks.push({ kind: 'list', ordered: isOrdered, items });
      continue;
    }

    // Paragraph: consume until a blank line or the start of another block
    const paragraph: string[] = [];
    while (index < lines.length) {
      const current = lines[index] ?? '';
      if (
        current.trim() === '' ||
        /^(#{1,6})\s/.test(current) ||
        /^\s*[-*+]\s/.test(current) ||
        /^\s*\d+[.)]\s/.test(current) ||
        /^\s*>/.test(current) ||
        /^\s*```/.test(current) ||
        (current.includes('|') && isTableDivider(lines[index + 1] ?? ''))
      ) {
        break;
      }
      paragraph.push(current.trim());
      index += 1;
    }
    if (paragraph.length > 0) blocks.push({ kind: 'paragraph', text: paragraph.join(' ') });
  }

  return blocks;
}

/** Inline formatting: `code`, **bold**, *italic*, [text](url). */
function inline(text: string, keyPrefix: string): ReactNode[] {
  const pattern = /(`[^`]+`|\*\*[^*]+\*\*|__[^_]+__|\*[^*]+\*|_[^_]+_|\[[^\]]+\]\([^)]+\))/g;
  const nodes: ReactNode[] = [];
  let lastIndex = 0;
  let match: RegExpExecArray | null;
  let key = 0;

  while ((match = pattern.exec(text)) !== null) {
    if (match.index > lastIndex) nodes.push(text.slice(lastIndex, match.index));
    const token = match[0];
    const id = `${keyPrefix}-${key++}`;

    if (token.startsWith('`')) {
      nodes.push(
        <code
          key={id}
          className="rounded bg-[var(--color-tint-strong)] px-1.5 py-0.5 font-mono text-[0.85em] text-cyan-800 dark:text-cyan-200"
        >
          {token.slice(1, -1)}
        </code>,
      );
    } else if (token.startsWith('**') || token.startsWith('__')) {
      nodes.push(
        <strong key={id} className="font-semibold text-[var(--color-ink)]">
          {token.slice(2, -2)}
        </strong>,
      );
    } else if (token.startsWith('[')) {
      const link = /^\[([^\]]+)\]\(([^)]+)\)$/.exec(token);
      const label = link?.[1] ?? token;
      const url = link?.[2] ?? '#';
      // Only http(s) links are rendered as links; anything else stays text,
      // which rules out javascript: URLs from agent output.
      nodes.push(
        /^https?:\/\//i.test(url) ? (
          <a
            key={id}
            href={url}
            target="_blank"
            rel="noreferrer noopener"
            className="text-cyan-700 underline decoration-cyan-700/40 underline-offset-2 dark:text-cyan-300 dark:decoration-cyan-300/40"
          >
            {label}
          </a>
        ) : (
          <span key={id}>{label}</span>
        ),
      );
    } else {
      nodes.push(
        <em key={id} className="italic text-[var(--color-ink-dim)]">
          {token.slice(1, -1)}
        </em>,
      );
    }

    lastIndex = match.index + token.length;
  }

  if (lastIndex < text.length) nodes.push(text.slice(lastIndex));
  return nodes;
}

const HEADING_CLASSES: Record<number, string> = {
  1: 'text-lg font-semibold tracking-tight text-[var(--color-ink)] mt-6 first:mt-0',
  2: 'text-base font-semibold tracking-tight text-[var(--color-ink)] mt-6 first:mt-0',
  3: 'text-sm font-semibold uppercase tracking-wider text-[var(--color-signal)] mt-5 first:mt-0',
};

export function Markdown({ source, className }: { source: string; className?: string }) {
  const blocks = parseBlocks(source);

  return (
    <div className={className ?? 'space-y-3 text-[0.9rem] leading-relaxed text-[var(--color-ink-dim)]'}>
      {blocks.map((block, i) => {
        const key = `b${i}`;
        switch (block.kind) {
          case 'heading':
            return (
              <p key={key} className={HEADING_CLASSES[block.level] ?? HEADING_CLASSES[3]}>
                {inline(block.text, key)}
              </p>
            );

          case 'paragraph':
            return <p key={key}>{inline(block.text, key)}</p>;

          case 'list':
            return block.ordered ? (
              <ol key={key} className="list-decimal space-y-1.5 pl-5 marker:text-[var(--color-ink-faint)]">
                {block.items.map((item, j) => (
                  <li key={`${key}-${j}`}>{inline(item, `${key}-${j}`)}</li>
                ))}
              </ol>
            ) : (
              <ul key={key} className="list-disc space-y-1.5 pl-5 marker:text-[var(--color-signal)]">
                {block.items.map((item, j) => (
                  <li key={`${key}-${j}`}>{inline(item, `${key}-${j}`)}</li>
                ))}
              </ul>
            );

          case 'quote':
            return (
              <blockquote
                key={key}
                className="border-l-2 border-[var(--color-signal)]/50 bg-[var(--color-tint)] py-2 pl-3 pr-2 text-[0.85rem]"
              >
                {block.lines.map((line, j) => (
                  <p key={`${key}-${j}`}>{inline(line, `${key}-${j}`)}</p>
                ))}
              </blockquote>
            );

          case 'code': {
            const source = block.lines.join('\n');
            if (block.language.toLowerCase() === 'svg' && isSafeSvg(source)) {
              const url = svgDataUrl(source);
              return (
                <figure key={key} className="overflow-hidden rounded-lg border border-[var(--color-edge)]">
                  <div className="flex justify-center bg-white p-4">
                    <img src={url} alt="Logotipo propuesto" className="h-40 w-40 object-contain" />
                  </div>
                  <figcaption className="flex items-center justify-between gap-3 bg-[var(--color-tint)] px-3 py-2 text-[0.75rem]">
                    <span>Imagen SVG</span>
                    <a href={url} download="logotipo.svg" className="font-semibold text-[var(--color-signal)] underline">
                      Descargar
                    </a>
                  </figcaption>
                </figure>
              );
            }
            return (
              <pre
                key={key}
                className="overflow-x-auto rounded-lg border border-[var(--color-edge)] bg-[var(--color-tint)] p-3 font-mono text-[0.78rem] leading-relaxed text-[var(--color-ink)]"
              >
                <code>{source}</code>
              </pre>
            );
          }

          case 'table':
            return (
              <div key={key} className="-mx-1 overflow-x-auto">
                <table className="w-full min-w-[22rem] border-collapse text-[0.8rem]">
                  <thead>
                    <tr>
                      {block.header.map((cell, j) => (
                        <th
                          key={`${key}-h${j}`}
                          className="border-b border-[var(--color-edge-bright)] px-2 py-1.5 text-left font-semibold text-[var(--color-ink)]"
                        >
                          {inline(cell, `${key}-h${j}`)}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {block.rows.map((row, j) => (
                      <tr key={`${key}-r${j}`}>
                        {row.map((cell, k) => (
                          <td
                            key={`${key}-r${j}c${k}`}
                            className="border-b border-[var(--color-edge)] px-2 py-1.5 align-top"
                          >
                            {inline(cell, `${key}-r${j}c${k}`)}
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            );

          case 'rule':
            return <hr key={key} className="border-[var(--color-edge)]" />;
        }
      })}
    </div>
  );
}
