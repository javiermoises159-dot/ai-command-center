/** Textos de la sección «Investigación». */
export const research = {
  title: 'Investigación',
  description: 'Lo que el agente de Investigación ha encontrado para tus misiones y hasta qué punto se puede confiar en cada hallazgo.',
  notice: {
    connectedTitle: 'La búsqueda web está conectada',
    disconnectedTitle: 'La búsqueda web no está conectada',
    connectedBody: 'El agente de Investigación puede apoyar sus hallazgos en fuentes en vivo, y las citas se comprueban contra ellas.',
    disconnectedBody:
      'El agente de Investigación trabaja con su propio conocimiento, sin fuentes en vivo. Trata cada hallazgo como una pista que hay que verificar, sobre todo cifras, precios, leyes y fechas.',
  },
  empty: {
    title: 'Aún no hay investigación',
    body: 'Cuando una misión complete su paso de investigación, los hallazgos del agente de Investigación aparecerán aquí.',
  },
  missionsAria: 'Misiones con investigación',
  fromMissions: 'De tus misiones',
  findingAria: 'Hallazgo',
  badges: {
    live: 'Fuentes en vivo',
    unverified: 'Sin verificar',
    simulated: 'Simulado',
  },
  openMission: 'Abrir la misión',
  labelsTitle: 'Cómo se etiquetan los hallazgos',
  labels: [
    { label: 'Hecho', body: 'Lo afirma una fuente concreta que se puede comprobar.' },
    { label: 'Suposición', body: 'Se da por cierto para avanzar; no está demostrado.' },
    { label: 'Análisis', body: 'Razonado a partir de hechos, que se nombran.' },
    { label: 'Opinión', body: 'Un juicio, atribuido a quien lo sostiene.' },
    { label: 'Desconocido', body: 'Se preguntó y no se obtuvo respuesta.' },
  ] as readonly { label: string; body: string }[],
};
