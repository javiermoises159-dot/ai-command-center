/** Textos de la sección «Creatividad» y del panel de flujos de producción. */
export const creative = {
  title: 'Creatividad',
  description:
    'La futura suite creativa: diseño, imágenes, vídeo y un lienzo compartido, todo a partir de lo que tus misiones ya han decidido.',
  notice: {
    title: 'Los editores aún no están disponibles',
    body: 'Nada de lo que aparece abajo puede crear ni editar un recurso hoy. «Flujos» muestra lo que necesitaría cada fase y si podría ejecutarse ahora, y «Proyectos recientes» enumera los briefs de diseño que tu agente de Diseño ya ha redactado.',
  },
  pipelines: { title: 'Flujos', badge: 'Estado en vivo' },
  create: {
    title: 'Crear',
    planned: 'Planificado',
    items: [
      { icon: 'pen', name: 'Nuevo diseño', body: 'Parte de una página en blanco o de un brief y maqueta una pantalla, un cartel o una hoja de marca.' },
      { icon: 'image', name: 'Imagen', body: 'Genera y edita imágenes a partir de una descripción.' },
      { icon: 'video', name: 'Vídeo', body: 'Convierte un brief en un clip corto y recórtalo.' },
      { icon: 'layout', name: 'Lienzo', body: 'Un tablero libre para organizar imágenes, texto y referencias en un mismo sitio.' },
    ] as readonly { icon: 'pen' | 'image' | 'video' | 'layout'; name: string; body: string }[],
  },
  templates: {
    title: 'Plantillas',
    badge: 'Vista previa',
    items: [
      { name: 'Anuncio de lanzamiento', kind: 'Publicación social' },
      { name: 'Ficha de producto', kind: 'Marketplace' },
      { name: 'Hoja de marca', kind: 'Identidad' },
      { name: 'Diapositiva de presentación', kind: 'Presentación' },
    ] as readonly { name: string; kind: string }[],
  },
  recent: {
    title: 'Proyectos recientes',
    badge: 'Datos en vivo',
    empty: {
      title: 'Aún no hay briefs de diseño',
      body: 'Cuando una misión se completa, el brief del agente de Diseño (recorrido del usuario, principios de interfaz y dirección visual) aparece aquí como punto de partida.',
    },
    briefMeta: (when: string) => `Brief de diseño · ${when}`,
  },
  pipeline: {
    contentTitle: 'Contenido: de la idea a la iteración',
    mediaTitle: 'Vídeo y medios, primero en local',
    asksFirst: 'Pregunta antes',
    /** Preparación de una fase del flujo. Las claves son códigos de la API. */
    status: {
      ready: 'Puede ejecutarse',
      partial: 'Solo brief',
      blocked: 'Bloqueado',
    },
  },
};
