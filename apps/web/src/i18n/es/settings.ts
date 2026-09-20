/** Textos de la sección «Configuración». */
export const settings = {
  title: 'Configuración',
  description:
    'Qué proveedores y modelos de IA puede usar el equipo, qué tiene permitido hacer, cuánto puede gastar y qué está realmente conectado.',
  sectionsAria: 'Secciones de configuración',
  tabs: {
    providers: 'Proveedores',
    models: 'Modelos',
    connections: 'Conexiones',
    permissions: 'Permisos',
    budget: 'Presupuesto',
    appearance: 'Apariencia',
    system: 'Estado del sistema',
  },
  fromServer: 'Leído del servidor',

  providers: {
    noticeBody:
      'Las claves de los proveedores se guardan solo en el entorno del servidor; esta aplicación nunca las ve. Un proveedor figura como «Conectado» únicamente cuando el servidor puede llamarlo de verdad. El proveedor simulado es una alternativa de desarrollo y siempre se etiqueta como tal.',
    sourceReal: 'Real',
    sourceSimulated: 'Simulado',
    modelCount: (n: number) => `${n} ${n === 1 ? 'modelo' : 'modelos'}`,
    toConnect: 'Para conectar: ',
    health: {
      /** Titles for the reachability check, which is a probe and not a guess. */
      check: 'Comprobar estado',
      checking: 'Comprobando…',
      failed: 'No se pudo comprobar el estado de los proveedores.',
      neverChecked: 'Sin comprobar',
      checkedAt: (when: string) => `Comprobado ${when}`,
      latency: (ms: number) => `${ms} ms`,
      status: {
        ok: 'Responde',
        degraded: 'Lento',
        down: 'No responde',
        not_connected: 'Nada que comprobar',
        unknown: 'Sin comprobar',
      } as Record<string, string>,
      hint: 'Comprobar el estado hace una llamada real a cada proveedor configurado. Nunca se marca como disponible por tener la configuración completa.',
    },
    privacy: {
      on_device: 'Se queda en tu equipo',
      simulated: 'No sale ningún dato',
      third_party: 'Terceros',
    } as Record<string, string>,
    /** Niveles de proveedor y de modelo. */
    tiers: {
      local: 'Local',
      local_strong: 'Local potente',
      external: 'Externo',
      specialized: 'Especializado',
      mock: 'Simulación',
    } as Record<string, string>,
  },

  models: {
    noticeTitle: 'Las valoraciones son editoriales; los precios, tuyos',
    noticeBody:
      'La calidad es una valoración aproximada de 1 a 5, no una prueba de rendimiento. MADRE nunca inventa un precio: un modelo externo sin precio configurado aparece como «desconocido», y un presupuesto lo rechaza en lugar de suponer que es barato.',
    empty: { title: 'No hay modelos', body: 'Ningún proveedor ha informado de ningún modelo todavía.' },
    quality: (n: number) => `calidad ${n}/5`,
    contextNa: 'contexto no disponible',
    context: (size: string) => `contexto de ${size}`,
    priceUnknown: 'precio desconocido',
    pricePer1k: (input: string, output: string) => `${input} / ${output} por 1k tokens`,
  },

  connections: {
    noticeTitle: 'Solo lectura en esta versión',
    noticeBody:
      'Las conexiones se configuran en el servidor mediante variables de entorno. Todavía no hay nada que conectar desde esta pantalla, y nada se muestra como conectado si el servidor no lo ha confirmado.',
    aiProviders: 'Proveedores de IA',
    tools: 'Herramientas',
    toolsSummary: (usable: number, mock: number, notConnected: number, total: number) =>
      `${usable} ${usable === 1 ? 'utilizable' : 'utilizables'} · ${mock} ${mock === 1 ? 'simulada' : 'simuladas'} · ${notConnected} sin conectar de ${total}`,
    openRegistry: 'Abrir el registro de herramientas',
  },

  permissions: {
    /** Nombre corto de cada nivel de permiso, tal como se lista en esta pantalla. */
    names: {
      READ: 'Leer',
      WRITE: 'Escribir',
      EXECUTE: 'Ejecutar código',
      EXTERNAL_ACTION: 'Actuar en servicios externos',
      PUBLISH: 'Publicar',
      DELETE: 'Eliminar',
      FINANCIAL: 'Mover dinero',
    },
    noticeBody:
      'Estos son los modos de permiso que aplica el motor. Se pueden endurecer en el servidor, pero nunca relajar más allá de un mínimo fijo: publicar, eliminar, actuar en servicios externos y mover dinero nunca pueden ejecutarse sin ti.',
    modes: {
      AUTO: 'Automático',
      ASK: 'Pregunta antes',
      BLOCK: 'Bloqueado',
    },
    levels: {
      READ: 'Lee la misión, los resultados de otros agentes y la memoria.',
      WRITE: 'Escribe en los almacenes propios de MADRE. Escribir en cualquier otro sitio siempre pregunta antes.',
      EXECUTE: 'No existe un entorno aislado de ejecución, así que permanece bloqueado.',
      EXTERNAL_ACTION: 'Nunca es automático: pregunta antes.',
      PUBLISH: 'Nunca es automático: pregunta antes, y no hay ningún canal conectado.',
      DELETE: 'Nunca es automático: pregunta antes.',
      FINANCIAL: 'Bloqueado. Todo lo que implique una cantidad de dinero se trata como financiero.',
    },
  },

  budget: {
    noticeTitle: 'Los límites solo se aplican a proveedores de pago',
    noticeBody:
      'Los proveedores locales y simulados no cuestan nada. Si hay un límite fijado y un modelo no tiene precio configurado, MADRE rechaza la llamada en lugar de suponerlo. Los cambios duran hasta que se reinicie el servidor; define las variables de entorno para conservarlos.',
    spentTitle: 'Gasto acumulado',
    calls: 'Llamadas',
    knownCost: 'Coste conocido',
    unpricedCalls: 'Llamadas sin precio',
    limitsTitle: 'Límites (USD; vacío = sin límite)',
    perMission: 'Por misión',
    perDay: 'Por día',
    perMonth: 'Por mes',
    atLimit: 'Al llegar al límite',
    onExceed: {
      block: 'Detener el paso',
      fallback_local: 'Usar un modelo local en su lugar',
      ask: 'Preguntarme',
    },
    invalid: 'Introduce una cantidad en dólares o deja el campo vacío para no fijar límite.',
    saveFailed: 'No se ha podido guardar el presupuesto.',
    saved: 'Guardado.',
    save: 'Guardar límites',
  },

  appearance: {
    themeAria: 'Tema',
    themes: {
      dark: { label: 'Oscuro', body: 'El aspecto de centro de operaciones.' },
      light: { label: 'Claro', body: 'Luminoso, para la luz del día.' },
      system: { label: 'Sistema', body: 'Sigue el ajuste de tu dispositivo.' },
    },
    resolved: { dark: 'oscuro', light: 'claro' } as Record<string, string>,
    current: (theme: string) => `Ahora se muestra el tema ${theme}. Tu elección se recuerda en este dispositivo.`,
  },

  system: {
    apiOnline: (ms: number) => `En línea · ${ms} ms`,
    apiChecking: 'Comprobando…',
    apiUnreachable: 'No disponible',
    unreachableBanner: (reason: string) => `No se puede conectar con la API: ${reason}`,
    rows: {
      api: 'API',
      version: 'Versión',
      defaultProvider: 'Proveedor predeterminado',
      serverTime: 'Hora del servidor',
      missionsStored: 'Misiones guardadas',
      running: 'En ejecución ahora',
      build: 'Compilación',
      browserOnline: 'Navegador con conexión',
    },
    none: 'ninguno',
    buildModes: { production: 'Producción', development: 'Desarrollo', test: 'Pruebas' } as Record<string, string>,
    yes: 'Sí',
    no: 'No',
    /** Nombres de proveedor predeterminado que el servidor puede devolver. */
    providerNames: { mock: 'Simulado', ollama: 'Ollama', openai: 'OpenAI', anthropic: 'Anthropic', gemini: 'Gemini' } as Record<string, string>,
  },
};
