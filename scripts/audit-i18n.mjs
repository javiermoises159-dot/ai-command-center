#!/usr/bin/env node
/**
 * i18n audit: lists string literals and JSX text that look like English prose or
 * English UI labels. A heuristic, not a proof: it errs towards reporting.
 *
 *   node scripts/audit-i18n.mjs [--json] [--all] <dir-or-file>...
 *
 * Skips tests, imports, CSS class strings, identifiers and paths. Reports the
 * surviving candidates with file:line so a person can decide.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import ts from 'typescript';

const args = process.argv.slice(2);
const asJson = args.includes('--json');
const targets = args.filter((a) => !a.startsWith('--'));
const root = process.cwd();

const STOP = new Set(
  ('the and to of is are was were be been for with without not no in on at by from or your you this that these those it its as if ' +
    'an a has have had will can could should would may might into over under about after before then than when where which while ' +
    'there here what how why who all any each every some more most less only also just but so such do does did done yet still ' +
    'us we our they their them he she his her one two three per via').split(' '),
);
const ES_STOP = new Set(
  ('el la los las un una unos unas de del al y o en con sin para por que se su sus es son no lo como más pero si ya muy ' +
    'esta este estos estas esto tu tus mi mis hay ha han ser fue está están cuando donde qué cómo').split(' '),
);
// Single words that are UI labels in English and not valid Spanish.
const EN_LABELS = new Set(
  ('Dashboard Missions Mission Agents Agent Settings Tools Tool Activity Research Creative Knowledge Cancel Save Delete Retry Loading Search ' +
    'Close Open Run Result Results Status Done Failed Pending Running Completed Cancelled Queued Skipped Connected Ready Blocked Warning Error ' +
    'Yes Ok Back Next Edit Add Remove Copy Copied Refresh Filter All Active Prepared Planned Memory Budget Providers Models Permissions Appearance ' +
    'System Health Online Offline Approve Deny Approved Denied Optional Required Enabled Disabled Details Summary Overview Objective Plan Steps ' +
    'Confidence Cost Calls Provider Model Quality Simulated Unknown Available Mock Local External Show Hide More Less Reset Apply Continue Submit ' +
    'Light Dark Theme Name Title Description Type Date Time Today Yesterday Now Never Always').split(' '),
);
// Spanish look-alikes that must not be flagged as English labels.
const IGNORE_EXACT = new Set(['OK', 'API', 'PWA', 'MADRE', 'USD', 'ID', 'AI', 'URL', 'JSON', 'HTTP', 'QA', 'Ollama', 'OpenAI', 'Anthropic', 'Gemini', 'PostgreSQL', 'Playwright']);

function* walk(p) {
  const s = statSync(p);
  if (s.isFile()) return yield p;
  for (const e of readdirSync(p)) {
    if (e === 'node_modules' || e === 'dist' || e.startsWith('.')) continue;
    yield* walk(join(p, e));
  }
}

function classify(text) {
  const t = text.replace(/\s+/g, ' ').trim();
  if (t.length < 2 || !/[A-Za-z]{2}/.test(t)) return null;
  if (IGNORE_EXACT.has(t)) return null;
  if (/^[\w./@:#\[\]{}()*+|^$\\?=<>%&~-]+$/.test(t) && !EN_LABELS.has(t)) return null; // token: id, path, class, regex
  if (/^(\S+ ){2,}\S+$/.test(t) && /[-:\[\]/]/.test(t) && !/[.!?…]/.test(t) && /\b(flex|grid|px|py|rounded|text|bg|border|ring|gap|w|h|min|max|items|justify|font|tabular|uppercase)\b/.test(t)) return null; // tailwind
  if (/^(https?:|\/|\.\/|\.\.\/|@|node:)/.test(t)) return null;
  const words = t.toLowerCase().replace(/[^a-záéíóúñü\s']/g, ' ').split(/\s+/).filter(Boolean);
  if (words.length === 0) return null;
  const en = words.filter((w) => STOP.has(w)).length;
  const es = words.filter((w) => ES_STOP.has(w) || /[áéíóúñ¿¡]/.test(w)).length;
  if (words.length === 1) return EN_LABELS.has(t) || EN_LABELS.has(t[0].toUpperCase() + t.slice(1).toLowerCase()) ? 'en-label' : null;
  if (en > es && en >= 1) return 'en-prose';
  if (words.length >= 2 && es === 0 && en === 0) {
    // two+ words, no stop words: flag when any word is a known English label
    if (words.some((w) => EN_LABELS.has(w[0].toUpperCase() + w.slice(1)))) return 'en-label';
  }
  return null;
}

const found = [];
function scan(file) {
  const src = readFileSync(file, 'utf8');
  const sf = ts.createSourceFile(file, src, ts.ScriptTarget.Latest, true, file.endsWith('x') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const line = (n) => sf.getLineAndCharacterOfPosition(n.getStart()).line + 1;
  const report = (node, text) => {
    const kind = classify(text);
    if (kind !== null) found.push({ file: relative(root, file), line: line(node), kind, text: text.replace(/\s+/g, ' ').trim().slice(0, 140) });
  };
  const skipParent = (n) => {
    const p = n.parent;
    return (
      ts.isImportDeclaration(p) || ts.isExportDeclaration(p) || ts.isExternalModuleReference(p) || ts.isLiteralTypeNode(p) ||
      (ts.isCallExpression(p) && ts.isIdentifier(p.expression) && ['require'].includes(p.expression.text)) ||
      (ts.isJsxAttribute(p) && ['className', 'href', 'key', 'id', 'type', 'name', 'role', 'to', 'htmlFor', 'inputMode', 'autoComplete', 'viewBox', 'd', 'fill', 'stroke', 'strokeLinecap', 'strokeLinejoin', 'xmlns', 'rel', 'target', 'lang', 'as', 'variant', 'tone', 'size', 'icon', 'path', 'value', 'data-theme'].includes(p.name.text)) ||
      (ts.isPropertyAssignment(p) && p.initializer === n && ts.isIdentifier(p.name) && ['className', 'id', 'type', 'kind', 'status', 'tone', 'icon', 'name', 'path', 'href', 'method', 'level', 'value', 'tag', 'code', 'provider', 'model', 'agentId', 'runId', 'missionId', 'stepId', 'origin', 'source', 'tier', 'privacy', 'mode', 'verdict', 'phase', 'severity', 'category', 'role', 'from', 'to', 'key'].includes(p.name.text)) ||
      (ts.isCaseClause(p)) ||
      (ts.isBinaryExpression(p) && [ts.SyntaxKind.EqualsEqualsEqualsToken, ts.SyntaxKind.ExclamationEqualsEqualsToken].includes(p.operatorToken.kind)) ||
      (ts.isElementAccessExpression(p)) ||
      (ts.isCallExpression(p) && ts.isPropertyAccessExpression(p.expression) && ['test', 'match', 'replace', 'includes', 'startsWith', 'endsWith', 'split', 'get', 'has', 'getItem', 'setItem', 'add', 'querySelector', 'getAttribute', 'setAttribute', 'matchAll', 'append'].includes(p.expression.name.text)) ||
      (ts.isCallExpression(p) && ts.isIdentifier(p.expression) && ['describe', 'it', 'test', 'newId', 'fetch'].includes(p.expression.text))
    );
  };
  const visit = (n) => {
    if (ts.isJsxText(n)) report(n, n.getText());
    else if ((ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) && !skipParent(n)) report(n, n.text);
    else if (ts.isTemplateExpression(n)) {
      const text = n.head.text + n.templateSpans.map((s) => '\u0000' + s.literal.text).join('');
      report(n, text.replace(/\u0000/g, ' '));
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
}

for (const t of targets) {
  for (const f of walk(t)) {
    if (!/\.(ts|tsx)$/.test(f) || /\.test\.tsx?$/.test(f) || /\.d\.ts$/.test(f)) continue;
    scan(f);
  }
}
if (asJson) console.log(JSON.stringify(found, null, 1));
else {
  for (const f of found) console.log(`${f.file}:${f.line}  [${f.kind}]  ${f.text}`);
  const files = new Set(found.map((f) => f.file));
  console.log(`\n${found.length} candidate English strings in ${files.size} files`);
}
