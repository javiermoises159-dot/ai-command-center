/**
 * Task templates per kind of mission.
 *
 * A template says which capabilities a kind of mission needs, in what order,
 * and how tightly each depends on the ones before it. Descriptions are written
 * as instructions to an agent and are careful to ask for *labelled*
 * assumptions rather than invented facts.
 *
 * User-facing copy (titles, descriptions, deliverables, hypotheses, research
 * questions) is written in Spanish: the web app renders it verbatim. Phrasing
 * stays neutral around the mission subject, which is free text inserted by the
 * runner, so it reads well for "cookies" and for "una tienda online de cookies
 * en Italia" alike.
 */

import { VISUAL_CRAFT_GUIDE } from '@acc/domain';
import type { Capability, Deliverable, MissionKind } from '../types.ts';

export interface TaskTemplate {
  capability: Capability;
  title: string;
  description: string;
  /** Capabilities this task builds on. Resolved to task ids when present. */
  after?: Capability[];
  dependency?: 'hard' | 'soft';
  /** Only include when the mission text matches. */
  when?: RegExp;
}

const ONLINE = /\b(?:online|web|app|e-?commerce|tienda online|negozio online|website|sitio|plataforma|platform|software)\b/iu;

export const TEMPLATES: Record<MissionKind, TaskTemplate[]> = {
  launch_business: [
    {
      capability: 'strategy.positioning',
      title: 'Posicionar la oferta',
      description: 'Elige un único cliente objetivo y un ángulo para la oferta, y define qué significa tener éxito en cifras que el usuario pueda comprobar.',
    },
    {
      capability: 'research.market',
      title: 'Describir el mercado',
      description: 'Describe los motores de la demanda y las bandas de precio habituales del producto en el lugar indicado. Marca como supuesto toda cifra que no puedas respaldar con una fuente.',
    },
    {
      capability: 'research.competitors',
      title: 'Comparar competidores',
      description: 'Nombra los tipos de actores que ya atienden esta necesidad y cómo se posiciona cada uno. No afirmes ingresos ni cuotas de mercado que no puedas respaldar con una fuente.',
      after: ['research.market'],
    },
    {
      capability: 'research.regulatory',
      title: 'Listar las normas a comprobar',
      description: 'Enumera los requisitos regulatorios y operativos que debería comprobar antes de lanzar quien venda en este lugar. Es una lista para verificar con una autoridad o un profesional, no asesoramiento legal.',
    },
    {
      capability: 'finance.unit_economics',
      title: 'Modelar la economía',
      description: 'Construye un modelo sencillo de economía unitaria con cada dato de entrada etiquetado como supuesto salvo que lo haya aportado el usuario. Muestra las cuentas y la condición de equilibrio.',
      after: ['strategy.positioning', 'research.market'],
    },
    {
      capability: 'marketing.go_to_market',
      title: 'Planificar los primeros clientes',
      description: 'Elige dos canales de captación y una secuencia de lanzamiento, con una métrica de éxito ligada a la recurrencia o a los ingresos.',
      after: ['strategy.positioning', 'research.audience'],
    },
    {
      capability: 'design.brand',
      title: 'Definir la marca',
      description: 'Define la dirección del nombre, el tono y la identidad visual que encajan con el posicionamiento elegido.',
      after: ['strategy.positioning'],
    },
    {
      capability: 'engineering.architecture',
      title: 'Plantear la tienda online',
      description: 'Recomienda el montaje técnico más simple capaz de aceptar pedidos y pagos, con las fases necesarias para llegar hasta ahí.',
      after: ['strategy.positioning'],
      when: ONLINE,
    },
  ],

  market_research: [
    {
      capability: 'research.market',
      title: 'Describir el mercado',
      description: 'Describe el mercado, sus motores de demanda y lo que todavía se desconoce. Marca como supuesto toda cifra que no puedas respaldar con una fuente.',
    },
    {
      capability: 'research.competitors',
      title: 'Comparar competidores',
      description: 'Compara los tipos de actores de este mercado por enfoque y por audiencia, no por ingresos que no puedas respaldar con una fuente.',
    },
    {
      capability: 'research.audience',
      title: 'Describir al comprador',
      description: 'Describe quién compra, qué problema está resolviendo y cómo elige. Separa lo que se sabe de lo que se supone.',
    },
    {
      capability: 'strategy.assumptions',
      title: 'Listar qué validar',
      description: 'A partir de los hallazgos, enumera los supuestos sobre los que se apoya la decisión, ordénalos por riesgo y di cómo podría probarse cada uno de forma barata.',
      after: ['research.market', 'research.competitors', 'research.audience'],
    },
  ],

  validation_experiment: [
    {
      capability: 'strategy.assumptions',
      title: 'Nombrar los supuestos más arriesgados',
      description: 'Indica los supuestos que deben cumplirse para que la idea funcione, ordénalos por riesgo y elige cuál probar primero.',
    },
    {
      capability: 'research.audience',
      title: 'Describir con quién probar',
      description: 'Describe a las personas a las que debe llegar el experimento y dónde se las puede encontrar. No inventes cifras sobre ellas.',
    },
    {
      capability: 'marketing.messaging',
      title: 'Escribir el mensaje de prueba',
      description: 'Escribe el mensaje que el experimento pondrá delante de las personas y la única acción que cuenta como interés.',
      after: ['strategy.assumptions', 'research.audience'],
    },
    {
      capability: 'finance.experiment_cost',
      title: 'Calcular el coste del experimento',
      description: 'Calcula el coste del experimento con el presupuesto que haya dado el usuario, si lo hay. Indica qué resultado descartaría la idea y cuál justificaría seguir adelante.',
      after: ['strategy.assumptions'],
    },
    {
      capability: 'strategy.prioritization',
      title: 'Fijar la regla de decisión',
      description: 'Escribe la regla de decisión por adelantado: qué resultado significa continuar, cuál cambiar y cuál parar.',
      after: ['strategy.assumptions', 'finance.experiment_cost'],
    },
  ],

  content_campaign: [
    {
      capability: 'research.audience',
      title: 'Describir la audiencia',
      description: 'Describe la audiencia y a qué responde ya en los canales indicados. Marca las suposiciones como suposiciones.',
    },
    {
      capability: 'marketing.messaging',
      title: 'Escribir el mensaje principal',
      description: 'Escribe el mensaje principal y sus pruebas de respaldo usando solo hechos aportados por el usuario.',
      after: ['research.audience'],
    },
    {
      capability: 'marketing.campaign',
      title: 'Planificar la campaña',
      description: 'Planifica la campaña en los canales indicados: formatos, cadencia y una métrica de éxito. No inventes cifras de referencia.',
      after: ['marketing.messaging'],
    },
    {
      capability: 'design.visual_brief',
      title: 'Preparar el briefing visual',
      description: 'Prepara el briefing de las piezas visuales que necesita la campaña para que un diseñador o una herramienta de generación pueda producirlas.',
      after: ['marketing.messaging'],
    },
  ],

  document_analysis: [
    {
      capability: 'research.documents',
      title: 'Leer los documentos',
      description: 'Lee los documentos aportados y extrae lo que importa: decisiones, obligaciones, cifras, fechas y puntos abiertos. Cita el documento; no añadas hechos que no contenga.',
    },
    {
      capability: 'strategy.prioritization',
      title: 'Fijar las acciones prioritarias',
      description: 'A partir de lo extraído, decide qué acciones van primero y por qué. Indica qué falta para poder estar seguro.',
      after: ['research.documents'],
      dependency: 'hard',
    },
  ],

  product_build: [
    {
      capability: 'strategy.prioritization',
      title: 'Decidir qué construir primero',
      description: 'Elige la versión más pequeña que ponga a prueba la idea central y enumera lo que se deja fuera a propósito.',
    },
    {
      capability: 'design.ux',
      title: 'Definir la experiencia',
      description: 'Describe el recorrido del usuario y la pantalla más importante.',
      after: ['strategy.prioritization'],
    },
    {
      capability: 'engineering.architecture',
      title: 'Elegir la arquitectura',
      description: 'Recomienda el stack y la forma del sistema, con una línea de justificación por cada elección.',
      after: ['strategy.prioritization'],
    },
    {
      capability: 'engineering.build_plan',
      title: 'Plantear la construcción',
      description: 'Secuencia la construcción en fases y nombra el principal riesgo técnico junto con su mitigación.',
      after: ['engineering.architecture', 'design.ux'],
    },
    {
      capability: 'finance.budget',
      title: 'Estimar el coste',
      description: 'Estima cuánto cuesta construirlo y cuánto cuesta mantenerlo en marcha, etiquetando cada dato de entrada como supuesto.',
      after: ['engineering.build_plan'],
    },
  ],

  growth: [
    {
      capability: 'research.audience',
      title: 'Describir al comprador',
      description: 'Describe quién compra y cómo encuentra productos como este. Separa lo conocido de lo supuesto.',
    },
    {
      capability: 'marketing.go_to_market',
      title: 'Planificar la captación',
      description: 'Elige dos canales de captación y una secuencia, con una métrica ligada a clientes retenidos o a ingresos.',
      after: ['research.audience'],
    },
    {
      capability: 'marketing.campaign',
      title: 'Diseñar el bucle de crecimiento',
      description: 'Diseña un bucle (recomendación, afiliación o contenido) explicando cómo se recompensa a cada participante. Usa solo las cifras de recompensa aportadas por el usuario.',
      after: ['marketing.go_to_market'],
    },
    {
      capability: 'finance.unit_economics',
      title: 'Comprobar la economía',
      description: 'Comprueba que el coste de captación y las recompensas dejan margen. Etiqueta como supuesto cada dato de entrada salvo que lo haya aportado el usuario.',
      after: ['marketing.go_to_market'],
    },
  ],

  financial_model: [
    {
      capability: 'strategy.assumptions',
      title: 'Nombrar los supuestos',
      description: 'Enumera los datos de entrada que necesita el modelo y etiqueta cada uno como aportado por el usuario o como supuesto.',
    },
    {
      capability: 'finance.unit_economics',
      title: 'Modelar la economía unitaria',
      description: 'Construye la economía unitaria a partir de los datos de entrada listados. Muestra las cuentas y la condición de equilibrio.',
      after: ['strategy.assumptions'],
    },
    {
      capability: 'finance.budget',
      title: 'Estimar la base de costes',
      description: 'Estima la base de costes y la caja necesaria para llegar al punto de equilibrio.',
      after: ['finance.unit_economics'],
    },
  ],

  general: [
    {
      capability: 'strategy.assumptions',
      title: 'Definir qué debe cumplirse',
      description: 'Reformula el objetivo en una frase, enumera lo que tendría que ser cierto para que funcione e indica qué se desconoce.',
    },
    {
      capability: 'research.audience',
      title: 'Identificar a quién afecta',
      description: 'Identifica a quién beneficia o a quién afecta y qué necesita. Separa lo conocido de lo supuesto.',
    },
    {
      capability: 'strategy.prioritization',
      title: 'Elegir las primeras acciones',
      description: 'Elige las primeras acciones y lo que se deja fuera por ahora.',
      after: ['strategy.assumptions', 'research.audience'],
    },
  ],
};

/** Capabilities a kind of mission would ideally have, even where this build cannot supply them. */
export const IDEAL_EXTRAS: Partial<Record<MissionKind, Capability[]>> = {
  launch_business: ['research.web', 'legal.compliance'],
  market_research: ['research.web'],
  validation_experiment: ['research.web'],
  content_campaign: ['content.script', 'research.web'],
  growth: ['research.web'],
};

export const DELIVERABLES: Record<MissionKind, Deliverable> = {
  launch_business: {
    title: 'Informe de lanzamiento',
    format: 'markdown',
    sections: ['Resumen', 'Oferta y posicionamiento', 'Mercado y competencia', 'Normas a comprobar', 'Economía', 'Primeros clientes', 'Marca y tienda', 'Riesgos y preguntas abiertas', 'Próximas acciones'],
  },
  market_research: {
    title: 'Informe de mercado',
    format: 'markdown',
    sections: ['Resumen', 'Mercado', 'Actores comparables', 'Comprador', 'Validaciones prioritarias', 'Incógnitas', 'Próximas acciones'],
  },
  validation_experiment: {
    title: 'Experimento de validación',
    format: 'markdown',
    sections: ['Resumen', 'Supuesto a prueba', 'Con quién probar', 'La prueba', 'Coste', 'Regla de decisión', 'Próximas acciones'],
  },
  content_campaign: {
    title: 'Plan de campaña',
    format: 'markdown',
    sections: ['Resumen', 'Audiencia', 'Mensaje principal', 'Canales y cadencia', 'Briefing visual', 'Métrica de éxito', 'Riesgos y preguntas abiertas', 'Próximas acciones'],
  },
  document_analysis: {
    title: 'Análisis de documentos',
    format: 'markdown',
    sections: ['Resumen', 'Contenido de los documentos', 'Cifras y fechas', 'Puntos abiertos', 'Acciones prioritarias'],
  },
  product_build: {
    title: 'Informe de construcción',
    format: 'markdown',
    sections: ['Resumen', 'Primera versión', 'Experiencia', 'Arquitectura', 'Fases de construcción', 'Coste', 'Riesgos', 'Próximas acciones'],
  },
  growth: {
    title: 'Plan de crecimiento',
    format: 'markdown',
    sections: ['Resumen', 'Comprador', 'Captación', 'Bucle de crecimiento', 'Economía', 'Riesgos y preguntas abiertas', 'Próximas acciones'],
  },
  financial_model: {
    title: 'Modelo financiero',
    format: 'markdown',
    sections: ['Resumen', 'Datos de entrada y supuestos', 'Economía unitaria', 'Base de costes', 'Punto de equilibrio', 'Preguntas abiertas', 'Próximas acciones'],
  },
  general: {
    title: 'Informe de misión',
    format: 'markdown',
    sections: ['Resumen', 'Condiciones que deben cumplirse', 'Personas afectadas', 'Primeras acciones', 'Incógnitas', 'Próximas acciones'],
  },
};

/** What the finished mission should give the user, by kind. Presented as a hypothesis to confirm. */
export const DESIRED_OUTCOMES: Record<MissionKind, string> = {
  launch_business: 'Un informe de lanzamiento accionable: posicionamiento, visión del mercado, normas a comprobar, economía, primeros clientes y próximas acciones.',
  market_research: 'Un informe de mercado que separa lo que se sabe de lo que se supone y ordena qué validar primero.',
  validation_experiment: 'Un experimento pequeño con su coste, su mensaje y una regla de decisión fijada de antemano.',
  content_campaign: 'Un plan de campaña: audiencia, mensaje, canales, cadencia, briefing visual y una métrica de éxito.',
  document_analysis: 'El contenido clave de los documentos y una lista ordenada de acciones prioritarias.',
  product_build: 'Un informe de construcción: la primera versión, la arquitectura, las fases y el coste.',
  growth: 'Un plan de crecimiento con una vía de captación elegida, un bucle de recompensa y una comprobación de la economía.',
  financial_model: 'Un modelo financiero en el que cada dato de entrada está etiquetado como aportado o supuesto.',
  general: 'Un informe breve con las primeras acciones y lo que todavía se desconoce.',
};

export const HYPOTHESES: Record<MissionKind, string[]> = {
  launch_business: [
    'En el lugar elegido hay gente que quiere este producto lo suficiente como para pagar el precio que hace falta para tener margen.',
    'El producto se puede entregar a los clientes con un coste y un plazo que acepten.',
    'Se puede llegar a los primeros clientes por canales que cuesten menos que el margen que aportan.',
  ],
  market_research: [
    'El mercado es lo bastante grande y accesible como para que merezca la pena entrar.',
    'Los actores existentes dejan un hueco que el usuario puede ocupar.',
  ],
  validation_experiment: [
    'La idea resuelve un problema que la gente ya siente y por el que ya actuaría.',
    'Una prueba pequeña puede demostrar interés real sin llegar a construir el producto.',
  ],
  content_campaign: [
    'Se puede llegar a la audiencia en los canales elegidos con contenido orgánico.',
    'El mensaje es lo bastante claro como para entenderse en los primeros segundos.',
  ],
  document_analysis: ['Los documentos aportados están completos para la decisión que tienen que apoyar.'],
  product_build: [
    'La idea central se puede probar con una primera versión mucho más pequeña.',
    'La tecnología elegida puede ser operada por las personas que la van a mantener.',
  ],
  growth: [
    'Los clientes recomendarán o promocionarán si la recompensa es clara.',
    'El coste de captación se mantiene por debajo del margen por cliente.',
  ],
  financial_model: ['Los datos de entrada aportados están lo bastante actualizados y completos como para modelar.'],
  general: ['El objetivo declarado es lo que el usuario quiere conseguir de verdad.'],
};

export const RESEARCH_QUESTIONS: Partial<Record<MissionKind, string[]>> = {
  launch_business: [
    '¿Cuál es la demanda real en el lugar elegido y de dónde viene?',
    '¿Qué permisos, etiquetado o impuestos se aplican allí a este producto?',
    '¿Qué precios ponen los vendedores comparables y qué dicen de ellos sus clientes?',
  ],
  market_research: [
    '¿Qué datos actuales (tamaño, crecimiento, precios) hay disponibles en fuentes identificables?',
    '¿Qué actores están activos ahora mismo y qué ha cambiado recientemente?',
  ],
  validation_experiment: ['¿Dónde se puede llegar a las personas objetivo para la prueba con el presupuesto disponible?'],
  content_campaign: ['¿Qué funciona ahora mismo en los canales indicados para una marca de este tipo?'],
  growth: ['¿Qué canales de captación están abiertos para este producto y a qué coste real?'],
};

export { ONLINE };

/** A mission that asks for a logo or a visual identity. */
export const LOGO_REQUEST = /\b(?:logo(?:tipo)?s?|isotipo|imagotipo|identidad visual|brand identity|logotype|marchio)\b/iu;

/**
 * A mission that asks the crew to BUILD a page or a simple ordering app:
 * a creation verb near the thing built. "Investiga cómo hacer una web" does not match.
 */
export const SITE_REQUEST =
  /\b(?:cr[eé]a(?:me|d)?|cre(?:es|e|en)|haz(?:me)?|hagas|constru[yí]e(?:me)?|construyas|genera(?:me)?|generes|desarrolla(?:me)?|desarrolles|monta(?:me)?|programa(?:me)?|dise[ñn]a(?:me)?|dise[ñn]es|prepara(?:me)?|build|make|create|develop|crea|fammi|costruisci)\b[^.\n]{0,50}\b(?:p[aá]gina(?:\s+web)?|sitio(?:\s+web)?|web|landing|app|aplicaci[oó]n|website|web\s*app|men[uú]\s+digital|sito|pagina)\b/iu;

export const SITE_TASK: TaskTemplate = {
  capability: 'engineering.site',
  title: 'Construir la página web',
  description:
    'Construye la página o la app que pide el usuario como UN ÚNICO archivo HTML completo, en un solo bloque de código ```html que empiece por <!doctype html> y acabe en </html>. ' +
    'Reglas obligatorias: HTML, CSS y JavaScript dentro del mismo archivo; sin scripts, fuentes, imágenes ni hojas de estilo externas (usa fuentes del sistema y dibujos SVG hechos a mano; sin emojis como iconos); ' +
    'sin fetch, XMLHttpRequest, WebSocket, eval ni cookies; diseño pensado primero para móvil, con <meta name="viewport">, textos legibles y botones grandes; idioma de la página: el del público (italiano si es para Italia); ' +
    'con título <title> y una descripción. Si es una app de pedidos: una lista de productos con nombre, descripción corta y precio que el usuario pueda cambiar fácilmente en un array al principio del script; ' +
    'un carrito con + y −, el total, y campos de nombre, teléfono y notas; y un botón que abre WhatsApp con el pedido ya escrito (enlace https://wa.me/NUMERO?text=… con encodeURIComponent) y otro que copia el pedido. ' +
    'Pon el número de WhatsApp en una constante llamada WHATSAPP_NUMBER al principio del script; si el usuario no lo dio, déjala vacía y haz que el botón avise de que falta configurarla. ' +
    'Antes del bloque escribe dos líneas: qué hace la página y qué debe cambiar el usuario (nombre, precios, número de WhatsApp). Después del bloque, di con claridad qué NO hace (no hay servidor, ni pagos, ni base de datos: los pedidos llegan por WhatsApp).\n\n' + VISUAL_CRAFT_GUIDE,
  after: ['design.brand'],
};

export const BRAND_TASK: TaskTemplate = {
  capability: 'design.brand',
  title: 'Definir la marca',
  description: 'Define la dirección del nombre, el tono y la identidad visual que encajan con lo que pide el usuario.\n\n' + VISUAL_CRAFT_GUIDE,
};

export const LOGO_TASK: TaskTemplate = {
  capability: 'design.logo',
  title: 'Diseñar el logotipo',
  description:
    'Propón 3 opciones de logotipo distintas. Cada una lleva un nombre, una línea que explique la idea y el dibujo COMPLETO como un único bloque de código ```svg. ' +
    'Reglas del SVG: viewBox="0 0 512 512"; solo formas básicas, trazados (path), degradados y texto con fuentes genéricas (sans-serif o serif); ' +
    'colores en hexadecimal, máximo 4; sin scripts, sin imágenes ni fuentes externas y sin foreignObject; que se entienda también a 32 píxeles. ' +
    'Después de las tres opciones, di cuál recomiendas y por qué. Si el usuario no dio el nombre de la marca, propón uno y márcalo como propuesta.\n\n' + VISUAL_CRAFT_GUIDE,
  after: ['design.brand'],
};
