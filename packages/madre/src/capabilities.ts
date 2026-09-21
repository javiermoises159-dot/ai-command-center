/**
 * Capability vocabulary.
 *
 * A capability is something a mission needs done ("research the market"). Agents
 * declare which capabilities they cover; tools declare which they provide. The
 * compiler asks for capabilities and the registries answer with who can do them
 * — or report a gap when nobody active can.
 */

import type { Capability } from './types.ts';

export const CAPABILITIES = {
  // Strategy
  'strategy.positioning': 'Posicionar la oferta y elegir el segmento objetivo.',
  'strategy.prioritization': 'Decidir qué hacer primero y qué dejar fuera.',
  'strategy.assumptions': 'Sacar a la luz los supuestos en los que se apoya un plan y ordenarlos por riesgo.',
  // Research
  'research.market': 'Describir el mercado, sus motores de tamaño y sus señales de demanda.',
  'research.competitors': 'Comparar a los actores equivalentes y sus enfoques.',
  'research.regulatory': 'Enumerar las restricciones regulatorias y operativas que hay que comprobar.',
  'research.audience': 'Describir a la audiencia, su problema y cómo compra.',
  'research.documents': 'Leer los documentos aportados y extraer lo que importa.',
  'research.web': 'Buscar y leer fuentes web en vivo.',
  // Finance
  'finance.unit_economics': 'Modelar la economía unitaria con los supuestos declarados.',
  'finance.budget': 'Estimar una base de costes y la caja necesaria.',
  'finance.experiment_cost': 'Calcular el coste de un experimento de validación pequeño.',
  // Marketing
  'marketing.go_to_market': 'Planificar cómo se llega a los primeros clientes.',
  'marketing.campaign': 'Diseñar una campaña alrededor de un mensaje y unos pocos canales.',
  'marketing.messaging': 'Escribir el mensaje principal y sus pruebas de respaldo.',
  // Engineering
  'engineering.architecture': 'Elegir la forma técnica de la construcción.',
  'engineering.build_plan': 'Secuenciar la construcción en fases.',
  'engineering.site': 'Construir una página web de un solo archivo (HTML, CSS y JS), lista para publicar.',
  // Design
  'design.ux': 'Definir el recorrido del usuario y los principios de interfaz.',
  'design.brand': 'Fijar la identidad visual y el tono.',
  'design.logo': 'Dibujar opciones de logotipo como imágenes SVG.',
  'design.visual_brief': 'Preparar el briefing de las piezas visuales que necesita una campaña o un producto.',
  // Quality and integration
  'qa.review': 'Auditar los resultados en busca de huecos, contradicciones y afirmaciones sin verificar.',
  'integration.brief': 'Integrar todo en un único informe accionable.',
  // Capabilities that need agents or tools this build does not have
  'legal.compliance': 'Comprobar el cumplimiento legal y de las políticas de las plataformas.',
  'content.script': 'Escribir guiones y textos con calidad de producción.',
  'content.video': 'Producir vídeo.',
  'content.voice': 'Producir locución.',
  'content.publish': 'Publicar en plataformas externas.',
  'content.analytics': 'Leer las analíticas de rendimiento de las plataformas.',
  'sales.outreach': 'Llevar conversaciones de venta saliente.',
  'data.analysis': 'Analizar datos estructurados.',
  'browser.automation': 'Operar un sitio web a través de un navegador.',
  'computer.use': 'Operar una aplicación de escritorio.',
  'automation.workflows': 'Ejecutar flujos de trabajo programados o por disparador.',
  'trading.research': 'Investigar y simular estrategias de trading (solo simulación).',
  'visual.reverse_engineering': 'Reconstruir una interfaz a partir de capturas de pantalla o vídeo.',
} as const satisfies Record<string, string>;

export type KnownCapability = keyof typeof CAPABILITIES;

export function isKnownCapability(value: Capability): value is KnownCapability {
  return Object.hasOwn(CAPABILITIES, value);
}

export function describeCapability(capability: Capability): string {
  return isKnownCapability(capability) ? CAPABILITIES[capability] : capability;
}
