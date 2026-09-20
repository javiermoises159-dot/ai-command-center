/**
 * Business and opportunity engine.
 *
 *   PROBLEM → MARKET → CUSTOMER → OFFER → ACQUISITION → DELIVERY → MEASUREMENT → ITERATION
 *
 * The engine never decides an idea is good. It records, per stage, what is
 * *known* (evidence supplied), what is *assumed*, and what is *unknown*, ranks
 * the assumptions the idea depends on most, and proposes the cheapest test.
 * The output is a set of open questions, not a verdict.
 */

export const OPPORTUNITY_STAGES = ['PROBLEM', 'MARKET', 'CUSTOMER', 'OFFER', 'ACQUISITION', 'DELIVERY', 'MEASUREMENT', 'ITERATION'] as const;
export type OpportunityStage = (typeof OPPORTUNITY_STAGES)[number];

export type EvidenceStatus = 'evidenced' | 'assumed' | 'unknown';

export interface StageInput {
  /** What the person states about this stage. */
  statement?: string;
  /** Evidence they can point to: interviews, data, sales, documents. */
  evidence?: string[];
  /** 1 (little rides on it) to 5 (the idea fails without it). Defaults from the stage. */
  criticality?: 1 | 2 | 3 | 4 | 5;
}

export interface StageAssessment {
  stage: OpportunityStage;
  status: EvidenceStatus;
  statement: string | null;
  evidence: string[];
  criticality: number;
  question: string;
}

const QUESTIONS: Record<OpportunityStage, string> = {
  PROBLEM: '¿Quién tiene este problema, con qué frecuencia y qué hace hoy para resolverlo?',
  MARKET: '¿Cuántas personas o empresas lo tienen, y la cifra viene de una fuente en lugar de una estimación?',
  CUSTOMER: '¿Quién paga exactamente, y alguno de ellos ha dicho que lo haría?',
  OFFER: '¿Qué se vende, a qué precio y por qué superaría a la alternativa actual?',
  ACQUISITION: '¿De dónde saldrán los primeros clientes y cuánto cuesta llegar a uno?',
  DELIVERY: '¿Se puede entregar con la calidad prometida, a tiempo y a un coste que deje margen?',
  MEASUREMENT: '¿Qué cifra demostrará que funciona y qué valor contaría como fracaso?',
  ITERATION: '¿Qué se cambiará si la primera prueba no funciona?',
};

const DEFAULT_CRITICALITY: Record<OpportunityStage, 1 | 2 | 3 | 4 | 5> = { PROBLEM: 5, MARKET: 3, CUSTOMER: 5, OFFER: 4, ACQUISITION: 4, DELIVERY: 3, MEASUREMENT: 2, ITERATION: 1 };

export interface ValidationExperiment {
  hypothesis: string;
  method: string;
  metric: string;
  successThreshold: string;
  failureThreshold: string;
  cost: string;
  stage: OpportunityStage;
}

export interface OpportunityBrief {
  idea: string;
  stages: StageAssessment[];
  riskiest: StageAssessment[];
  experiment: ValidationExperiment;
  /** Always states that the idea has not been shown to be good. */
  verdict: string;
  readiness: { evidenced: number; assumed: number; unknown: number };
}

const EXPERIMENTS: Record<OpportunityStage, Omit<ValidationExperiment, 'hypothesis' | 'stage'>> = {
  PROBLEM: { method: 'Entrevista a personas que plausiblemente tengan el problema y pregúntales cómo lo resuelven hoy. No describas tu solución.', metric: 'Número de entrevistados que describen el problema sin que se lo sugieras y que ya pagan o improvisan una solución', successThreshold: 'Defínelo antes de empezar; por ejemplo, la mayoría de diez entrevistados', failureThreshold: 'Defínelo antes de empezar; por ejemplo, menos de tres de diez', cost: 'Solo tiempo' },
  MARKET: { method: 'Cuenta los compradores alcanzables a partir de una fuente que puedas citar, no de una estimación.', metric: 'Compradores alcanzables por segmento, con la fuente indicada', successThreshold: 'Una cifra lo bastante grande para que una cuota realista cubra tus costes; la cuota la decides tú', failureThreshold: 'No se encuentra ninguna cifra con fuente', cost: 'Solo tiempo' },
  CUSTOMER: { method: 'Pide a un grupo pequeño una reserva, una señal o un compromiso firmado, no una opinión.', metric: 'Compradores comprometidos sobre el total de personas a las que preguntaste', successThreshold: 'Defínelo antes de empezar', failureThreshold: 'Defínelo antes de empezar; los halagos sin compromiso cuentan como fracaso', cost: 'Tiempo, más una página de aterrizaje o un mensaje' },
  OFFER: { method: 'Muestra dos versiones de la oferta con precios distintos a personas comparables y registra qué eligen.', metric: 'Porcentaje que elige cada versión', successThreshold: 'Una versión claramente preferida a un precio que cubre el coste', failureThreshold: 'No se elige ninguna versión', cost: 'Tiempo, más una maqueta' },
  ACQUISITION: { method: 'Haz una prueba pequeña en un solo canal y registra cuánto te costó cada contacto alcanzado.', metric: 'Coste por contacto y tasa de contacto a compromiso', successThreshold: 'Coste por compromiso por debajo de tu margen por venta', failureThreshold: 'Coste por compromiso por encima de tu margen por venta', cost: 'El presupuesto de prueba que fijes' },
  DELIVERY: { method: 'Entrega un pedido a mano y cronometra y cuantifica cada paso.', metric: 'Coste y tiempo reales por pedido frente a lo prometido', successThreshold: 'Queda margen después del coste real', failureThreshold: 'El coste supera al precio', cost: 'Un pedido' },
  MEASUREMENT: { method: 'Escribe la métrica y su valor de fracaso antes de empezar cualquier prueba.', metric: 'Una métrica escrita', successThreshold: 'Definido de antemano', failureThreshold: 'Definido de antemano', cost: 'Solo tiempo' },
  ITERATION: { method: 'Escribe qué cambiarías después de una prueba fallida.', metric: 'Una lista escrita de cambios', successThreshold: 'Al menos un cambio concreto', failureThreshold: 'Ninguno indicado', cost: 'Solo tiempo' },
};

/** Concordancia de número para los textos que ve el usuario. */
function plural(n: number, one: string, many: string): string {
  return n === 1 ? one : many;
}

/** Etiquetas en español de las fases y de los estados de evidencia. Los valores de enumeración no cambian. */
export const OPPORTUNITY_STAGE_LABEL: Record<OpportunityStage, string> = {
  PROBLEM: 'el problema',
  MARKET: 'el mercado',
  CUSTOMER: 'el cliente',
  OFFER: 'la oferta',
  ACQUISITION: 'la captación',
  DELIVERY: 'la entrega',
  MEASUREMENT: 'la medición',
  ITERATION: 'la iteración',
};

export const EVIDENCE_STATUS_LABEL: Record<EvidenceStatus, string> = {
  evidenced: 'con evidencia',
  assumed: 'un supuesto',
  unknown: 'desconocido',
};

const CRITICAL_ORDER: OpportunityStage[] = ['PROBLEM', 'CUSTOMER', 'OFFER', 'ACQUISITION', 'MARKET', 'DELIVERY', 'MEASUREMENT', 'ITERATION'];

export function assessOpportunity(idea: string, inputs: Partial<Record<OpportunityStage, StageInput>> = {}): OpportunityBrief {
  const stages: StageAssessment[] = OPPORTUNITY_STAGES.map((stage) => {
    const input = inputs[stage] ?? {};
    const statement = input.statement?.trim() ?? '';
    const evidence = (input.evidence ?? []).map((e) => e.trim()).filter((e) => e !== '');
    const status: EvidenceStatus = statement === '' && evidence.length === 0 ? 'unknown' : evidence.length > 0 ? 'evidenced' : 'assumed';
    return { stage, status, statement: statement === '' ? null : statement, evidence, criticality: input.criticality ?? DEFAULT_CRITICALITY[stage], question: QUESTIONS[stage] };
  });

  const weakness = (s: StageAssessment) => (s.status === 'evidenced' ? 0 : s.status === 'assumed' ? 1 : 1.25) * s.criticality;
  const ranked = [...stages].filter((s) => s.status !== 'evidenced').sort((a, b) => weakness(b) - weakness(a) || CRITICAL_ORDER.indexOf(a.stage) - CRITICAL_ORDER.indexOf(b.stage));
  const target = ranked[0]?.stage ?? 'ITERATION';
  const targetAssessment = stages.find((s) => s.stage === target)!;
  const exp = EXPERIMENTS[target];

  const readiness = { evidenced: 0, assumed: 0, unknown: 0 };
  for (const s of stages) readiness[s.status]++;

  return {
    idea,
    stages,
    riskiest: ranked.slice(0, 3),
    experiment: {
      stage: target,
      hypothesis:
        targetAssessment.statement !== null
          ? `${targetAssessment.statement} (ahora mismo ${EVIDENCE_STATUS_LABEL[targetAssessment.status]}, sin evidencia adjunta)`
          : `Todavía no se afirma nada sobre ${OPPORTUNITY_STAGE_LABEL[target]}; lo primero es formularlo.`,
      ...exp,
    },
    verdict: readiness.evidenced === stages.length
      ? 'Todas las fases tienen evidencia adjunta. Eso no demuestra que la idea vaya a funcionar; significa que la siguiente prueba puede ser sobre escala en lugar de sobre existencia.'
      : `No se ha demostrado que la idea sea buena. ${readiness.evidenced} de ${stages.length} ${plural(stages.length, 'fase tiene', 'fases tienen')} evidencia; ` +
        `${readiness.assumed} ${plural(readiness.assumed, 'se apoya', 'se apoyan')} en supuestos y ${readiness.unknown} ${plural(readiness.unknown, 'se desconoce', 'se desconocen')}.`,
    readiness,
  };
}
