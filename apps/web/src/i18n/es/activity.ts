/** Textos de la sección «Actividad» y del registro de auditoría del motor. */
export const activity = {
  title: 'Actividad',
  description:
    'Todo lo que ha ocurrido: misiones y agentes a medida que se ejecutaban, y el registro propio del motor sobre lo que decidió, quién aprobó qué y cuánto costó cada paso.',
  sourceAria: 'Origen de la actividad',
  sources: {
    missions: 'Misiones y agentes',
    engine: 'Registro de auditoría del motor',
  },
  filterAria: 'Filtrar la actividad',
  groups: {
    all: 'Todo',
    runs: 'Misiones y ejecuciones',
    agents: 'Agentes',
    failures: 'Fallos',
  },
  live: 'En vivo',
  kinds: {
    mission_created: 'Misión creada',
    run_started: 'Ejecución iniciada',
    agent_started: 'Agente iniciado',
    agent_completed: 'Agente completado',
    agent_failed: 'Agente fallido',
    agent_skipped: 'Agente omitido',
    run_completed: 'Ejecución completada',
    run_failed: 'Ejecución fallida',
  },
  runNumber: (n: number) => `ejecución n.º ${n}`,
  empty: {
    title: 'Todavía no ha pasado nada',
    body: 'Cuando lances una misión, su creación, cada ejecución y el progreso de cada agente quedarán registrados aquí por orden.',
    action: 'Lanzar una misión',
  },
  noMatch: {
    failuresTitle: 'Sin fallos',
    otherTitle: 'Ninguna actividad coincide',
    failuresBody: 'Nada ha fallado en tus misiones recientes.',
    otherBody: 'Prueba con otro filtro para ver el resto de la cronología.',
  },
  showMore: (n: number) => `Ver ${n} más`,
  remaining: (n: number) => `(${n} ${n === 1 ? 'restante' : 'restantes'})`,

  engine: {
    empty: {
      title: 'Aún no hay eventos del motor',
      body: 'Cuando una misión se ejecute en modo MADRE, cada decisión, aprobación, reintento y veredicto de QA quedará registrado aquí.',
    },
    showMore: 'Ver más',
    /** Quién registró el evento. */
    actors: {
      user: 'Usuario',
      judge: 'Juez',
      policy: 'Política',
      engine: 'Motor',
      router: 'Enrutador',
      compiler: 'Compilador',
      memory: 'Memoria',
      cost: 'Coste',
      tool: 'Herramienta',
      madre: 'MADRE',
    } as Record<string, string>,
  },
};
