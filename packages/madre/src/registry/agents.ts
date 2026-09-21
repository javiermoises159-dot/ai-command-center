/**
 * Agent registry.
 *
 * Declares every agent MADRE knows about, whether it can run today or is only a
 * placeholder for the architecture. Nothing here executes anything: the engine
 * asks the registry who is `active`, and the router refuses to schedule a
 * `planned` agent.
 *
 * The eight active agents map onto the executing agents in `@acc/domain`, whose
 * prompts and deliverables remain the source of truth for what they write.
 */

import type { AgentSpec, AgentStatus, Capability, PermissionLevel } from '../types.ts';

export class AgentRegistry {
  private readonly agents = new Map<string, AgentSpec>();

  constructor(specs: readonly AgentSpec[] = []) {
    for (const spec of specs) this.register(spec);
  }

  register(spec: AgentSpec): this {
    if (this.agents.has(spec.id)) throw new Error(`Agent "${spec.id}" is already registered.`);
    this.agents.set(spec.id, structuredClone(spec));
    return this;
  }

  get(id: string): AgentSpec | undefined {
    return this.agents.get(id);
  }

  require(id: string): AgentSpec {
    const found = this.agents.get(id);
    if (found === undefined) throw new Error(`Unknown agent "${id}".`);
    return found;
  }

  list(): AgentSpec[] {
    return [...this.agents.values()].sort((a, b) => a.order - b.order);
  }

  active(): AgentSpec[] {
    return this.list().filter((a) => a.status === 'active');
  }

  /** Active agents that cover a capability, best fit (fewest other capabilities) first. */
  forCapability(capability: Capability): AgentSpec[] {
    return this.active()
      .filter((a) => a.capabilities.includes(capability))
      .sort((a, b) => a.capabilities.length - b.capabilities.length);
  }

  /** Planned or disabled agents that would cover a capability. Used to explain gaps. */
  plannedFor(capability: Capability): AgentSpec[] {
    return this.list().filter((a) => a.status !== 'active' && a.capabilities.includes(capability));
  }

  /**
   * Change an agent's status. Activating an agent that can move money is
   * refused outright: FINANCIAL capability needs a permission system that gates
   * every action, not a status flag.
   */
  setStatus(id: string, status: AgentStatus): void {
    const spec = this.require(id);
    if (status === 'active' && spec.permissions.includes('FINANCIAL')) {
      throw new Error(`Agent "${id}" holds FINANCIAL permission and cannot be activated by a status change.`);
    }
    spec.status = status;
  }
}

const READ: PermissionLevel[] = ['READ'];

const base = {
  inputs: ['enunciado de la misión', 'misión compilada', 'resultados de los pasos previos'],
  requiredTools: [] as string[],
  optionalTools: ['memory.recall'],
  permissions: READ,
  maxParallelism: 1,
  risk: 'low' as const,
};

function active(spec: Omit<AgentSpec, 'status' | 'statusDetail'> & { statusDetail?: string }): AgentSpec {
  return { ...spec, status: 'active', statusDetail: spec.statusDetail ?? 'Se ejecuta hoy a través del proveedor configurado.' };
}

function planned(
  spec: Omit<AgentSpec, 'status' | 'statusDetail' | 'inputs' | 'requiredTools' | 'optionalTools' | 'maxParallelism' | 'accent'> & {
    statusDetail: string;
    requiredTools?: string[];
  },
): AgentSpec {
  return {
    inputs: ['misión compilada', 'resultados de los pasos previos'],
    optionalTools: [],
    requiredTools: [],
    maxParallelism: 1,
    accent: 'slate',
    ...spec,
    status: 'planned',
  };
}

export function defaultAgentSpecs(): AgentSpec[] {
  return [
    active({
      ...base,
      id: 'strategy',
      name: 'Estrategia',
      description: 'Plantea la misión, elige el ángulo de entrada y define qué significa el éxito.',
      kind: 'worker',
      legacyAgentId: 'strategy',
      capabilities: ['strategy.positioning', 'strategy.prioritization', 'strategy.assumptions'],
      outputs: ['propuesta de posicionamiento', 'segmento objetivo', 'criterios de éxito', 'principal riesgo estratégico'],
      preferredTiers: ['local_strong', 'external', 'local'],
      minModelQuality: 3,
      costClass: 'medium',
      verification: [
        'nombra un único segmento objetivo',
        'los criterios de éxito son medibles',
        'nombra el riesgo principal',
        'separa los supuestos de los hechos',
      ],
      accent: 'violet',
      order: 10,
    }),
    active({
      ...base,
      id: 'research',
      name: 'Investigación',
      description: 'Analiza el mercado, la competencia y las restricciones, y señala lo que todavía se desconoce.',
      kind: 'worker',
      legacyAgentId: 'research',
      capabilities: ['research.market', 'research.competitors', 'research.regulatory', 'research.audience', 'research.documents'],
      outputs: ['contexto de mercado', 'actores comparables', 'restricciones', 'preguntas abiertas'],
      optionalTools: ['web.search', 'research.wikipedia', 'web.fetch', 'news.gdelt', 'memory.recall'],
      preferredTiers: ['external', 'local_strong', 'local'],
      minModelQuality: 3,
      costClass: 'medium',
      verification: [
        'cada cifra tiene una fuente o se etiqueta como supuesto',
        'las preguntas abiertas se enumeran, no se responden adivinando',
        'las afirmaciones sobre la competencia no se presentan como verificadas',
      ],
      accent: 'sky',
      order: 20,
    }),
    active({
      ...base,
      id: 'engineering',
      name: 'Ingeniería',
      description: 'Diseña la construcción técnica y el camino de entrega.',
      kind: 'worker',
      legacyAgentId: 'code',
      capabilities: ['engineering.architecture', 'engineering.build_plan'],
      outputs: ['stack recomendado', 'forma del sistema', 'fases de construcción', 'principal riesgo técnico'],
      preferredTiers: ['local_strong', 'external', 'local'],
      minModelQuality: 3,
      costClass: 'medium',
      verification: ['cada elección tecnológica tiene una razón de una línea', 'las fases están ordenadas', 'nombra el principal riesgo técnico'],
      accent: 'emerald',
      order: 30,
    }),
    active({
      ...base,
      id: 'design',
      name: 'Diseño',
      description: 'Define la experiencia del producto y la identidad visual.',
      kind: 'worker',
      legacyAgentId: 'design',
      capabilities: ['design.ux', 'design.brand', 'design.logo', 'design.visual_brief'],
      outputs: ['recorrido del usuario', 'principios de interfaz', 'dirección visual', 'pantalla clave', 'opciones de logotipo en SVG'],
      preferredTiers: ['local_strong', 'external', 'local'],
      minModelQuality: 3,
      costClass: 'medium',
      verification: ['el recorrido tiene pasos concretos', 'nombra la pantalla más importante'],
      accent: 'fuchsia',
      order: 40,
    }),
    active({
      ...base,
      id: 'marketing',
      name: 'Marketing',
      description: 'Construye el plan de salida al mercado y de captación.',
      kind: 'worker',
      legacyAgentId: 'marketing',
      capabilities: ['marketing.go_to_market', 'marketing.campaign', 'marketing.messaging'],
      outputs: ['mensaje central', 'dos canales de captación', 'secuencia de lanzamiento', 'métrica de éxito'],
      preferredTiers: ['external', 'local_strong', 'local'],
      minModelQuality: 3,
      costClass: 'medium',
      verification: [
        'los canales se eligen, no solo se enumeran',
        'la métrica está ligada a clientes retenidos o ingresos, no a métricas de vanidad',
        'no se inventan cifras de rendimiento',
      ],
      accent: 'amber',
      order: 50,
    }),
    active({
      ...base,
      id: 'finance',
      name: 'Finanzas',
      description: 'Modela la economía por unidad, los costes y el margen de maniobra financiero. Toda cifra se etiqueta como supuesto salvo que la aporte el usuario.',
      kind: 'worker',
      legacyAgentId: 'finance',
      capabilities: ['finance.unit_economics', 'finance.budget', 'finance.experiment_cost'],
      outputs: ['estructura de costes', 'economía por unidad', 'punto de equilibrio', 'necesidad de financiación'],
      optionalTools: ['math.calculator', 'memory.recall'],
      preferredTiers: ['local_strong', 'external', 'local'],
      minModelQuality: 3,
      costClass: 'medium',
      verification: [
        'cada cifra se etiqueta como supuesto salvo que la haya aportado el usuario',
        'se muestra el cálculo',
        'el punto de equilibrio se indica junto con su condición',
      ],
      accent: 'lime',
      order: 60,
    }),
    active({
      ...base,
      id: 'qa',
      name: 'QA',
      description: 'Audita el trabajo del equipo en busca de lagunas, contradicciones y afirmaciones sin verificar.',
      kind: 'qa',
      legacyAgentId: 'qa',
      capabilities: ['qa.review'],
      outputs: ['veredicto por especialista', 'contradicciones', 'lagunas', 'aprobar / no aprobar'],
      preferredTiers: ['external', 'local_strong', 'local'],
      minModelQuality: 3,
      costClass: 'medium',
      verification: ['nombra al agente responsable de cada problema', 'no reescribe el trabajo que audita'],
      accent: 'rose',
      order: 80,
    }),
    active({
      ...base,
      id: 'integrator',
      name: 'Integrador',
      description: 'Une todos los resultados y la revisión de QA en un único informe sobre el que una persona pueda actuar.',
      kind: 'integrator',
      legacyAgentId: 'integrator',
      capabilities: ['integration.brief'],
      outputs: ['informe de ejecución', 'próximas acciones ordenadas', 'riesgos que se arrastran', 'asuntos sin resolver'],
      preferredTiers: ['local_strong', 'external', 'local'],
      minModelQuality: 3,
      costClass: 'medium',
      verification: ['las próximas acciones tienen responsable', 'los asuntos sin resolver se arrastran, no se descartan'],
      accent: 'cyan',
      order: 90,
    }),

    // ---- Declared, not runnable. They document where the architecture grows. ----
    planned({
      id: 'content',
      name: 'Contenido',
      description: 'Escribe guiones, pies de foto y textos largos con calidad de producción.',
      kind: 'worker',
      legacyAgentId: null,
      capabilities: ['content.script'],
      outputs: ['guiones', 'pies de foto', 'textos'],
      preferredTiers: ['local_strong', 'external'],
      minModelQuality: 4,
      costClass: 'medium',
      permissions: ['READ', 'WRITE'],
      verification: ['ninguna afirmación sin fuente', 'supera la revisión de escritura humana'],
      risk: 'low',
      order: 110,
      statusDetail: 'Planificado. Marketing cubre hoy los textos de campaña; un agente dedicado necesita sus propios prompts y su propio ciclo de revisión.',
    }),
    planned({
      id: 'video',
      name: 'Vídeo',
      description: 'Convierte un guion en un vídeo: recursos, voz, edición y subtítulos.',
      kind: 'worker',
      legacyAgentId: null,
      capabilities: ['content.video', 'content.voice'],
      outputs: ['vídeo renderizado', 'subtítulos', 'miniaturas'],
      preferredTiers: ['specialized', 'local'],
      minModelQuality: 3,
      costClass: 'high',
      permissions: ['READ', 'WRITE', 'EXECUTE'],
      requiredTools: ['media.ffmpeg', 'media.whisper', 'media.video_generation', 'media.voice_generation'],
      verification: ['los subtítulos coinciden con el audio', 'el resultado se reproduce de principio a fin'],
      risk: 'medium',
      order: 120,
      statusDetail: 'Planificado. Necesita FFmpeg, Whisper y un servicio de generación de vídeo y voz, y ninguno está conectado.',
    }),
    planned({
      id: 'social',
      name: 'Redes sociales',
      description: 'Programa y publica en redes sociales, y lee sus analíticas.',
      kind: 'worker',
      legacyAgentId: null,
      capabilities: ['content.publish', 'content.analytics'],
      outputs: ['publicaciones emitidas', 'informes de analítica'],
      preferredTiers: ['specialized'],
      minModelQuality: 2,
      costClass: 'low',
      permissions: ['READ', 'EXTERNAL_ACTION', 'PUBLISH'],
      requiredTools: ['distribution.tiktok', 'distribution.instagram', 'distribution.youtube'],
      verification: ['toda publicación la aprueba antes una persona'],
      risk: 'high',
      order: 130,
      statusDetail: 'Planificado. Publicar exige siempre aprobación explícita y no hay ninguna API de plataforma conectada.',
    }),
    planned({
      id: 'sales',
      name: 'Ventas',
      description: 'Prepara los contactos y el seguimiento de un proceso de ventas.',
      kind: 'worker',
      legacyAgentId: null,
      capabilities: ['sales.outreach'],
      outputs: ['borradores de contacto', 'plan de seguimiento'],
      preferredTiers: ['external', 'local_strong'],
      minModelQuality: 3,
      costClass: 'medium',
      permissions: ['READ', 'EXTERNAL_ACTION'],
      requiredTools: ['comms.email'],
      verification: ['no se envía nada sin aprobación'],
      risk: 'high',
      order: 140,
      statusDetail: 'Planificado. Solo redactaría; el envío seguiría sujeto a aprobación y requiere un conector de correo.',
    }),
    planned({
      id: 'data',
      name: 'Datos',
      description: 'Analiza datos estructurados e informa de lo que muestran.',
      kind: 'worker',
      legacyAgentId: null,
      capabilities: ['data.analysis'],
      outputs: ['análisis', 'gráficos', 'notas de calidad de los datos'],
      preferredTiers: ['local_strong', 'external'],
      minModelQuality: 3,
      costClass: 'medium',
      permissions: ['READ', 'EXECUTE'],
      requiredTools: ['sandbox.exec'],
      verification: ['cada cifra puede recalcularse a partir de los datos de origen'],
      risk: 'medium',
      order: 150,
      statusDetail: 'Planificado. Necesita una herramienta de ejecución de código en entorno aislado.',
    }),
    planned({
      id: 'legal',
      name: 'Legal',
      description: 'Revisa las restricciones legales y de políticas de plataforma, y señala lo que requiere a un profesional.',
      kind: 'worker',
      legacyAgentId: null,
      capabilities: ['legal.compliance'],
      outputs: ['lista de verificación de cumplimiento', 'asuntos que requieren un abogado'],
      preferredTiers: ['external', 'local_strong'],
      minModelQuality: 4,
      costClass: 'medium',
      permissions: ['READ'],
      requiredTools: ['web.search'],
      verification: ['cada norma cita su fuente', 'nunca se presenta como asesoramiento jurídico'],
      risk: 'medium',
      order: 160,
      statusDetail: 'Planificado. Necesita fuentes en vivo; sin ellas el resultado serían conjeturas inverificables sobre la ley.',
    }),
    planned({
      id: 'browser',
      name: 'Navegador',
      description: 'Opera sitios web a través de un navegador cuando no existe una API.',
      kind: 'worker',
      legacyAgentId: null,
      capabilities: ['browser.automation'],
      outputs: ['registro de tareas', 'capturas de pantalla'],
      preferredTiers: ['specialized'],
      minModelQuality: 4,
      costClass: 'high',
      permissions: ['READ', 'EXTERNAL_ACTION'],
      requiredTools: ['computer_use.browser'],
      verification: ['cada paso se observa y se verifica antes del siguiente'],
      risk: 'high',
      order: 170,
      statusDetail: 'Planificado. Usa el ciclo de Uso del ordenador; solo donde no hay API disponible y la plataforma permite la automatización.',
    }),
    planned({
      id: 'computer_use',
      name: 'Uso del ordenador',
      description: 'Opera una aplicación de escritorio: observar, planificar, actuar, verificar y recuperarse.',
      kind: 'worker',
      legacyAgentId: null,
      capabilities: ['computer.use'],
      outputs: ['registro de tareas', 'capturas de pantalla'],
      preferredTiers: ['specialized'],
      minModelQuality: 4,
      costClass: 'high',
      permissions: ['READ', 'EXECUTE', 'EXTERNAL_ACTION'],
      requiredTools: ['computer_use.desktop'],
      verification: ['cada paso se observa y se verifica antes del siguiente'],
      risk: 'high',
      order: 180,
      statusDetail: 'Planificado. El ciclo y su puerto de controlador existen; no hay ningún controlador conectado.',
    }),
    planned({
      id: 'automation',
      name: 'Automatización',
      description: 'Ejecuta flujos de trabajo programados o disparados por eventos.',
      kind: 'worker',
      legacyAgentId: null,
      capabilities: ['automation.workflows'],
      outputs: ['definiciones de flujos de trabajo', 'registros de ejecución'],
      preferredTiers: ['local'],
      minModelQuality: 2,
      costClass: 'low',
      permissions: ['READ', 'WRITE', 'EXECUTE'],
      requiredTools: ['automation.scheduler'],
      verification: ['todo disparador es idempotente'],
      risk: 'medium',
      order: 190,
      statusDetail: 'Planificado. Necesita un planificador y que el sistema de permisos se aplique a cada flujo de trabajo.',
    }),
    planned({
      id: 'trading_research',
      name: 'Investigación de trading',
      description: 'Investiga y simula estrategias. Solo simulación: no puede enviar órdenes.',
      kind: 'worker',
      legacyAgentId: null,
      capabilities: ['trading.research'],
      outputs: ['análisis de señales', 'informe de backtesting', 'evaluación de riesgos'],
      preferredTiers: ['local_strong', 'external'],
      minModelQuality: 4,
      costClass: 'medium',
      permissions: ['READ'],
      verification: ['los resultados se etiquetan como simulación', 'no existe ninguna vía de ejecución real'],
      risk: 'high',
      order: 200,
      statusDetail: 'Planificado. El núcleo de simulación existe como funciones puras; la ejecución real está ausente a propósito.',
    }),
    planned({
      id: 'visual_reverse',
      name: 'Ingeniería inversa visual',
      description: 'Reconstruye una interfaz a partir de capturas o vídeo, para productos propios o cuyo análisis esté autorizado.',
      kind: 'worker',
      legacyAgentId: null,
      capabilities: ['visual.reverse_engineering'],
      outputs: ['mapa de interacción', 'código de componentes', 'diferencia visual'],
      preferredTiers: ['external', 'specialized'],
      minModelQuality: 4,
      costClass: 'high',
      permissions: ['READ', 'WRITE'],
      verification: ['la autorización queda registrada antes de empezar cualquier trabajo'],
      risk: 'medium',
      order: 210,
      statusDetail: 'Planificado. Necesita un modelo con capacidad de visión; rechaza el trabajo sin una autorización registrada.',
    }),
  ];
}

export function createAgentRegistry(): AgentRegistry {
  return new AgentRegistry(defaultAgentSpecs());
}
