/** Navegación, cabecera, barra inferior, temas y página 404. */
export const layout = {
  brand: {
    /** Nombre del producto: no se traduce. */
    name: 'AI Command Center',
    short: 'Command Center',
    tagline: 'Centro de mando',
  },

  nav: {
    primaryAria: 'Navegación principal',
    sectionsAria: 'Secciones',
    more: 'Más',
    moreTitle: 'Más secciones',
    moreDialogAria: 'Más secciones',
    closeMenu: 'Cerrar el menú',
    /** Etiqueta y descripción corta de cada sección, en el orden del menú. */
    items: {
      dashboard: { label: 'Panel', blurb: 'Lanza una misión y observa el sistema' },
      missions: { label: 'Misiones', blurb: 'Todas las misiones y sus ejecuciones' },
      agents: { label: 'Agentes', blurb: 'El equipo de ocho agentes' },
      knowledge: { label: 'Conocimiento', blurb: 'Colecciones, documentos y fuentes' },
      research: { label: 'Investigación', blurb: 'El futuro motor de investigación' },
      tools: { label: 'Herramientas', blurb: 'Catálogo de herramientas y estado de conexión' },
      creative: { label: 'Creatividad', blurb: 'La futura suite creativa' },
      activity: { label: 'Actividad', blurb: 'Cronología de todo lo que ha ocurrido' },
      settings: { label: 'Configuración', blurb: 'Proveedores, modelos y apariencia' },
    },
  },

  theme: {
    light: 'Tema claro',
    dark: 'Tema oscuro',
    system: 'Sistema',
    switchToLight: 'Cambiar al tema claro',
    switchToDark: 'Cambiar al tema oscuro',
  },

  /** Indicador de estado de la API en la barra lateral y en la cabecera móvil. */
  system: {
    checking: 'Comprobando…',
    online: 'API en línea',
    offline: 'Sin conexión con la API',
    offlineHint: '¿Está el servidor en marcha?',
    noProvider: 'sin proveedor',
    statusAria: (status: string) => `Estado del sistema: ${status}`,
    statusOpenSettingsAria: (status: string) => `Estado del sistema: ${status}. Abrir la configuración`,
  },

  /** Etiquetas cortas de estado usadas en los distintivos compartidos. */
  status: {
    pending: 'En cola',
    running: 'En curso',
    completed: 'Hecho',
    failed: 'Fallo',
    skipped: 'Omitido',
  },

  notFound: {
    title: 'Aquí no hay nada',
    body: (path: string) => `Ninguna pantalla coincide con ${path}.`,
    action: 'Volver al panel',
  },
};
