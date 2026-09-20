/** Textos de la sección «Conocimiento» y del panel de memoria de MADRE. */
export const knowledge = {
  title: 'Conocimiento',
  description:
    'Donde vivirá el trabajo acumulado del equipo: colecciones de documentos, las fuentes que hay detrás y la búsqueda sobre todo ello.',
  notice: {
    title: 'La memoria es real; el resto se construye a partir de tus misiones',
    body: 'La memoria es el conocimiento almacenado por MADRE, con la fuente de cada entrada y el grado de confianza que merece. Los documentos y la búsqueda funcionan sobre los resultados que han producido tus misiones. La subida de archivos, las fuentes externas y la búsqueda semántica aún no están disponibles.',
  },
  sectionsAria: 'Secciones de conocimiento',
  tabs: {
    memory: 'Memoria',
    collections: 'Colecciones',
    documents: 'Documentos',
    sources: 'Fuentes',
    search: 'Búsqueda',
  },
  origin: {
    finalBrief: 'Brief final',
  },

  collections: {
    finalBriefs: 'Briefs finales',
    agentOutputs: 'Resultados de agentes',
    sources: 'Fuentes',
    briefsTitle: 'Briefs de misión',
    briefsBody: 'El resultado integrado de cada misión completada: plan, próximas acciones, riesgos y asuntos pendientes.',
    outputsTitle: 'Resultados de agentes',
    outputsBody:
      'El resultado individual de cada especialista en la última ejecución de cada misión. Abre una misión para leerlos en su flujo.',
    viewDocuments: 'Ver documentos',
    count: (n: number) => `${n} ${n === 1 ? 'elemento' : 'elementos'} · automático`,
    empty: {
      title: 'Tus colecciones están vacías',
      body: 'Las colecciones se llenan solas a medida que se completan las misiones. Lanza una desde el panel y su brief se archivará aquí.',
    },
  },

  documents: {
    empty: {
      title: 'Aún no hay documentos',
      body: 'Aparecerá un documento aquí cuando una misión termine y el Integrador redacte su brief final.',
    },
    meta: (origin: string, characters: string, when: string) => `${origin} · ${characters} caracteres · ${when}`,
  },

  sources: {
    empty: {
      title: 'No hay fuentes conectadas',
      body: 'Las fuentes son de donde procede el conocimiento. Todavía no se puede conectar ninguna, así que el equipo trabaja únicamente con la misión que escribes.',
    },
    notConnected: 'No conectada',
    planned: [
      { icon: 'file-text', name: 'Archivos subidos', body: 'PDF, documentos y notas que añades tú mismo.' },
      { icon: 'globe', name: 'Páginas web', body: 'Páginas descargadas y guardadas por el motor de Investigación.' },
      { icon: 'folder', name: 'Unidades en la nube', body: 'Carpetas de una cuenta de almacenamiento conectada.' },
      { icon: 'database', name: 'Bases de datos', body: 'Datos estructurados que el equipo puede consultar en modo solo lectura.' },
    ] as readonly { icon: 'file-text' | 'globe' | 'folder' | 'database'; name: string; body: string }[],
  },

  search: {
    placeholder: 'Busca en tus briefs y en los resultados de los agentes',
    aria: 'Buscar en el conocimiento',
    hint: (n: number) =>
      `Búsqueda de texto simple sobre ${n} ${n === 1 ? 'elemento almacenado' : 'elementos almacenados'}. La búsqueda semántica llegará con el índice de conocimiento.`,
    prompt: {
      title: 'Busca en tu conocimiento',
      nothing: 'Todavía no hay nada que buscar. Completa una misión primero.',
      minChars: (n: number) => `Escribe al menos ${n} caracteres para buscar en el texto de tus briefs finales y en el resultado de cada agente.`,
    },
    noResults: {
      title: 'Sin resultados',
      body: (query: string) => `Ningún texto almacenado contiene «${query}».`,
    },
  },

  memory: {
    stats: { entries: 'Entradas', verified: 'Verificadas', lessons: 'Lecciones' },
    searchPlaceholder: 'Buscar en la memoria',
    searchAria: 'Buscar en la memoria',
    empty: {
      titleEmpty: 'Aún no hay nada guardado en la memoria',
      titleSearch: 'Ninguna entrada coincide',
      bodyEmpty: 'Cuando una misión termina, MADRE guarda un resumen y las lecciones aprendidas. Lo que añadas arriba también se conserva.',
      bodySearch: (q: string) => `Nada en la memoria coincide con «${q}».`,
    },
    add: {
      open: 'Añadir a la memoria',
      title: 'Título',
      content: '¿Qué debe recordar MADRE?',
      kind: 'Tipo',
      source: 'Fuente (opcional)',
      sourcePlaceholder: 'Nombre del documento o enlace',
      save: 'Guardar',
      close: 'Cerrar',
      saved: 'Guardado.',
      saveFailed: 'No se ha podido guardar.',
    },
    entry: {
      verified: 'Verificada',
      unverified: 'Sin verificar',
      from: (origin: string, ref: string | null) => `de ${origin}${ref !== null ? ` · ${ref}` : ''}`,
      confidence: (percent: number) => `confianza ${percent}%`,
      expires: (when: string) => `caduca ${when}`,
      forget: 'Olvidar esto',
      forgetting: 'Olvidando…',
      forgetFailed: 'No se ha podido olvidar la entrada.',
    },
    /** Tipos de entrada de memoria. */
    types: {
      user_context: 'Contexto del usuario',
      project_context: 'Contexto del proyecto',
      mission_history: 'Historial de misión',
      fact: 'Hecho',
      decision: 'Decisión',
      preference: 'Preferencia',
      result: 'Resultado',
      lesson: 'Lección',
      external_source: 'Fuente externa',
      temporary: 'Temporal',
    } as Record<string, string>,
    /** Origen de una entrada de memoria. */
    origins: {
      user: 'ti',
      agent: 'un agente',
      system: 'el sistema',
      tool: 'una herramienta',
      qa: 'QA',
    } as Record<string, string>,
  },
};
