/**
 * Mission compiler.
 *
 * Turns a sentence into a `CompiledMission`: an objective, the context and
 * constraints the user actually gave, the assumptions that still need testing,
 * the capabilities required, the tasks that cover them, how the result will be
 * verified and what the deliverable looks like.
 *
 * The rule that shapes every line: **provenance**. A statement is
 * `user_provided` only if it comes from the user's words; a guess is a
 * `hypothesis`; a question that needs an answer before it can be relied on is
 * `needs_research`. The compiler never emits `verified` for anything about the
 * outside world — only for MADRE's own policy, which is code.
 */

import type {
  Capability,
  CompiledMission,
  MissionIntent,
  MissionKind,
  MissionTask,
  Statement,
  VerificationCriterion,
} from '../types.ts';
import { unique } from '../util.ts';
import { RulesIntentClassifier, type IntentClassifier } from './intent.ts';
import {
  DELIVERABLES,
  DESIRED_OUTCOMES,
  HYPOTHESES,
  IDEAL_EXTRAS,
  BRAND_TASK,
  LOGO_REQUEST,
  LOGO_TASK,
  RESEARCH_QUESTIONS,
  TEMPLATES,
  type TaskTemplate,
} from './templates.ts';

export interface CompileOptions {
  classifier?: IntentClassifier;
  /** Documents the user attached. Affects document-analysis missions. */
  providedDocuments?: number;
  /** Cap on worker tasks. Keeps a broad mission from exploding. */
  maxTasks?: number;
}

const MAX_TASKS = 8;

export function taskIdFor(capability: Capability): string {
  return `t-${capability.replace(/[^a-z0-9]+/gi, '-')}`;
}

function pickTemplates(intent: MissionIntent, maxTasks: number): TaskTemplate[] {
  const wantsLogo = LOGO_REQUEST.test(intent.rawText);
  // A mission that is just "make me a logo" gets the brand direction and the logo,
  // not the generic questions of a general mission.
  if (wantsLogo && intent.kind === 'general') return [BRAND_TASK, LOGO_TASK];
  const chosen = pickBase(intent, maxTasks);
  // Asked for a logo inside a bigger mission: add it after the brand step.
  if (wantsLogo && !chosen.some((t) => t.capability === 'design.logo')) {
    if (!chosen.some((t) => t.capability === 'design.brand')) chosen.push(BRAND_TASK);
    chosen.push(LOGO_TASK);
  }
  return chosen;
}

function pickBase(intent: MissionIntent, maxTasks: number): TaskTemplate[] {
  const kinds: MissionKind[] = [intent.kind, ...intent.secondaryKinds];
  const chosen: TaskTemplate[] = [];
  const seen = new Set<Capability>();

  const push = (template: TaskTemplate): void => {
    if (seen.has(template.capability)) return;
    if (template.when !== undefined && !template.when.test(intent.rawText)) return;
    seen.add(template.capability);
    chosen.push(template);
  };

  const primary = TEMPLATES[intent.kind];
  // A simple, single-purpose request keeps to the core of its template.
  const primaryLimit = intent.complexity === 'simple' ? Math.min(primary.length, 4) : primary.length;
  for (const t of primary.slice(0, primaryLimit)) push(t);

  // Secondary kinds add their capabilities only for non-simple missions, one or
  // two each, so a two-topic request gets both covered without doubling up.
  if (intent.complexity !== 'simple') {
    for (const kind of kinds.slice(1)) {
      let added = 0;
      for (const t of TEMPLATES[kind]) {
        if (chosen.length >= maxTasks || added >= 2) break;
        const before = chosen.length;
        push(t);
        if (chosen.length > before) added += 1;
      }
    }
  }
  return chosen.slice(0, maxTasks);
}

function toTasks(templates: readonly TaskTemplate[]): MissionTask[] {
  const present = new Set(templates.map((t) => t.capability));
  return templates.map((t) => ({
    id: taskIdFor(t.capability),
    title: t.title,
    capability: t.capability,
    description: t.description,
    after: (t.after ?? []).filter((c) => present.has(c)).map(taskIdFor),
    dependency: t.dependency ?? 'soft',
  }));
}

function buildContext(intent: MissionIntent): Statement[] {
  const context: Statement[] = [];
  if (intent.subject !== null) context.push({ text: `La petición, en palabras del usuario: «${intent.subject}».`, provenance: 'user_provided' });
  for (const place of intent.mentions.places) context.push({ text: `La petición menciona este lugar: ${place}.`, provenance: 'user_provided' });
  for (const t of intent.mentions.timeframes) context.push({ text: `La petición menciona un plazo: ${t}.`, provenance: 'user_provided' });
  for (const a of intent.mentions.amounts) {
    context.push({ text: `La petición menciona un importe: ${a.raw}${a.currency !== null ? ` (${a.currency})` : ''}.`, provenance: 'user_provided' });
  }
  if (intent.needsFreshInformation) {
    context.push({
      text: 'Las condiciones actuales del mercado, los precios y las normas todavía no se conocen y hay que investigarlos.',
      provenance: 'needs_research',
    });
  }
  return context;
}

function buildConstraints(intent: MissionIntent): Statement[] {
  const constraints: Statement[] = [];
  for (const a of intent.mentions.amounts) {
    constraints.push({
      text: `Se menciona ${a.raw}; trátalo como un límite solo si el usuario confirma que lo es.`,
      provenance: 'user_provided',
    });
  }
  for (const t of intent.mentions.timeframes) {
    constraints.push({ text: `Plazo mencionado: ${t}.`, provenance: 'user_provided' });
  }
  const policy = 'MADRE permission policy';
  constraints.push({ text: 'No se publica, envía, compra ni paga nada sin una aprobación explícita.', provenance: 'verified', source: policy });
  constraints.push({ text: 'Las cifras y afirmaciones que no estén aportadas ni respaldadas por una fuente se etiquetan como supuestos.', provenance: 'verified', source: policy });
  return constraints;
}

function buildVerification(intent: MissionIntent): VerificationCriterion[] {
  const criteria: VerificationCriterion[] = [
    {
      id: 'vc-coverage',
      description: 'El resultado de cada agente responde a la tarea que se le encargó.',
      appliesTo: ['*'],
      check: 'coverage',
      severity: 'must',
    },
    {
      id: 'vc-assumptions',
      description: 'Los supuestos y las hipótesis se etiquetan como tales y nunca se presentan como hechos.',
      appliesTo: ['*'],
      check: 'assumptions_labelled',
      severity: 'must',
    },
    {
      id: 'vc-evidence',
      description: 'Las cifras, las afirmaciones sobre el mercado y las fuentes citadas se marcan como respaldadas o como pendientes de investigar.',
      appliesTo: ['*'],
      check: 'evidence',
      severity: intent.needsFreshInformation ? 'must' : 'should',
    },
    {
      id: 'vc-consistency',
      description: 'Las cifras y las recomendaciones no se contradicen entre agentes.',
      appliesTo: ['*'],
      check: 'consistency',
      severity: 'should',
    },
    {
      id: 'vc-actionability',
      description: 'El informe final nombra próximas acciones concretas, cada una con algo que hacer o que probar.',
      appliesTo: ['final'],
      check: 'actionability',
      severity: 'must',
    },
  ];
  return criteria;
}

export function compileMission(text: string, options: CompileOptions = {}): CompiledMission {
  const classifier = options.classifier ?? new RulesIntentClassifier();
  const intent = classifier.classify(text);

  const templates = pickTemplates(intent, options.maxTasks ?? MAX_TASKS);
  const tasks = toTasks(templates);

  const requiredCapabilities = unique([
    ...tasks.map((t) => t.capability),
    ...(IDEAL_EXTRAS[intent.kind] ?? []).filter((c) => c !== 'research.web' || intent.needsFreshInformation),
    ...(intent.sensitivity.involvesPublishing && intent.kind === 'content_campaign' ? ['content.publish'] : []),
    'qa.review',
    'integration.brief',
  ]);

  const openQuestions = unique([...intent.ambiguities, ...(RESEARCH_QUESTIONS[intent.kind] ?? [])]);
  const objectiveText = intent.subject ?? intent.rawText.trim();

  const assumptions: Statement[] = (HYPOTHESES[intent.kind] ?? []).map((h) => ({ text: h, provenance: 'hypothesis' as const }));

  return {
    intent,
    objective: { text: objectiveText, provenance: 'user_provided' },
    context: buildContext(intent),
    constraints: buildConstraints(intent),
    desiredOutcome: { text: DESIRED_OUTCOMES[intent.kind], provenance: 'hypothesis' },
    assumptions,
    openQuestions,
    requiredCapabilities,
    tasks,
    verificationCriteria: buildVerification(intent),
    expectedDeliverable: DELIVERABLES[intent.kind],
  };
}
