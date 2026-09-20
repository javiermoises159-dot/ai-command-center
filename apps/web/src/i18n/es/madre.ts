/** Etiquetas del motor MADRE compartidas por varias pantallas (estados, veredictos, fases…). */
export const madre = {
  /** Estado de un paso del plan. Las claves son códigos de la API. */
  stepStatus: {
    QUEUED: 'En cola',
    RUNNING: 'En curso',
    WAITING: 'Esperándote',
    BLOCKED: 'Bloqueado',
    FAILED: 'Fallido',
    RETRYING: 'Reintentando',
    DONE: 'Hecho',
    CANCELLED: 'Cancelado',
  },

  /** Veredicto de la revisión de calidad. */
  verdict: {
    PASS: 'Aprobado',
    PASS_WITH_WARNINGS: 'Aprobado con avisos',
    NEEDS_REVISION: 'Necesita revisión',
    BLOCKED: 'Bloqueado',
  },

  /** Fase de una ejecución del motor. */
  phase: {
    planning: 'Planificando',
    executing: 'Ejecutando',
    paused: 'Esperándote',
    reviewing: 'Revisando',
    completed: 'Completada',
    failed: 'Fallida',
    cancelled: 'Cancelada',
  },

  /** Estado de conexión de un proveedor de IA. */
  providerStatus: {
    CONNECTED: 'Conectado',
    LOCAL: 'Local',
    MOCK: 'Simulado',
    NOT_CONNECTED: 'No conectado',
    UNCONFIGURED: 'Sin configurar',
    DISABLED: 'Desactivado',
    ERROR: 'Error',
  },

  /** Estado de una herramienta del catálogo (concuerda con «herramienta»). */
  toolStatus: {
    AVAILABLE: 'Disponible',
    CONNECTED: 'Conectada',
    MOCK: 'Simulada',
    PLANNED: 'Planificada',
    NOT_CONNECTED: 'No conectada',
    DISABLED: 'Deshabilitada',
  },

  cost: {
    unknown: 'desconocido',
    noCalls: 'aún sin llamadas',
    /** Cota inferior: parte del gasto no tiene precio conocido. */
    atLeast: (amount: string, unpricedCalls: number) =>
      `≥ ${amount} · ${unpricedCalls} sin precio`,
  },

  confidence: {
    notAvailable: 'n/d',
  },
};
