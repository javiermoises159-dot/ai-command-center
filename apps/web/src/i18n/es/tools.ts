/** Textos de la sección «Herramientas». Incluye el vocabulario de enumeraciones compartido (permisos, riesgo). */
export const tools = {
  title: 'Herramientas',
  description:
    'El registro de herramientas: lo que los agentes pueden usar de verdad, lo que está simulado y lo que solo está planificado. Cada tarjeta indica cuál es el caso y qué haría falta para conectarla.',
  notice: {
    title: 'Leído del servidor',
    body: (usable: number, total: number) =>
      `${usable} de ${total} ${total === 1 ? 'herramienta puede' : 'herramientas pueden'} ejecutarse hoy. El resto está planificado o sin conectar: a los agentes nunca se les da una herramienta que no existe, y un paso que la necesita lo dice en lugar de fingir.`,
  },
  filters: {
    categoryAria: 'Filtrar herramientas por categoría',
    statusAria: 'Filtrar herramientas por estado',
    all: 'Todas',
    anyStatus: 'Cualquier estado',
  },
  empty: {
    title: 'Ninguna herramienta coincide',
    body: 'Ninguna herramienta tiene esta combinación de categoría y estado. Prueba a ampliar uno de los filtros.',
  },
  card: {
    costUnknown: 'coste desconocido',
    toConnect: 'Para conectar: ',
    setOnServer: (vars: string) => `configura ${vars} en el servidor`,
  },

  category: {
    research: 'Investigación',
    creation: 'Creación',
    development: 'Desarrollo',
    files: 'Archivos',
    communication: 'Comunicación',
    automation: 'Automatización',
    media: 'Medios',
    analytics: 'Analítica',
    distribution: 'Distribución',
    computer_use: 'Uso del ordenador',
    system: 'Sistema',
  } as Record<string, string>,
  locality: {
    local: 'Local',
    remote: 'Remota',
    hybrid: 'Híbrida',
  } as Record<string, string>,
  costModel: {
    free: 'gratis',
    per_call: 'por llamada',
    per_token: 'por token',
    subscription: 'suscripción',
    unknown: 'coste desconocido',
  } as Record<string, string>,
  authKind: {
    none: 'no requiere credenciales',
    api_key: 'clave de API',
    oauth: 'autorización OAuth',
    local_service: 'servicio local',
    account: 'cuenta',
  } as Record<string, string>,
  /** Niveles de permiso: etiquetas cortas para insignias. */
  permission: {
    READ: 'Leer',
    WRITE: 'Escribir',
    EXECUTE: 'Ejecutar código',
    EXTERNAL_ACTION: 'Acción externa',
    PUBLISH: 'Publicar',
    DELETE: 'Eliminar',
    FINANCIAL: 'Financiero',
  } as Record<string, string>,
  risk: (level: string) => {
    const names: Record<string, string> = { low: 'bajo', medium: 'medio', high: 'alto', critical: 'crítico' };
    return `Riesgo ${names[level] ?? level}`;
  },
};
