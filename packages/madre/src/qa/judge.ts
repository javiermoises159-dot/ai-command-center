/**
 * Independent judge.
 *
 * Reads what the agents produced and answers the questions a sceptical
 * reviewer would ask, without any model: does it answer the mission, does it
 * meet the stated requirements, is data presented without a source, do the
 * agents contradict each other or the user, is anything unfinished, can
 * someone act on it, does it still need research, and are hypotheses being
 * stated as facts?
 *
 * The judge is deliberately separate from the QA *agent*. The agent writes a
 * narrative review; the judge produces the verdict the engine acts on, and it
 * is deterministic, so the same output always gets the same verdict. A
 * model-backed judge can implement the same `Judge` interface later.
 *
 * Simulated output (from the mock provider) is never judged on content. It is
 * checked for structure only, and the verdict is capped at PASS_WITH_WARNINGS:
 * a simulation cannot be verified, so it cannot pass.
 */

import { newId } from '@acc/domain';

import type {
  MissionPlan,
  MissionStep,
  QACategory,
  QAChecklistItem,
  QAIssue,
  QAResult,
  QAVerdict,
  StepState,
} from '../types.ts';
import { provenanceOf, unique } from '../util.ts';
import { findArithmeticErrors } from '../tools/calculator.ts';
import { lintProse } from './prose.ts';

export interface JudgeSubject {
  step: MissionStep;
  state: StepState;
}

export interface JudgeInput {
  plan: MissionPlan;
  stage: 'workers' | 'final';
  round: number;
  /** Worker steps (stage `workers`) or worker steps plus the final brief (stage `final`). */
  subjects: readonly JudgeSubject[];
  /** The integrator's text, for the final stage. */
  finalText?: string | null;
  now: Date;
}

export interface Judge {
  readonly id: string;
  review(input: JudgeInput): QAResult;
}

/** Markers each agent's deliverable should contain. Lenient on purpose: a marker is a topic, not a heading. */
const EXPECTED_MARKERS: Record<string, { label: string; re: RegExp }[]> = {
  strategy: [
    { label: 'posicionamiento', re: /position|posicion|posizion|wedge|framing/i },
    { label: 'segmento objetivo', re: /segment|customer|cliente|buyer|audience/i },
    { label: 'criterios de éxito', re: /success|criteria|criterio|metric|m[eé]trica|obiettiv/i },
    { label: 'riesgo principal', re: /risk|riesgo|rischio/i },
  ],
  research: [
    { label: 'mercado', re: /market|mercado|mercato/i },
    { label: 'actores comparables', re: /competitor|comparable|player|incumbent|competencia|concorrent/i },
    { label: 'restricciones', re: /constraint|regulat|rule|norm|restric|vincol/i },
    { label: 'preguntas abiertas', re: /open question|unknown|to research|unverified|preguntas abiertas|no verificad|domande/i },
  ],
  engineering: [
    { label: 'stack técnico', re: /stack|technolog|tecnolog|architect|arquitect/i },
    { label: 'fases', re: /phase|sequence|step|fase|etapa|milestone/i },
    { label: 'riesgo', re: /risk|riesgo|rischio/i },
  ],
  design: [
    { label: 'recorrido del usuario', re: /journey|flow|recorrido|flusso|experience|experiencia/i },
    { label: 'dirección visual', re: /principle|visual|direction|identity|identidad|tone|tono/i },
    { label: 'pantalla clave', re: /screen|pantalla|schermata|page|p[aá]gina/i },
  ],
  marketing: [
    { label: 'mensaje central', re: /message|mensaje|messaggio|positioning/i },
    { label: 'canales', re: /channel|canal|canale|platform|plataforma/i },
    { label: 'métrica de éxito', re: /metric|kpi|success|m[eé]trica|obiettiv/i },
  ],
  finance: [
    { label: 'costes y margen', re: /cost|coste|costo|margin|margen|contribution|unit/i },
    { label: 'punto de equilibrio', re: /break-?even|punto de equilibrio|pareggio/i },
    { label: 'supuestos', re: /assum|supuest|assunzion|estimat/i },
  ],
};

const MIN_WORKER_CHARS = 250;
const MIN_FINAL_CHARS = 400;

const ASSUMPTION_CUE =
  /assum|estimate|estimat|illustrat|placeholder|example|hypothes|supuest|stima|assunt|approx|\bif\b|\bsi\b|~|unverified|no verificad|not measured|not sourced|to be validated|por validar|aproximad|estimaci[oó]n|estimad[oa]|hip[oó]tesis|ilustrativ|de ejemplo|orientativ|por confirmar|sin verificar|a validar|pendiente de (?:validar|comprobar|verificar)|fuente:/i;

const OVERCONFIDENT =
  /\b(?:guaranteed|guarantees|will definitely|will certainly|proven|no competition|no competitors|everyone wants|everybody wants|the (?:largest|fastest-growing) market|garantizad[oa]s?|garantiza(?:mos)?|sin competencia|sin competidores|todo el mundo quiere|todo el mundo necesita|seguro que|con toda seguridad|sin duda alguna|es indiscutible|est[aá] garantizado|el mercado (?:m[aá]s grande|de mayor crecimiento)|[eé]xito asegurado|senza concorrenza|garantit[oa])\b/i;

const LIMITS_ACKNOWLEDGED =
  /without (?:live )?(?:sources|research|browsing)|model knowledge|not (?:been )?verified|needs? (?:to be )?(?:researched|verified)|no live|unverified|sin fuentes|sin fuentes en vivo|no verificad|sin verificar|por (?:verificar|contrastar|comprobar)|hay que (?:verificar|contrastar|comprobar)|conocimiento del modelo|sin acceso a (?:internet|fuentes|datos en vivo)|senza fonti|non verificat/i;

const NEXT_ACTIONS_HEADING =
  /next actions|sequenced next actions|siguientes (?:pasos|acciones)|pr[oó]xim[oa]s (?:pasos|acciones)|acciones (?:siguientes|inmediatas|concretas)|plan de acci[oó]n|qu[eé] hacer (?:ahora|a continuaci[oó]n)|primeros pasos|prossimi (?:passi|azioni)/i;

const LABELLED_FIGURE = /\b(price|cost|budget|cac|margin|break-?even|revenue|precio|coste|presupuesto|margen|ingresos)\b[^\d\n]{0,24}(\d[\d.,]*)/gi;

const FIGURE = /(?:[€$£]\s*\d[\d.,]*|\d[\d.,]*\s*(?:%|€|\$|£|eur\b|usd\b|k\b|million|millones))/i;

/**
 * Appeals to an authority that is never named ("según estudios", "studies
 * show"). They read as evidence but carry none, so they are reported unless the
 * same line actually names a source.
 */
const UNSOURCED_CLAIM =
  /seg[uú]n (?:estudios|los estudios|un estudio|investigaciones|la investigaci[oó]n|expertos|los expertos|analistas|los analistas|datos del sector|fuentes del sector)|los expertos (?:afirman|coinciden|dicen|se[ñn]alan|recomiendan)|los analistas (?:afirman|coinciden|prev[eé]n)|est[aá] demostrado que|se ha demostrado que|(?:los estudios|las investigaciones|los datos) (?:demuestran|muestran|indican|confirman)|(?:es|est[aá]) (?:bien )?(?:sabido|demostrado) que|todo el mundo sabe que|la mayor[ií]a de los (?:expertos|estudios)|studies show|research shows|experts (?:say|agree|estimate)|it (?:is|has been) proven that|it is well known that|according to (?:studies|experts|research|analysts)/i;

/** A line that names where something came from does not count as unsourced. */
const NAMED_SOURCE = /https?:\/\/|\bwww\.|\[[^\]]+\]\(|\bfuentes?\s*:|\bsources?\s*:|\(\s*\d{4}\s*\)/i;

function text(state: StepState): string {
  return state.result?.text ?? '';
}

/** Provenance decides, not the provider's name: a result says for itself whether a model ran. */
function isSimulated(state: StepState): boolean {
  return state.result !== null && provenanceOf(state.result).simulated;
}

function parseNumber(raw: string): number | null {
  let s = raw.replace(/[.,]$/, '');
  if (/^\d{1,3}(,\d{3})+$/.test(s)) s = s.replace(/,/g, '');
  else if (/^\d{1,3}(\.\d{3})+$/.test(s)) s = s.replace(/\./g, '');
  else s = s.replace(',', '.');
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

function keywords(missionText: string): string[] {
  const stop = new Set(['the', 'and', 'for', 'with', 'from', 'that', 'this', 'into', 'about', 'want', 'need', 'quiero', 'para', 'una', 'uno', 'que', 'con', 'los', 'las', 'del', 'por', 'como', 'voglio', 'vorrei', 'della', 'per', 'lanzar', 'launch', 'tell', 'should', 'first', 'plan']);
  return unique(
    missionText
      .toLowerCase()
      .replace(/\[[a-z]+:[^\]]*\]/gi, ' ')
      .normalize('NFD')
      .replace(/[̀-ͯ]/g, '')
      .split(/[^a-z0-9]+/)
      .filter((w) => w.length > 3 && !stop.has(w)),
  ).slice(0, 8);
}

function norm(s: string): string {
  return s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
}

/** Spanish agreement: "1 cifra" / "3 cifras". Never "1 cifra(s)". */
function plural(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`;
}

/** Display names for the verdict codes. The codes themselves never change. */
const VERDICT_LABEL: Record<QAVerdict, string> = {
  PASS: 'apto',
  PASS_WITH_WARNINGS: 'aprobado con avisos',
  NEEDS_REVISION: 'necesita revisión',
  BLOCKED: 'bloqueado',
};

export class RulesJudge implements Judge {
  readonly id = 'rules-judge@1';

  review(input: JudgeInput): QAResult {
    const { plan, stage, round } = input;
    const issues: QAIssue[] = [];
    const checklist: QAChecklistItem[] = [];
    let counter = 0;
    const add = (
      category: QACategory,
      severity: QAIssue['severity'],
      subject: JudgeSubject | null,
      message: string,
      evidence: string | null = null,
      suggestion: string | null = null,
    ): QAIssue => {
      const issue: QAIssue = {
        id: `q${round}-${(counter += 1)}`,
        category,
        severity,
        stepId: subject?.step.id ?? null,
        agentId: subject?.step.agentId ?? null,
        message,
        evidence,
        suggestion,
      };
      issues.push(issue);
      return issue;
    };

    const workers = input.subjects.filter((s) => s.step.kind === 'agent');
    const done = workers.filter((s) => s.state.status === 'DONE');
    const failed = workers.filter((s) => s.state.status === 'FAILED');
    const blocked = workers.filter((s) => s.state.status === 'BLOCKED' || s.state.status === 'CANCELLED');
    const missionText = plan.compiled.intent.rawText;
    const userAmounts = new Set(plan.compiled.intent.mentions.amounts.map((a) => a.value));
    const anySimulated = done.some((s) => isSimulated(s.state));

    // ---- unfinished work ----------------------------------------------------
    for (const s of failed) {
      add('incomplete', 'major', s, `«${s.step.title}» falló y no dejó ningún resultado.`, s.state.error, 'Vuelve a ejecutar el paso o cubre su trabajo de otra forma.');
    }
    for (const s of blocked) {
      add('incomplete', 'warning', s, `«${s.step.title}» no llegó a ejecutarse: ${s.state.blockedReason ?? s.state.status.toLowerCase()}.`, null, 'Resuelve el bloqueo y vuelve a ejecutarlo.');
    }
    checklist.push({
      question: '¿Está terminado cada paso planificado?',
      answer: failed.length + blocked.length === 0 ? 'yes' : done.length > 0 ? 'partial' : 'no',
      note:
        failed.length + blocked.length > 0
          ? `${plural(failed.length, 'paso fallido', 'pasos fallidos')}, ${plural(blocked.length, 'paso sin ejecutar', 'pasos sin ejecutar')}.`
          : null,
    });

    if (done.length === 0 && workers.length > 0) {
      add('incomplete', 'blocker', null, 'Ningún especialista produjo un resultado, así que no hay nada que revisar ni integrar.');
    }

    // ---- per-result checks --------------------------------------------------
    let respondsIssues = 0;
    let requirementsIssues = 0;
    let unverifiedIssues = 0;
    let hypothesisIssues = 0;
    let researchIssues = 0;

    const kw = keywords(missionText);
    for (const s of done) {
      const body = text(s.state);
      const simulated = isSimulated(s.state);

      // Does it answer the mission? Structural, so it applies to simulations too.
      if (kw.length >= 2) {
        const hay = norm(body);
        const hits = kw.filter((k) => hay.includes(norm(k))).length;
        if (hits / kw.length < 0.2) {
          respondsIssues += 1;
          add('responds_to_mission', 'major', s, `«${s.step.title}» apenas menciona de qué trata la misión.`, null, 'Conecta la respuesta con la misión ya en el primer párrafo.');
        }
      }
      if (body.trim().length < MIN_WORKER_CHARS) {
        requirementsIssues += 1;
        add('incomplete', 'major', s, `«${s.step.title}» es demasiado corto para ser un entregable real (${body.trim().length} caracteres).`, null, 'Desarrolla cada parte esperada del entregable.');
      }

      if (simulated) continue; // content checks below need real output

      // Required parts of the deliverable.
      const markers = EXPECTED_MARKERS[s.step.agentId];
      if (markers !== undefined) {
        const missing = markers.filter((m) => !m.re.test(body)).map((m) => m.label);
        if (missing.length > 0) {
          requirementsIssues += 1;
          add(
            'incomplete',
            missing.length * 2 >= markers.length ? 'major' : 'warning',
            s,
            `«${s.step.title}» no cubre: ${missing.join(', ')}.`,
            null,
            `Añade: ${missing.join(', ')}.`,
          );
        }
      }

      // Figures without a stated basis.
      const unlabelled = body
        .split('\n')
        .filter((line) => !/^\s*(?:>|#)/.test(line) && FIGURE.test(line) && !ASSUMPTION_CUE.test(line))
        .filter((line) => {
          const figures = [...line.matchAll(/\d[\d.,]*/g)].map((m) => parseNumber(m[0]));
          return !figures.every((f) => f !== null && userAmounts.has(f));
        });
      // A table or list section headed by an assumption note covers its rows.
      const coveredByHeader =
        /assumption|supuest|assunzion/i.test(body) && /every figure|all figures|todas las cifras|toda cifra|cada cifra|ogni cifra/i.test(body);
      if (unlabelled.length > 0 && !coveredByHeader) {
        unverifiedIssues += 1;
        add(
          'unverified_data',
          unlabelled.length >= 3 ? 'major' : 'warning',
          s,
          `«${s.step.title}» da ${plural(unlabelled.length, 'cifra', 'cifras')} sin fuente y sin etiquetar como supuesto.`,
          unlabelled[0]!.trim().slice(0, 200),
          'Etiqueta cada cifra como aportada por el usuario, con fuente o supuesta.',
        );
      }

      // Hypotheses stated as facts.
      const overconfident = OVERCONFIDENT.exec(body);
      if (overconfident !== null) {
        hypothesisIssues += 1;
        add('hypothesis_as_fact', 'major', s, `«${s.step.title}» presenta una conjetura como certeza: «${overconfident[0]}».`, overconfident[0], 'Dilo como hipótesis y explica cómo se comprobaría.');
      }

      // Needs research and admits it?
      if ((s.state.result?.caveats.length ?? 0) > 0 && !LIMITS_ACKNOWLEDGED.test(body)) {
        researchIssues += 1;
        add(
          'needs_research',
          'warning',
          s,
          `«${s.step.title}» se generó sin fuentes en vivo y no lo advierte.`,
          s.state.result?.caveats[0] ?? null,
          'Añade una nota breve: las cifras vienen del conocimiento del modelo y hay que comprobarlas.',
        );
      }

      // Appeals to an unnamed authority ("según estudios", "studies show").
      const unsourced = body
        .split('\n')
        .filter((line) => !/^\s*(?:>|#)/.test(line) && UNSOURCED_CLAIM.test(line) && !NAMED_SOURCE.test(line));
      if (unsourced.length > 0) {
        unverifiedIssues += 1;
        add(
          'unverified_data',
          unsourced.length >= 3 ? 'major' : 'warning',
          s,
          `«${s.step.title}» apela a estudios o expertos que no nombra (${plural(unsourced.length, 'afirmación', 'afirmaciones')}).`,
          unsourced[0]!.trim().slice(0, 200),
          'Nombra la fuente concreta o preséntalo como hipótesis por verificar.',
        );
      }

      // Arithmetic the agent showed.
      for (const f of findArithmeticErrors(body)) {
        unverifiedIssues += 1;
        add(
          'contradiction',
          'major',
          s,
          `La aritmética no cuadra: ${f.expression} = ${f.claimed}, pero da ${f.actual}.`,
          f.line,
          'Recalcula y corrige todas las cifras que dependan de ella.',
        );
      }
    }

    // ---- contradictions across agents and with the user --------------------
    const seen = new Map<string, { value: number; subject: JudgeSubject }>();
    let contradictions = 0;
    for (const s of done) {
      if (isSimulated(s.state)) continue;
      for (const m of text(s.state).matchAll(LABELLED_FIGURE)) {
        const label = norm(m[1]!).replace(/[^a-z]/g, '');
        const value = parseNumber(m[2]!);
        if (value === null) continue;
        if (label === 'budget' || label === 'presupuesto') {
          if (userAmounts.size > 0 && !userAmounts.has(value)) {
            contradictions += 1;
            add('contradiction', 'major', s, `«${s.step.title}» usa un presupuesto de ${value}, que no es el que dio el usuario (${[...userAmounts].join(', ')}).`, m[0].slice(0, 120), 'Usa la cantidad que aportó el usuario o etiqueta la tuya como supuesto.');
          }
          continue;
        }
        const previous = seen.get(label);
        if (previous !== undefined && previous.subject.step.id !== s.step.id && Math.abs(previous.value - value) > Math.abs(previous.value) * 0.05) {
          contradictions += 1;
          add(
            'contradiction',
            'major',
            s,
            `«${s.step.title}» da ${m[1]!.toLowerCase()} como ${value}, pero «${previous.subject.step.title}» da ${previous.value}.`,
            m[0].slice(0, 120),
            'Reconcilia ambas cifras y di cuál prevalece.',
          );
        } else if (previous === undefined) seen.set(label, { value, subject: s });
      }
    }

    // ---- final brief ---------------------------------------------------------
    let actionable: QAChecklistItem['answer'] = 'n/a';
    let sectionsAnswer: QAChecklistItem['answer'] = 'n/a';
    if (stage === 'final') {
      const final = input.finalText ?? '';
      const integrate = input.subjects.find((s) => s.step.kind === 'integrate');
      const finalSimulated = integrate !== undefined && isSimulated(integrate.state);

      if (final.trim().length < MIN_FINAL_CHARS) {
        add('incomplete', 'major', integrate ?? null, `El informe final es demasiado corto (${final.trim().length} caracteres).`, null, 'Cubre todas las secciones del entregable.');
        actionable = 'no';
        sectionsAnswer = 'no';
      } else if (!finalSimulated) {
        const sections = plan.compiled.expectedDeliverable.sections;
        const lower = norm(final);
        const present = sections.filter((sec) => lower.includes(norm(sec).replace(/ and /g, ' ').split(' ')[0]!));
        const missingSections = sections.filter((s) => !present.includes(s));
        sectionsAnswer = missingSections.length === 0 ? 'yes' : present.length * 2 >= sections.length ? 'partial' : 'no';
        if (missingSections.length > 0) {
          requirementsIssues += 1;
          add(
            'requirements',
            present.length * 2 >= sections.length ? 'warning' : 'major',
            integrate ?? null,
            `Al informe le faltan secciones que pide el entregable: ${missingSections.join(', ')}.`,
            null,
            `Añade: ${missingSections.join(', ')}.`,
          );
        }

        const hasHeading = NEXT_ACTIONS_HEADING.test(final);
        const items = (final.match(/^\s*(?:[-*]|\d+[.)])\s+\S/gm) ?? []).length;
        if (!hasHeading || items < 2) {
          actionable = hasHeading || items >= 2 ? 'partial' : 'no';
          add('actionability', 'major', integrate ?? null, 'El informe no termina con acciones concretas por las que alguien pueda empezar.', null, 'Enumera al menos dos acciones siguientes, cada una con algo que hacer o que probar.');
        } else actionable = 'yes';

        if (
          failed.length + blocked.length > 0 &&
          !/unresolved|not completed|did not (?:run|complete)|missing|gap|pendiente|sin resolver|no (?:se )?complet|no lleg[oó] a terminar|qued[oó] sin|falt[aó]|non completat/i.test(final)
        ) {
          add('incomplete', 'major', integrate ?? null, 'Algunos pasos no terminaron y el informe no lo dice.', null, 'Añade una nota de «sin resolver» que diga qué falta.');
        }

        const style = lintProse(final);
        for (const f of style.slice(0, 4)) add('style', 'info', integrate ?? null, f.message, f.excerpt, null);
      } else {
        actionable = 'n/a';
        sectionsAnswer = 'n/a';
      }
    }

    if (anySimulated || input.subjects.some((s) => isSimulated(s.state))) {
      add(
        'unverified_data',
        'warning',
        null,
        'Parte o todo este resultado está simulado. Su contenido no se ha evaluado y no cuenta como verificado.',
        null,
        'Conecta un proveedor real y vuelve a ejecutar la misión.',
      );
    }

    // ---- checklist ----------------------------------------------------------
    const has = (c: QACategory) => issues.some((i) => i.category === c && i.severity !== 'info');
    checklist.unshift(
      { question: '¿Responde a la misión?', answer: respondsIssues > 0 ? 'no' : done.length === 0 ? 'no' : 'yes', note: null },
      { question: '¿Cumple los requisitos indicados?', answer: requirementsIssues > 0 ? 'partial' : 'yes', note: anySimulated ? 'El contenido simulado no se ha evaluado.' : null },
    );
    checklist.push(
      { question: '¿Hay datos presentados sin fuente ni etiqueta?', answer: unverifiedIssues > 0 ? 'yes' : anySimulated ? 'n/a' : 'no', note: null },
      { question: '¿Se contradicen los agentes entre sí o con el usuario?', answer: contradictions > 0 ? 'yes' : 'no', note: null },
      { question: '¿Queda algo incompleto?', answer: has('incomplete') ? 'yes' : 'no', note: null },
      { question: '¿Se puede actuar sobre el resultado?', answer: stage === 'final' ? actionable : 'n/a', note: stage === 'final' ? null : 'Se juzga sobre el informe final.' },
      { question: '¿Queda algo por investigar?', answer: researchIssues > 0 || (plan.gaps.some((g) => g.capability === 'research.web') && plan.compiled.intent.needsFreshInformation) ? 'yes' : 'no', note: plan.gaps.some((g) => g.capability === 'research.web') ? 'No hay ninguna herramienta de investigación web conectada.' : null },
      { question: '¿Se presentan hipótesis como hechos?', answer: hypothesisIssues > 0 ? 'yes' : anySimulated ? 'n/a' : 'no', note: null },
    );
    if (stage === 'final') checklist.push({ question: '¿El informe contiene las secciones que pide el entregable?', answer: sectionsAnswer, note: null });

    // ---- verdict ------------------------------------------------------------
    let verdict: QAVerdict;
    if (issues.some((i) => i.severity === 'blocker')) verdict = 'BLOCKED';
    else if (issues.some((i) => i.severity === 'major')) verdict = 'NEEDS_REVISION';
    else if (issues.some((i) => i.severity === 'warning')) verdict = 'PASS_WITH_WARNINGS';
    else verdict = 'PASS';
    if (anySimulated && verdict === 'PASS') verdict = 'PASS_WITH_WARNINGS';

    // ---- revision requests: one per step that has a major issue -------------
    const revisionRequests: QAResult['revisionRequests'] = [];
    if (verdict === 'NEEDS_REVISION') {
      const byStep = new Map<string, QAIssue[]>();
      for (const issue of issues) {
        if (issue.severity !== 'major' || issue.stepId === null) continue;
        const list = byStep.get(issue.stepId) ?? [];
        list.push(issue);
        byStep.set(issue.stepId, list);
      }
      for (const [stepId, list] of byStep) {
        const step = input.subjects.find((s) => s.step.id === stepId);
        // A failed step cannot be "revised"; it needs a retry, which is a different action.
        if (step?.state.status === 'FAILED') continue;
        revisionRequests.push({
          stepId,
          issueIds: list.map((i) => i.id),
          instruction: list.map((i) => `${i.message}${i.suggestion !== null ? ` ${i.suggestion}` : ''}`).join(' '),
        });
      }
      if (revisionRequests.length === 0) verdict = 'PASS_WITH_WARNINGS';
    }

    const counts = {
      blocker: issues.filter((i) => i.severity === 'blocker').length,
      major: issues.filter((i) => i.severity === 'major').length,
      warning: issues.filter((i) => i.severity === 'warning').length,
    };
    const summary =
      verdict === 'PASS'
        ? 'Sin incidencias.'
        : `${VERDICT_LABEL[verdict]}: ${plural(counts.blocker, 'bloqueante', 'bloqueantes')}, ${plural(counts.major, 'grave', 'graves')}, ${plural(counts.warning, 'aviso', 'avisos')}.`;

    return {
      id: newId(),
      stage,
      round,
      verdict,
      issues,
      checklist,
      revisionRequests,
      summary,
      judge: {
        id: this.id,
        kind: 'rules',
        note: anySimulated ? 'Basado en reglas. Del resultado simulado solo se comprobó la estructura.' : 'Basado en reglas y determinista.',
      },
      at: input.now.toISOString(),
    };
  }
}
