/**
 * Identifier generation and mission title derivation.
 *
 * `crypto.randomUUID` is available in Node 19+ and every browser we target, so
 * no uuid dependency is needed.
 */

export function newId(): string {
  return crypto.randomUUID();
}

const TITLE_MAX = 80;

/**
 * Derive a short human label from a mission statement. Control directives such
 * as `[fail:marketing]` are stripped so they never leak into the UI.
 */
export function deriveTitle(prompt: string): string {
  const cleaned = prompt
    .replace(/\[[a-z]+:[^\]]*\]/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  if (cleaned.length === 0) return 'Misión sin título';

  // Prefer cutting at the first sentence boundary when there is one early on.
  const sentenceEnd = cleaned.search(/[.!?](\s|$)/);
  const base = sentenceEnd > 0 && sentenceEnd <= TITLE_MAX ? cleaned.slice(0, sentenceEnd) : cleaned;

  if (base.length <= TITLE_MAX) return base;

  const truncated = base.slice(0, TITLE_MAX);
  const lastSpace = truncated.lastIndexOf(' ');
  return `${(lastSpace > 40 ? truncated.slice(0, lastSpace) : truncated).trimEnd()}…`;
}
