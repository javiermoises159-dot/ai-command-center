/** Textos de las misiones: listado, detalle, formulario, canalización de agentes, plan y aprobaciones. */
export const missions = {
  form: {
    ariaLabel: 'Nueva misión',
    label: 'Describe tu misión',
    placeholder: 'Describe lo que quieres lograr. El equipo de agentes lo desglosará por ti…',
    examples: [
      'Quiero lanzar una tienda online de cookies en Italia.',
      'Crear una app móvil para reservar pistas de pádel en Turín.',
      'Abrir una suscripción de café de especialidad en Berlín.',
    ],
    tooShort: (min: number) => `Escribe al menos ${min} caracteres.`,
    hint: 'MADRE convertirá la misión en un plan y lo ejecutará con agentes especializados.',
    classicOption: 'Usar la canalización clásica de ocho agentes (sin plan, enrutado ni revisión de calidad)',
    submit: 'Ejecutar misión',
    submitting: 'Lanzando…',
    createFailed: 'No se pudo crear la misión.',
    activeProviderNote: (label: string) =>
      `Proveedor activo: ${label}. Los resultados se generan de forma simulada y no tienen valor analítico: conecta un proveedor real para obtener respuestas reales.`,
  },

  list: {
    title: 'Misiones',
    description:
      'Todas las misiones que has lanzado, con su estado, sus ejecuciones y su resultado. Abre una para ver trabajar a los agentes.',
    newMission: 'Nueva misión',
    filterAria: 'Filtrar misiones por estado',
    filters: { all: 'Todas', running: 'En curso', completed: 'Completadas', failed: 'Fallidas' },
    searchLabel: 'Buscar misiones',
    emptyAll: 'Aún no hay misiones',
    emptyAllBody: 'Lanza tu primera misión desde el Panel y aparecerá aquí.',
    launch: 'Lanzar una misión',
    /** Título del vacío cuando hay un filtro de estado activo. */
    emptyFiltered: (status: string): string => {
      const titles: Record<string, string> = {
        pending: 'No hay misiones pendientes',
        running: 'No hay misiones en curso',
        completed: 'No hay misiones completadas',
        failed: 'No hay misiones fallidas',
      };
      return titles[status] ?? 'No hay misiones con este estado';
    },
    emptyFilteredBody: 'Prueba con otro filtro para ver el resto del historial.',
    noMatches: 'Sin coincidencias',
    noMatchesBody: (query: string) => `Ninguna de las misiones cargadas coincide con «${query}».`,
    total: (n: number) => `${n} ${n === 1 ? 'misión' : 'misiones'}`,
    shownOf: (shown: number, total: number) => `${shown} de ${total} mostradas`,
  },

  card: {
    working: (done: number, total: number) =>
      `El equipo está trabajando: ${done} de ${total} ${total === 1 ? 'agente completado' : 'agentes completados'}.`,
    agents: (done: number, total: number) => `${done}/${total} ${total === 1 ? 'agente' : 'agentes'}`,
    runs: (n: number) => `${n} ${n === 1 ? 'ejecución' : 'ejecuciones'}`,
    failedAgents: (n: number) => `${n} ${n === 1 ? 'fallido' : 'fallidos'}`,
  },

  detail: {
    loading: 'Cargando misión',
    notFound: 'Misión no encontrada.',
    backToList: 'Volver a misiones',
    allMissions: 'Todas las misiones',
    objective: 'Objetivo',
    directives: 'Directivas de prueba activas:',
    percentComplete: (pct: number) => `${pct} % procesado`,
    agentsDone: (done: number, total: number) =>
      `${done}/${total} ${total === 1 ? 'agente completado' : 'agentes completados'}`,
    failedAgents: (n: number) => `${n} ${n === 1 ? 'fallido' : 'fallidos'}`,
    created: (when: string) => `creada ${when}`,
    runInProgress: 'Ejecución en curso…',
    runAgain: 'Ejecutar de nuevo',
    copyResult: 'Copiar resultado',
    copied: 'Copiado',
    runFailed: 'No se pudo iniciar una nueva ejecución.',
    copyFailed: 'No se pudo copiar al portapapeles.',
    liveInterrupted: (reason: string) => `Actualizaciones en directo interrumpidas: ${reason}`,
    runHistory: 'Historial de ejecuciones',
    runNumber: (n: number) => `Ejecución #${n}`,
    runStatus: {
      pending: 'Pendiente',
      running: 'En curso',
      completed: 'Completada',
      failed: 'Fallida',
    } as Record<string, string>,
    viewAria: 'Vista de la misión',
    viewResult: 'Resultado',
    viewPlan: 'Plan y ejecución',
    runTitle: (isLatest: boolean, attempt: number, agents: number) =>
      `${isLatest ? 'Ejecución actual' : 'Ejecución'} · #${attempt} · ${agents} ${agents === 1 ? 'agente' : 'agentes'}`,
    startedAt: 'inicio',
    tookLabel: 'duración',
    tokens: 'tokens',
    finalResult: 'Resultado final',
    resultOfRun: (attempt: number) => `Resultado de la ejecución #${attempt}`,
    incompleteBrief: (failed: number) =>
      `Este informe está incompleto: ${failed} ${failed === 1 ? 'agente ha fallado' : 'agentes han fallado'}, así que el Integrador trabajó sin su aportación.`,
    noFinalResult: 'No hay resultado final: la ejecución se detuvo antes de que el Integrador pudiera generarlo.',
    finalPendingTitle: 'El informe final aparecerá aquí',
    finalPendingBody: 'El Integrador se ejecuta el último, cuando todos los especialistas y la revisión de QA han informado.',
  },

  pipeline: {
    ariaLabel: 'Canalización de agentes',
    specialist: 'Agente especialista',
    failure: 'Fallo',
    provider: 'proveedor',
    model: 'modelo',
    tokens: 'tokens',
    latency: 'latencia',
    latencyValue: (ms: number) => `${ms} ms`,
    showAssignment: 'Ver encargo',
    hideAssignment: 'Ocultar encargo',
  },

  run: {
    notMadre: 'Esta misión se ejecutó antes de que la canalización clásica pasara por el motor de MADRE, así que no hay plan ni traza que mostrar.',
    classicMode: 'Canalización clásica',
    recoveredTitle: 'Recuperada al arrancar',
    recoveredRetryable: 'Puedes volver a lanzar la misión: lo terminado se conserva en esta ejecución, pero la nueva empieza de cero.',
    recoveredFinal: 'No hay nada que repetir.',
    cancelRun: 'Cancelar ejecución',
    cancelFailed: 'No se pudo cancelar la ejecución.',
    stepsDone: (done: number, total: number) => `${done}/${total} ${total === 1 ? 'paso hecho' : 'pasos hechos'}`,
    confidence: 'Confianza',
    confidenceHint: 'Ajuste del enrutado y de QA; no garantiza que la respuesta sea correcta',
    qaVerdict: 'Veredicto de QA',
    qaPending: 'aún no',
    cost: 'Coste',
    calls: 'Llamadas',
    workingNow: 'Trabajando ahora',
    waitingForYou: (n: number) => `Esperando tu respuesta · ${n}`,
    waitingAria: 'Esperando tu respuesta',
    blockers: 'Bloqueos',
    toResolve: 'Para resolverlo: ',
    nextAction: 'Siguiente acción',
    planTitle: 'Plan y ejecución',
    planMeta: (intent: string, complexity: string) => `${intent} · ${complexity}`,
    gapsTitle: 'Lo que MADRE no ha podido usar',
    qaTitle: 'Revisión de calidad',
    qaRound: (stage: string, round: number) => `${stage} · ronda ${round}`,
    auditTitle: (n: number) => `Registro de auditoría · ${n} ${n === 1 ? 'evento' : 'eventos'}`,
    step: {
      simulated: 'Simulado',
      real: 'Real',
      requestId: (id: string) => `id de la petición ${id}`,
      providerError: (code: string, stage: string) => `${code} · fase ${stage}`,
      attempts: (n: number) => `${n} intentos`,
      revised: (n: number) => `revisado ${n}×`,
      free: 'gratis',
      resultSummary: (cost: string | null, caveats: number) =>
        `Resultado${cost !== null ? ` · ${cost}` : ''}${
          caveats > 0 ? ` · ${caveats} ${caveats === 1 ? 'salvedad' : 'salvedades'}` : ''
        }`,
      finished: (when: string) => `finalizado ${when}`,
    },
  },

  approval: {
    needsInput: 'Requiere tu aportación',
    permission: 'Permiso',
    asked: (when: string) => `solicitado ${when}`,
    pasteLabel: 'Pega aquí el texto',
    pastePlaceholder: 'Documentos, cifras o notas a partir de los cuales debe trabajar el equipo…',
    sendToCrew: 'Enviar al equipo',
    continueWithout: 'Continuar sin ello',
    sendFailed: 'No se pudo enviar la decisión.',
  },

  /** Etiquetas para valores de enumeración o códigos que la API devuelve en bruto. */
  labels: {
    /** Nombre visible de un agente a partir de su id; si no se conoce, el id con espacios. */
    agentName: (id: string): string => {
      const names: Record<string, string> = {
        strategy: 'Estrategia',
        research: 'Investigación',
        engineering: 'Ingeniería',
        code: 'Código',
        design: 'Diseño',
        marketing: 'Marketing',
        finance: 'Finanzas',
        qa: 'QA',
        integrator: 'Integrador',
        content: 'Contenido',
        video: 'Vídeo',
        social: 'Redes sociales',
        sales: 'Ventas',
        data: 'Datos',
        legal: 'Legal',
        browser: 'Navegador',
        computer_use: 'Uso del ordenador',
        automation: 'Automatización',
        trading_research: 'Investigación de trading',
        visual_reverse: 'Ingeniería inversa visual',
        user: 'Usuario',
        madre: 'MADRE',
      };
      return names[id] ?? id.replace(/[_.]/g, ' ');
    },
    stepKind: (kind: string): string => {
      const names: Record<string, string> = {
        agent: 'Agente',
        qa: 'Revisión de QA',
        integrate: 'Integración',
        input: 'Aportación del usuario',
      };
      return names[kind] ?? kind.replace(/[_.]/g, ' ');
    },
    permissionLevel: (level: string | null): string => {
      const names: Record<string, string> = {
        READ: 'Lectura',
        WRITE: 'Escritura',
        EXECUTE: 'Ejecución',
        EXTERNAL_ACTION: 'Acción externa',
        FINANCIAL: 'Financiero',
        PUBLISH: 'Publicación',
        DELETE: 'Eliminación',
      };
      return level === null ? 'Permiso' : (names[level] ?? level.replace(/_/g, ' ').toLowerCase());
    },
    blockerKind: (kind: string): string => {
      const names: Record<string, string> = {
        approval: 'Aprobación',
        input: 'Datos necesarios',
        tool_missing: 'Falta una herramienta',
        provider_missing: 'Falta un proveedor',
        budget: 'Presupuesto',
        dependency: 'Dependencia',
        agent_planned: 'Agente previsto',
        error: 'Error',
      };
      return names[kind] ?? kind.replace(/[_.]/g, ' ');
    },
    severity: (severity: string): string => {
      const names: Record<string, string> = {
        info: 'Información',
        warning: 'Aviso',
        major: 'Importante',
        blocker: 'Bloqueo',
      };
      return names[severity] ?? severity;
    },
    qaStage: (stage: string): string => {
      const names: Record<string, string> = { workers: 'Trabajo de los especialistas', final: 'Informe final' };
      return names[stage] ?? stage;
    },
    intentKind: (kind: string): string => {
      const names: Record<string, string> = {
        launch_business: 'Lanzamiento de negocio',
        market_research: 'Estudio de mercado',
        validation_experiment: 'Experimento de validación',
        content_campaign: 'Campaña de contenido',
        document_analysis: 'Análisis de documentos',
        product_build: 'Desarrollo de producto',
        growth: 'Crecimiento',
        financial_model: 'Modelo financiero',
        general: 'General',
      };
      return names[kind] ?? kind.replace(/_/g, ' ');
    },
    complexity: (value: string): string => {
      const names: Record<string, string> = { simple: 'Simple', moderate: 'Moderada', complex: 'Compleja' };
      return names[value] ?? value;
    },
    auditActor: (actor: string): string => {
      const names: Record<string, string> = {
        madre: 'MADRE',
        compiler: 'Compilador',
        router: 'Enrutador',
        engine: 'Motor',
        judge: 'Juez',
        policy: 'Política',
        user: 'Usuario',
        tool: 'Herramienta',
        memory: 'Memoria',
        cost: 'Coste',
      };
      return names[actor] ?? actor;
    },
  },
};
