/**
 * Content generation for the MockProvider.
 *
 * This produces structured, agent-specific markdown derived from the actual
 * mission text, so the full pipeline (including the Integrator merging real
 * upstream content) can be exercised without any vendor API.
 *
 * It is a SIMULATION and says so in its own output. It performs no reasoning
 * and its content carries no analytical value — it exists to prove the
 * orchestration machinery, not to advise anyone.
 */

import type { AgentId } from '@acc/domain';
import { createRng, hashString, pick, randomInt } from './rng.ts';

/** Banner prepended to every simulated result so it can never be mistaken. */
export const SIMULATION_NOTICE =
  '> **Simulated output — MockProvider.** Generated locally with no AI model. ' +
  'Structure is real, content is placeholder. Swap in a real provider to get actual analysis.';

/** Pull the meaningful nouns out of a mission statement to reuse as subject matter. */
function keywords(prompt: string): string[] {
  const stop = new Set([
    'the', 'a', 'an', 'and', 'or', 'but', 'for', 'to', 'of', 'in', 'on', 'at', 'by', 'with',
    'from', 'into', 'about', 'want', 'wants', 'need', 'needs', 'quiero', 'para', 'una', 'uno',
    'que', 'con', 'los', 'las', 'del', 'por', 'como', 'i', 'we', 'my', 'our', 'is', 'are',
    'be', 'it', 'this', 'that', 'launch', 'build', 'create', 'make', 'start',
  ]);
  return prompt
    .toLowerCase()
    .replace(/\[[a-z]+:[^\]]*\]/gi, ' ')
    .replace(/[^\p{L}\p{N}\s-]/gu, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 2 && !stop.has(w))
    .slice(0, 12);
}

function subject(prompt: string): string {
  const words = keywords(prompt);
  if (words.length === 0) return 'the mission';
  return words.slice(0, 3).join(' ');
}

/** One-line echo of the mission so each agent's output is visibly on-topic. */
function missionLine(prompt: string): string {
  const cleaned = prompt.replace(/\[[a-z]+:[^\]]*\]/gi, '').replace(/\s+/g, ' ').trim();
  return cleaned.length > 220 ? `${cleaned.slice(0, 217)}...` : cleaned;
}

export interface GenerateOptions {
  agentId: AgentId;
  agentName: string;
  missionPrompt: string;
  /** Results of the agents that already ran, in pipeline order. */
  upstream: readonly { agentId: AgentId; name: string; result: string }[];
  /** Agents that failed before this one, so QA and the Integrator can name them. */
  failed: readonly { agentId: AgentId; name: string; error: string }[];
}

export function generate(options: GenerateOptions): string {
  const { agentId, missionPrompt } = options;
  const rng = createRng(hashString(`${agentId}:${missionPrompt}`));
  const topic = subject(missionPrompt);

  switch (agentId) {
    case 'strategy':
      return strategy(options, rng, topic);
    case 'research':
      return research(options, rng, topic);
    case 'code':
      return engineering(options, rng, topic);
    case 'design':
      return design(options, rng, topic);
    case 'marketing':
      return marketing(options, rng, topic);
    case 'finance':
      return finance(options, rng, topic);
    case 'qa':
      return qa(options, rng);
    case 'integrator':
      return integrator(options, rng, topic);
  }
}

// ---------------------------------------------------------------------------
// Worker agents
// ---------------------------------------------------------------------------

function strategy(o: GenerateOptions, rng: () => number, topic: string): string {
  const wedge = pick(rng, [
    'own the narrow segment first and expand outward',
    'compete on delivery speed rather than breadth',
    'win on trust and provenance, not price',
    'bundle a service layer the incumbents will not staff',
  ]);
  return [
    SIMULATION_NOTICE,
    '',
    '## Mission framing',
    `Mission under analysis: _${missionLine(o.missionPrompt)}_`,
    '',
    `The centre of gravity here is **${topic}**. Treating this as a broad play would spread the effort too thin, so the recommended posture is to ${wedge}.`,
    '',
    '## Target segment',
    `- **Primary:** the narrowest group for whom ${topic} is an urgent problem rather than a nice-to-have.`,
    '- **Secondary:** adjacent buyers reachable through the same channel once the primary segment is served.',
    '- **Explicitly out of scope for now:** everyone else. Scope creep is the main failure mode at this stage.',
    '',
    '## Strategic wedge',
    `${capitalise(wedge)}. This is defensible because it requires operational commitment that a larger competitor is unlikely to copy quickly.`,
    '',
    '## Success criteria',
    `1. First ${randomInt(rng, 10, 40)} real users or customers served end to end within ${randomInt(rng, 6, 14)} weeks.`,
    `2. Repeat or retention rate above ${randomInt(rng, 25, 45)}% by the end of the first quarter of operation.`,
    '3. A validated, repeatable acquisition motion — one channel that reliably produces demand.',
    '',
    '## Principal strategic risk',
    `Demand for ${topic} may be shallower than assumed. Mitigation: validate with a paid pilot before committing to fixed costs.`,
  ].join('\n');
}

function research(o: GenerateOptions, rng: () => number, topic: string): string {
  const constraint = pick(rng, [
    'licensing and registration requirements in the target market',
    'supply-chain lead times on the critical input',
    'platform policy limits on the main distribution channel',
    'data protection obligations covering customer records',
  ]);
  return [
    SIMULATION_NOTICE,
    '',
    '## Market context',
    `The space around **${topic}** is best understood as a set of established players serving broad demand, with thin coverage at the specific end where this mission sits.`,
    '',
    '## Comparable players',
    `| Player | Angle | Weak point |`,
    `| --- | --- | --- |`,
    `| Incumbent A | Broad catalogue, strong brand | Slow, impersonal service |`,
    `| Challenger B | Price leadership | Thin margins, no differentiation |`,
    `| Niche C | Deep specialisation | Limited reach, capacity-bound |`,
    '',
    '## Constraints to design around',
    `- **Regulatory / operational:** ${constraint}.`,
    '- **Capacity:** the model must work at small scale before it works at large scale.',
    `- **Channel:** distribution for ${topic} concentrates in a small number of places, which raises platform dependency risk.`,
    '',
    '## Assumptions (unverified)',
    '- Demand volume is inferred from category reasoning, **not** measured.',
    '- Competitor weak points are hypotheses drawn from their positioning, not from customer interviews.',
    '',
    '## Open questions requiring primary research',
    '1. What do the first 20 target customers actually pay today, and to whom?',
    '2. Which constraint above binds first at realistic volume?',
    '3. Is the channel assumption stable, or is it a single point of failure?',
  ].join('\n');
}

function engineering(o: GenerateOptions, rng: () => number, topic: string): string {
  const store = pick(rng, ['PostgreSQL', 'PostgreSQL with a read replica', 'PostgreSQL plus object storage']);
  return [
    SIMULATION_NOTICE,
    '',
    '## Recommended stack',
    `- **Runtime:** TypeScript end to end — one language across the build keeps a small team fast.`,
    `- **Data:** ${store} — relational integrity matters more than exotic scale at this stage.`,
    '- **Delivery:** a single deployable service plus a static frontend. Microservices would be premature.',
    '',
    '## System shape',
    '```',
    'client → api gateway → application service → datastore',
    '                           ↓',
    '                    background worker',
    '```',
    `The write path stays synchronous and simple; anything slow relating to ${topic} moves to the worker so requests never block.`,
    '',
    '## Build sequence',
    `1. **Phase 1 (${randomInt(rng, 2, 4)} weeks):** data model, core write path, minimal UI.`,
    `2. **Phase 2 (${randomInt(rng, 3, 6)} weeks):** background processing, notifications, admin views.`,
    '3. **Phase 3:** hardening — observability, backups, load testing against realistic volume.',
    '',
    '## Principal technical risk',
    'The background worker becoming a hidden single point of failure. Mitigation: make jobs idempotent and retryable from day one, and surface queue depth as a first-class metric.',
  ].join('\n');
}

function design(o: GenerateOptions, rng: () => number, topic: string): string {
  const tone = pick(rng, ['warm and unfussy', 'precise and technical', 'confident and minimal', 'editorial and tactile']);
  return [
    SIMULATION_NOTICE,
    '',
    '## Core user journey',
    `1. Arrive with a specific need around ${topic}.`,
    '2. Understand within one screen whether this is for them.',
    '3. Complete the primary action with no account friction.',
    '4. Receive confirmation that feels like a commitment was made, not a form submitted.',
    '',
    '## Interface principles',
    '- **One decision per screen.** Mobile is the default context, not an adaptation.',
    '- **State is always visible.** The user should never wonder whether something is happening.',
    '- **Progressive disclosure.** Depth is available but never the first thing shown.',
    '',
    '## Visual direction',
    `${capitalise(tone)}. High contrast for legibility in poor conditions, generous spacing, and a single accent colour used only for the primary action.`,
    '',
    '## The screen that matters most',
    `The confirmation state. It is the moment trust is either earned or lost, and it is almost always under-designed. It should restate exactly what will happen next and when.`,
  ].join('\n');
}

function marketing(o: GenerateOptions, rng: () => number, topic: string): string {
  const channels = pick<readonly [string, string]>(rng, [
    ['local partnerships', 'organic short-form video'],
    ['search intent capture', 'referral loops'],
    ['community seeding', 'targeted paid social'],
    ['direct outbound', 'content built for search'],
  ]);
  return [
    SIMULATION_NOTICE,
    '',
    '## Core message',
    `> The fastest way to get ${topic} done properly, without the usual friction.`,
    '',
    'The message leads with the outcome, not the mechanism. Customers buy the resolved problem.',
    '',
    '## Two channels, chosen deliberately',
    `1. **${capitalise(channels[0])}** — highest intent per unit of effort at this stage; it reaches people already looking.`,
    `2. **${capitalise(channels[1])}** — compounds over time and reduces dependence on paid acquisition.`,
    '',
    'Everything else is deferred. Two channels executed well beat six run badly.',
    '',
    '## Launch sequence',
    `- **Weeks 1–2:** message testing with ${randomInt(rng, 15, 40)} target customers before any spend.`,
    '- **Weeks 3–4:** soft launch on channel 1 only, measuring conversion honestly.',
    '- **Week 5 onward:** layer in channel 2 once channel 1 has a stable baseline.',
    '',
    '## The metric that matters',
    `Cost per **retained** customer, not cost per lead. A cheap lead that never returns is a loss disguised as a win.`,
  ].join('\n');
}

function finance(o: GenerateOptions, rng: () => number, topic: string): string {
  const price = randomInt(rng, 20, 80);
  const cogs = Math.round(price * (randomInt(rng, 30, 55) / 100));
  const cac = randomInt(rng, 8, 30);
  const fixed = randomInt(rng, 1500, 6000);
  const contribution = price - cogs - cac;
  const breakeven = contribution > 0 ? Math.ceil(fixed / contribution) : 0;

  return [
    SIMULATION_NOTICE,
    '',
    '## Assumption set',
    'Every figure below is an **assumption for modelling purposes**. None was supplied in the mission or measured.',
    '',
    `| Item | Assumed value |`,
    `| --- | --- |`,
    `| Average revenue per order | ${price} |`,
    `| Direct cost per order | ${cogs} |`,
    `| Customer acquisition cost | ${cac} |`,
    `| Fixed monthly cost | ${fixed} |`,
    '',
    '## Unit economics',
    `Contribution per order = ${price} − ${cogs} − ${cac} = **${contribution}**.`,
    contribution > 0
      ? `Each order contributes ${contribution} toward fixed costs.`
      : 'Contribution is **negative**: the model does not work at these assumptions and pricing or cost must change before launch.',
    '',
    '## Break-even',
    contribution > 0
      ? `${breakeven} orders per month covers the ${fixed} fixed base. Below that, ${topic} burns cash every month.`
      : 'No break-even exists at these assumptions.',
    '',
    '## Funding requirement',
    `Assuming ${randomInt(rng, 4, 9)} months to reach break-even volume, the cash requirement is roughly ${fixed * randomInt(rng, 4, 9)} plus one-off setup costs. Raise or reserve more than the model says; the model is optimistic by construction.`,
    '',
    '## Sensitivity',
    'The result is most sensitive to acquisition cost. A 50% miss there erases the contribution margin entirely.',
  ].join('\n');
}

// ---------------------------------------------------------------------------
// QA and Integrator
// ---------------------------------------------------------------------------

function qa(o: GenerateOptions, rng: () => number): string {
  const lines: string[] = [SIMULATION_NOTICE, '', '## Verdict per specialist', ''];

  for (const item of o.upstream) {
    const verdict = pick(rng, [
      'Sound, proceeds on stated assumptions.',
      'Usable, but the reasoning is thinner than it looks.',
      'Directionally right; specifics need validation.',
    ]);
    lines.push(`- **${item.name}** — ${verdict}`);
  }

  for (const item of o.failed) {
    lines.push(`- **${item.name}** — ❌ **did not produce output.** ${item.error}`);
  }

  lines.push('', '## Contradictions found', '');
  if (o.upstream.length >= 2) {
    lines.push(
      '- Finance assumes an acquisition cost that Marketing never committed to; the two were produced independently and were never reconciled.',
      '- Strategy narrows the segment while Research describes the broad market. The narrow read should win, but the documents currently disagree.',
    );
  } else {
    lines.push('- Too few specialist outputs to cross-check meaningfully.');
  }

  lines.push('', '## Critical gaps', '');
  const gaps = [
    'No agent validated demand with a real customer. Every downstream number inherits that gap.',
    'Timeline estimates are not reconciled against the funding runway.',
  ];
  if (o.failed.length > 0) {
    gaps.unshift(
      `**${o.failed.map((f) => f.name).join(', ')} produced nothing**, so the brief is incomplete in ${o.failed.length === 1 ? 'that area' : 'those areas'}.`,
    );
  }
  lines.push(...gaps.map((g) => `- ${g}`));

  lines.push(
    '',
    '## Recommendation',
    '',
    o.failed.length > 0
      ? '**No-go as it stands.** The brief has a hole in it. Re-run the failed agents, or accept the gap explicitly and document who will cover that work manually.'
      : '**Conditional go.** Proceed to a paid validation pilot, but treat every financial figure as unvalidated until real demand data exists.',
  );

  return lines.join('\n');
}

function integrator(o: GenerateOptions, rng: () => number, topic: string): string {
  const specialists = o.upstream.filter((u) => u.agentId !== 'qa');
  const qaReview = o.upstream.find((u) => u.agentId === 'qa');

  const lines: string[] = [
    SIMULATION_NOTICE,
    '',
    `# Execution brief: ${topic}`,
    '',
    `**Mission:** ${missionLine(o.missionPrompt)}`,
    '',
    `Assembled from ${specialists.length} specialist ${specialists.length === 1 ? 'report' : 'reports'}` +
      (qaReview ? ' plus the QA review' : '') +
      (o.failed.length > 0 ? `, with ${o.failed.length} agent ${o.failed.length === 1 ? 'failure' : 'failures'}` : '') +
      '.',
    '',
    '## The plan in one paragraph',
    '',
    `Attack **${topic}** through the narrowest viable segment, validate demand with a paid pilot before committing fixed cost, and build the minimum technical surface that lets a real transaction complete end to end. Two acquisition channels, not six. Every financial figure in this brief is an assumption until the pilot produces data.`,
    '',
    '## Contributing agents',
    '',
  ];

  for (const item of specialists) {
    lines.push(`### ${item.name}`, '', firstSubstantiveParagraph(item.result), '');
  }

  if (o.failed.length > 0) {
    lines.push('## Gaps carried forward', '');
    for (const f of o.failed) {
      lines.push(`- **${f.name} did not run.** ${f.error} This area is uncovered and must be handled manually or by re-running the mission.`);
    }
    lines.push('');
  }

  lines.push(
    '## Sequenced next actions',
    '',
    `1. **Validate demand** — interview ${randomInt(rng, 15, 30)} target customers and take pre-orders. Owner: Strategy.`,
    '2. **Lock the assumption set** — replace every modelled figure with a measured one. Owner: Finance.',
    '3. **Build the transaction path** — one complete flow, nothing else. Owner: Engineering.',
    '4. **Run one channel** — measure cost per retained customer, not leads. Owner: Marketing.',
    '',
    '## Risks carried forward',
    '',
    '- Demand is assumed, not proven. This is the risk that invalidates everything else.',
    '- Acquisition cost drives the entire financial model and has the widest error bar.',
    '- Channel concentration creates a single point of failure in distribution.',
    '',
    '## Unresolved',
    '',
    qaReview
      ? '- The contradictions QA raised between Finance and Marketing assumptions are **not resolved in this brief**. They need a single owner to reconcile before spend begins.'
      : '- No QA review was available, so this brief is unaudited.',
    '- No agent has primary market data. Treat this document as a plan to get that data, not as evidence.',
  );

  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function capitalise(value: string): string {
  return value.length === 0 ? value : value.charAt(0).toUpperCase() + value.slice(1);
}

/**
 * Pull the first real prose paragraph out of an agent result, skipping the
 * banner, headings, tables and code. A bare list item is used only as a
 * fallback, since it reads badly out of its list context.
 */
function firstSubstantiveParagraph(markdown: string): string {
  const candidates = markdown.split('\n').map((line) => line.trim()).filter((line) => {
    return (
      line.length > 0 &&
      !line.startsWith('>') &&
      !line.startsWith('#') &&
      !line.startsWith('|') &&
      !line.startsWith('```')
    );
  });

  const isListItem = (line: string) => /^([-*+]\s|\d+[.)]\s)/.test(line);

  return candidates.find((line) => !isListItem(line)) ?? candidates[0] ?? '_No summarisable content._';
}
