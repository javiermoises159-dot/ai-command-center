/** Textos del Panel: cabecera, estadísticas, misiones recientes, estado del sistema y centro de mando. */
export const dashboard = {
  heading: '¿Qué quieres conseguir hoy?',
  stats: {
    ariaLabel: 'Estadísticas de misiones',
    missions: 'Misiones',
    active: 'Activas',
    completed: 'Completadas',
    failed: 'Fallidas',
  },
  recent: {
    title: 'Misiones recientes',
    viewAll: 'Ver todas →',
    emptyTitle: 'Aún no hay misiones',
    emptyBody:
      'Escribe una misión arriba y pulsa «Ejecutar misión». El equipo la dividirá en tareas y verás aquí cómo informa cada agente.',
  },
  agents: {
    title: 'Agentes disponibles',
    details: 'Detalles →',
    loading: 'Cargando agentes',
    ready: 'Listo',
  },
  system: {
    title: 'Estado del sistema',
    checking: 'Comprobando el estado del sistema',
    unreachable: 'API no disponible',
    unreachableHint: '¿Está el servidor en marcha?',
    api: 'API',
    online: (latencyMs: number) => `En línea · ${latencyMs} ms`,
    version: 'Versión',
    provider: 'Proveedor',
    activeMissions: 'Misiones activas',
    checked: 'Comprobado',
    /** Nombre visible de un proveedor a partir de su id técnico. */
    providerName: (id: string | null): string => {
      if (id === null) return 'Ninguno';
      const names: Record<string, string> = { mock: 'Simulado' };
      return names[id] ?? id;
    },
    simulatedNote:
      'Se está usando el proveedor simulado. El resultado tiene la estructura de uno real, pero no contiene ningún análisis.',
  },
  commandCenter: {
    title: 'Centro de mando de misiones',
    empty:
      'Aún no hay misiones. Escribe una arriba: MADRE la convierte en un plan, asigna un modelo a cada paso, ejecuta los pasos, los somete a revisión de QA y ensambla el resultado.',
    loadingState: 'Cargando el estado de la misión',
    currentMission: 'Misión actual',
    latestMission: 'Última misión',
    classic: 'Clásica',
    classicNote:
      'Esta misión se ejecutó con la canalización clásica, por lo que no tiene plan de MADRE. Las misiones nuevas usan MADRE por defecto.',
    stepsDone: (done: number, total: number) => `${done} de ${total} ${total === 1 ? 'paso hecho' : 'pasos hechos'}`,
    workingNow: 'Trabajando ahora',
    confidence: 'Confianza',
    qa: 'QA',
    qaPending: 'aún no',
    cost: 'Coste',
    models: 'Modelos',
    toolsInUse: 'Herramientas en uso: ',
    blockers: 'Bloqueos',
    nextAction: 'Siguiente acción',
    live: 'En directo',
    worldSummary: (agents: number, tools: number) =>
      `${agents} ${agents === 1 ? 'agente' : 'agentes'} · ${tools} ${tools === 1 ? 'herramienta utilizable' : 'herramientas utilizables'}`,
    limitsSummary: 'Qué puede y qué no puede hacer MADRE hoy',
    canDo: 'Disponible ahora',
    cannotDo: 'No disponible',
  },
};
