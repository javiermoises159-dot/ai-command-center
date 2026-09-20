/**
 * Content generation for the MockProvider.
 *
 * This produces structured, agent-specific markdown derived from the actual
 * mission text, so the full pipeline (including the Integrator merging real
 * upstream content) can be exercised without any vendor API.
 *
 * The generated text is in Spanish because it is shown to the user as-is.
 *
 * It is a SIMULATION and says so in its own output. It performs no reasoning
 * and its content carries no analytical value — it exists to prove the
 * orchestration machinery, not to advise anyone.
 */

import type { AgentId } from '@acc/domain';
import { createRng, hashString, pick, randomInt } from './rng.ts';

/** Banner prepended to every simulated result so it can never be mistaken. */
export const SIMULATION_NOTICE =
  '> **Resultado simulado — MockProvider.** Generado localmente, sin ningún modelo de IA. ' +
  'La estructura es real, el contenido es de ejemplo. Conecta un proveedor real para obtener un análisis de verdad.';

// ---------------------------------------------------------------------------
// Topic extraction
// ---------------------------------------------------------------------------

/** Phrases that introduce a wish or an intention ("Quiero…", "I want to…"). */
const INTENT_PREFIX =
  /^(?:por favor|please|quiero|queremos|necesito|necesitamos|quisiera|quisiéramos|me gustaría|nos gustaría|voy a|vamos a|debo|debemos|busco|buscamos|planeo|planeamos|pretendo|pretendemos|ayúdame a|ayudame a|ayúdanos a|hay que|i want to|we want to|i need to|we need to|i would like to|we would like to|i'd like to|i want|we want|i need|we need|help me|let's|lets)(?=[\s,]|$)[\s,]*/i;

/** Verbs that describe the act of starting something ("Lanzar…", "Launch…"). */
const ACTION_VERB =
  /^(?:poner en marcha|puesta en marcha de|set up|lanzar|lanzo|lanzamos|crear|creo|creamos|abrir|abro|abrimos|montar|monto|montamos|construir|construyo|construimos|desarrollar|desarrollo|diseñar|diseño|preparar|preparo|iniciar|inicio|empezar|empiezo|comenzar|comienzo|arrancar|arranco|fundar|fundo|organizar|organizo|planificar|planifico|hacer|hago|launch|launching|build|building|create|creating|open|opening|start|starting|make|making|develop|developing|design|designing|plan|planning|organize|organise|found|setup)(?=[\s,]|$)[\s,]*/i;

/** Leading determiners, dropped so the topic reads as a bare noun phrase. */
const LEADING_ARTICLE = /^(?:un|una|unos|unas|el|la|los|las|mi|mis|nuestro|nuestra|nuestros|nuestras|a|an|the|my|our|some)(?=\s)\s+/i;

/** Small words that must not end a topic once it has been cut to length. */
const TRAILING_STOP = new Set([
  'de', 'del', 'en', 'y', 'e', 'o', 'u', 'para', 'por', 'con', 'sin', 'a', 'al', 'la', 'el', 'los', 'las', 'un', 'una',
  'que', 'the', 'a', 'an', 'and', 'or', 'of', 'in', 'on', 'at', 'for', 'to', 'with', 'by',
]);

const TOPIC_MAX_WORDS = 9;
const TOPIC_FALLBACK = 'la misión indicada';

/** Remove the `[fail:agente]` / `[slow:ms]` control directives. */
function stripDirectives(prompt: string): string {
  return prompt.replace(/\[[a-z]+:[^\]]*\]/gi, ' ');
}

/** Peel intent phrases, verbs and articles off the front until nothing more matches. */
function stripLeadIn(sentence: string): string {
  let text = sentence.trim();
  for (let i = 0; i < 6; i += 1) {
    const next = text.replace(INTENT_PREFIX, '').replace(ACTION_VERB, '').replace(LEADING_ARTICLE, '').trim();
    if (next === text) break;
    text = next;
  }
  return text;
}

/**
 * The subject of a mission as a bare noun phrase, e.g. «Quiero lanzar una tienda
 * online de cookies en Italia» -> «tienda online de cookies en Italia» and
 * «Launch an online cookie store in Italy» -> «online cookie store in Italy».
 *
 * It is always used as a label ("Tema: …", between «»), never inside a sentence
 * that needs gender or number agreement.
 */
export function extractTopic(prompt: string): string {
  const cleaned = stripDirectives(prompt).replace(/\s+/g, ' ').trim();

  for (const sentence of cleaned.split(/(?<=[.!?…])\s+|\n+/)) {
    // A comma, colon, dash or bracket starts an aside: the topic is what precedes it.
    const clause = (stripLeadIn(sentence.replace(/[.!?…]+$/, '')).split(/\s*[,;:()—–]\s*|\s+-\s+/)[0] ?? '').trim();
    const words = clause.split(' ').filter((w) => w.length > 0).slice(0, TOPIC_MAX_WORDS);
    while (words.length > 0 && TRAILING_STOP.has((words[words.length - 1] as string).toLowerCase())) words.pop();
    const topic = words.join(' ');
    if (topic.length >= 3) return topic;
  }
  return TOPIC_FALLBACK;
}

/** One-line echo of the mission so each agent's output is visibly on-topic. */
function missionLine(prompt: string): string {
  const cleaned = stripDirectives(prompt).replace(/\s+/g, ' ').trim();
  return cleaned.length > 220 ? `${cleaned.slice(0, 217)}...` : cleaned;
}

export interface GenerateOptions {
  agentId: AgentId;
  agentName: string;
  missionPrompt: string;
  /** Results of the agents that already ran, in pipeline order. */
  upstream: readonly { agentId: AgentId; name: string; result: string }[];
  /** Agents that failed before this one, so QA and the Integrator can name them. */
  failed: readonly { agentId: AgentId; name: string; error: string }[];
}

export function generate(options: GenerateOptions): string {
  const { agentId, missionPrompt } = options;
  const rng = createRng(hashString(`${agentId}:${missionPrompt}`));
  const topic = extractTopic(missionPrompt);

  switch (agentId) {
    case 'strategy':
      return strategy(options, rng, topic);
    case 'research':
      return research(options, rng, topic);
    case 'code':
      return engineering(options, rng, topic);
    case 'design':
      return design(options, rng, topic);
    case 'marketing':
      return marketing(options, rng, topic);
    case 'finance':
      return finance(options, rng, topic);
    case 'qa':
      return qa(options, rng);
    case 'integrator':
      return integrator(options, rng, topic);
  }
}

// ---------------------------------------------------------------------------
// Worker agents
// ---------------------------------------------------------------------------

function strategy(o: GenerateOptions, rng: () => number, topic: string): string {
  const wedge = pick(rng, [
    'dominar primero el segmento más estrecho y ampliar desde ahí',
    'competir por rapidez de entrega y no por amplitud de oferta',
    'ganar por confianza y trazabilidad, no por precio',
    'ofrecer una capa de servicio que los grandes no van a atender',
  ]);
  return [
    SIMULATION_NOTICE,
    '',
    '## Planteamiento de la misión',
    `Misión analizada: _${missionLine(o.missionPrompt)}_`,
    '',
    `**Tema:** ${topic}`,
    '',
    `El centro de gravedad está en **${topic}**. Tratarlo como una apuesta amplia dispersaría demasiado el esfuerzo, así que la postura recomendada es ${wedge}.`,
    '',
    '## Segmento objetivo',
    `- **Principal:** el grupo más acotado para el que «${topic}» es un problema urgente y no un simple extra.`,
    '- **Secundario:** compradores cercanos a los que se llega por el mismo canal una vez atendido el segmento principal.',
    '- **Fuera de alcance por ahora:** todos los demás. Ampliar el alcance sin control es el principal modo de fallo en esta etapa.',
    '',
    '## Cuña estratégica',
    `${capitalise(wedge)}. Es defendible porque exige un compromiso operativo que un competidor mayor difícilmente copiará con rapidez.`,
    '',
    '## Criterios de éxito',
    `1. Atender de principio a fin a los primeros ${randomInt(rng, 10, 40)} usuarios o clientes reales en un máximo de ${randomInt(rng, 6, 14)} semanas.`,
    `2. Tasa de repetición o retención superior al ${randomInt(rng, 25, 45)} % al cierre del primer trimestre de actividad.`,
    '3. Un método de captación validado y repetible: un canal que genere demanda de forma fiable.',
    '',
    '## Riesgo estratégico principal',
    `La demanda en torno a «${topic}» puede ser menos profunda de lo supuesto. Mitigación: validar con un piloto de pago antes de asumir costes fijos.`,
  ].join('\n');
}

function research(o: GenerateOptions, rng: () => number, topic: string): string {
  const constraint = pick(rng, [
    'requisitos de licencias y registro en el mercado objetivo',
    'plazos de suministro del insumo crítico',
    'límites de las políticas de la plataforma del canal principal de distribución',
    'obligaciones de protección de datos sobre los registros de clientes',
  ]);
  return [
    SIMULATION_NOTICE,
    '',
    '## Contexto de mercado',
    `**Tema:** ${topic}`,
    '',
    `El mercado en torno a **${topic}** se entiende mejor como un conjunto de actores consolidados que atienden una demanda amplia, con poca cobertura en el extremo concreto donde se sitúa esta misión.`,
    '',
    '## Actores comparables',
    '| Actor | Enfoque | Punto débil |',
    '| --- | --- | --- |',
    '| Consolidado A | Oferta amplia y marca fuerte | Servicio lento e impersonal |',
    '| Aspirante B | Liderazgo en precio | Márgenes ajustados y sin diferenciación |',
    '| Especialista C | Especialización profunda | Alcance limitado y capacidad acotada |',
    '',
    '## Restricciones a tener en cuenta',
    `- **Regulatorias / operativas:** ${constraint}.`,
    '- **Capacidad:** el modelo debe funcionar a pequeña escala antes de hacerlo a gran escala.',
    `- **Canal:** la distribución de «${topic}» se concentra en pocos lugares, lo que aumenta el riesgo de depender de una plataforma.`,
    '',
    '## Supuestos (sin verificar)',
    '- El volumen de demanda se infiere por razonamiento de categoría, **no** se ha medido.',
    '- Los puntos débiles de los competidores son hipótesis basadas en su posicionamiento, no en entrevistas con clientes.',
    '',
    '## Preguntas abiertas que requieren investigación primaria',
    '1. ¿Cuánto pagan hoy realmente los 20 primeros clientes objetivo y a quién?',
    '2. ¿Cuál de las restricciones anteriores se activa primero con un volumen realista?',
    '3. ¿Es estable la hipótesis sobre el canal o es un único punto de fallo?',
  ].join('\n');
}

function engineering(o: GenerateOptions, rng: () => number, topic: string): string {
  const store = pick(rng, ['PostgreSQL', 'PostgreSQL con réplica de lectura', 'PostgreSQL más almacenamiento de objetos']);
  return [
    SIMULATION_NOTICE,
    '',
    '## Stack recomendado',
    `**Tema:** ${topic}`,
    '',
    '- **Entorno de ejecución:** TypeScript de extremo a extremo; un solo lenguaje en toda la construcción mantiene ágil a un equipo pequeño.',
    `- **Datos:** ${store}; la integridad relacional importa más que una escala exótica en esta etapa.`,
    '- **Despliegue:** un único servicio desplegable más un frontend estático. Los microservicios serían prematuros.',
    '',
    '## Forma del sistema',
    '```',
    'cliente → pasarela de API → servicio de aplicación → almacén de datos',
    '                                   ↓',
    '                          proceso en segundo plano',
    '```',
    `La ruta de escritura se mantiene síncrona y simple; todo lo lento relacionado con «${topic}» pasa al proceso en segundo plano para que las peticiones nunca se bloqueen.`,
    '',
    '## Secuencia de construcción',
    `1. **Fase 1 (${randomInt(rng, 2, 4)} semanas):** modelo de datos, ruta de escritura principal e interfaz mínima.`,
    `2. **Fase 2 (${randomInt(rng, 3, 6)} semanas):** procesamiento en segundo plano, notificaciones y vistas de administración.`,
    '3. **Fase 3:** consolidación: observabilidad, copias de seguridad y pruebas de carga con un volumen realista.',
    '',
    '## Riesgo técnico principal',
    'Que el proceso en segundo plano se convierta en un punto único de fallo oculto. Mitigación: diseñar las tareas para que sean idempotentes y reintentables desde el primer día, y mostrar la profundidad de la cola como una métrica de primer nivel.',
  ].join('\n');
}

function design(o: GenerateOptions, rng: () => number, topic: string): string {
  const tone = pick(rng, ['cálido y sin florituras', 'preciso y técnico', 'seguro y minimalista', 'editorial y táctil']);
  return [
    SIMULATION_NOTICE,
    '',
    '## Recorrido central del usuario',
    `**Tema:** ${topic}`,
    '',
    `1. La persona llega con una necesidad concreta relacionada con «${topic}».`,
    '2. Entiende en una sola pantalla si esto es para ella.',
    '3. Completa la acción principal sin fricción de cuenta.',
    '4. Recibe una confirmación que se siente como un compromiso asumido, no como un formulario enviado.',
    '',
    '## Principios de interfaz',
    '- **Una decisión por pantalla.** El móvil es el contexto por defecto, no una adaptación.',
    '- **El estado siempre visible.** Nadie debería preguntarse si algo está ocurriendo.',
    '- **Revelación progresiva.** La profundidad está disponible, pero nunca es lo primero que se muestra.',
    '',
    '## Dirección visual',
    `Estilo ${tone}. Alto contraste para leer bien en malas condiciones, espaciado generoso y un único color de acento reservado a la acción principal.`,
    '',
    '## La pantalla que más importa',
    'El estado de confirmación. Es el momento en que la confianza se gana o se pierde, y casi siempre está poco cuidado. Debe repetir con exactitud qué ocurrirá a continuación y cuándo.',
  ].join('\n');
}

function marketing(o: GenerateOptions, rng: () => number, topic: string): string {
  const channels = pick<readonly [string, string]>(rng, [
    ['alianzas locales', 'vídeo corto orgánico'],
    ['captación por intención de búsqueda', 'bucles de recomendación'],
    ['siembra en comunidades', 'publicidad social segmentada de pago'],
    ['prospección directa', 'contenido pensado para buscadores'],
  ]);
  return [
    SIMULATION_NOTICE,
    '',
    '## Mensaje central',
    `> ${capitalise(topic)}, sin fricciones y a la primera.`,
    '',
    'El mensaje habla del resultado, no del mecanismo. Los clientes compran el problema resuelto.',
    '',
    '## Dos canales, elegidos a propósito',
    `1. **${capitalise(channels[0])}**: la mayor intención por unidad de esfuerzo en esta etapa; llega a personas que ya están buscando.`,
    `2. **${capitalise(channels[1])}**: se acumula con el tiempo y reduce la dependencia de la captación de pago.`,
    '',
    'Todo lo demás se aplaza. Dos canales bien ejecutados valen más que seis mal llevados.',
    '',
    '## Secuencia de lanzamiento',
    `- **Semanas 1–2:** prueba del mensaje con ${randomInt(rng, 15, 40)} clientes objetivo antes de gastar nada.`,
    '- **Semanas 3–4:** lanzamiento suave solo en el canal 1, midiendo la conversión con honestidad.',
    '- **Semana 5 en adelante:** incorporar el canal 2 cuando el canal 1 tenga una base estable.',
    '',
    '## La métrica que importa',
    'El coste por cliente **retenido**, no el coste por contacto. Un contacto barato que nunca vuelve es una pérdida disfrazada de victoria.',
  ].join('\n');
}

function finance(o: GenerateOptions, rng: () => number, topic: string): string {
  const price = randomInt(rng, 20, 80);
  const cogs = Math.round(price * (randomInt(rng, 30, 55) / 100));
  const cac = randomInt(rng, 8, 30);
  const fixed = randomInt(rng, 1500, 6000);
  const contribution = price - cogs - cac;
  const breakeven = contribution > 0 ? Math.ceil(fixed / contribution) : 0;

  return [
    SIMULATION_NOTICE,
    '',
    '## Conjunto de supuestos',
    `**Tema:** ${topic}`,
    '',
    'Todas las cifras siguientes son **supuestos a efectos de modelado**. Ninguna venía en la misión ni se ha medido. Se expresan en una misma unidad monetaria.',
    '',
    '| Concepto | Valor supuesto |',
    '| --- | --- |',
    `| Ingreso medio por pedido | ${price} |`,
    `| Coste directo por pedido | ${cogs} |`,
    `| Coste de captación de cliente | ${cac} |`,
    `| Coste fijo mensual | ${fixed} |`,
    '',
    '## Economía unitaria',
    `Contribución por pedido = ${price} − ${cogs} − ${cac} = **${contribution}**.`,
    contribution > 0
      ? `Cada pedido aporta ${contribution} a cubrir los costes fijos.`
      : 'La contribución es **negativa**: con estos supuestos el modelo no funciona y hay que cambiar el precio o el coste antes del lanzamiento.',
    '',
    '## Punto de equilibrio',
    contribution > 0
      ? `${breakeven} pedidos al mes cubren la base fija de ${fixed}. Por debajo de ese volumen, «${topic}» consume caja cada mes.`
      : 'Con estos supuestos no existe punto de equilibrio.',
    '',
    '## Necesidad de financiación',
    `Suponiendo ${randomInt(rng, 4, 9)} meses hasta alcanzar el volumen de equilibrio, la necesidad de caja ronda ${fixed * randomInt(rng, 4, 9)} más los costes puntuales de puesta en marcha. Conviene reunir o reservar más de lo que indica el modelo: es optimista por construcción.`,
    '',
    '## Sensibilidad',
    'El resultado es más sensible al coste de captación. Una desviación del 50 % ahí elimina por completo el margen de contribución.',
  ].join('\n');
}

// ---------------------------------------------------------------------------
// QA and Integrator
// ---------------------------------------------------------------------------

function qa(o: GenerateOptions, rng: () => number): string {
  const lines: string[] = [SIMULATION_NOTICE, '', '## Veredicto por especialista', ''];

  for (const item of o.upstream) {
    const verdict = pick(rng, [
      'Sólido; avanza con los supuestos indicados.',
      'Utilizable, pero el razonamiento es más frágil de lo que parece.',
      'Va en buena dirección; los detalles requieren validación.',
    ]);
    lines.push(`- **${item.name}** — ${verdict}`);
  }

  for (const item of o.failed) {
    lines.push(`- **${item.name}** — ❌ **no produjo resultado.** ${item.error}`);
  }

  lines.push('', '## Contradicciones encontradas', '');
  if (o.upstream.length >= 2) {
    lines.push(
      '- Finanzas asume un coste de captación con el que Marketing nunca se comprometió; ambos informes se produjeron por separado y nunca se conciliaron.',
      '- Estrategia acota el segmento mientras Investigación describe el mercado amplio. Debería prevalecer la lectura acotada, pero los documentos hoy no coinciden.',
    );
  } else {
    lines.push('- Hay pocos resultados de especialistas para contrastarlos de forma significativa.');
  }

  lines.push('', '## Lagunas críticas', '');
  const gaps = [
    'Ningún agente validó la demanda con un cliente real. Todas las cifras posteriores heredan esa laguna.',
    'Las estimaciones de plazos no se han conciliado con la liquidez disponible.',
  ];
  if (o.failed.length > 0) {
    gaps.unshift(
      `**${o.failed.map((f) => f.name).join(', ')} no produjo nada**, así que el informe está incompleto en ${o.failed.length === 1 ? 'esa área' : 'esas áreas'}.`,
    );
  }
  lines.push(...gaps.map((g) => `- ${g}`));

  lines.push(
    '',
    '## Recomendación',
    '',
    o.failed.length > 0
      ? '**No seguir adelante tal como está.** Al informe le falta una pieza. Vuelve a ejecutar los agentes que fallaron, o acepta la laguna de forma explícita y deja documentado quién cubrirá ese trabajo a mano.'
      : '**Seguir con condiciones.** Pasar a un piloto de validación de pago, pero tratar toda cifra financiera como no validada hasta que existan datos reales de demanda.',
  );

  return lines.join('\n');
}

function integrator(o: GenerateOptions, rng: () => number, topic: string): string {
  const specialists = o.upstream.filter((u) => u.agentId !== 'qa');
  const qaReview = o.upstream.find((u) => u.agentId === 'qa');

  const lines: string[] = [
    SIMULATION_NOTICE,
    '',
    `# Informe de ejecución: ${capitalise(topic)}`,
    '',
    `**Misión:** ${missionLine(o.missionPrompt)}`,
    '',
    `Elaborado a partir de ${specialists.length} ${specialists.length === 1 ? 'informe de especialista' : 'informes de especialistas'}` +
      (qaReview ? ' más la revisión de calidad' : '') +
      (o.failed.length > 0 ? `, con ${o.failed.length} ${o.failed.length === 1 ? 'fallo de agente' : 'fallos de agentes'}` : '') +
      '.',
    '',
    '## El plan en un párrafo',
    '',
    `Abordar **${topic}** a través del segmento viable más estrecho, validar la demanda con un piloto de pago antes de asumir costes fijos y construir la superficie técnica mínima que permita completar una transacción real de principio a fin. Dos canales de captación, no seis. Toda cifra financiera de este informe es un supuesto hasta que el piloto aporte datos.`,
    '',
    '## Agentes participantes',
    '',
  ];

  for (const item of specialists) {
    lines.push(`### ${item.name}`, '', firstSubstantiveParagraph(item.result), '');
  }

  if (o.failed.length > 0) {
    lines.push('## Lagunas que se arrastran', '');
    for (const f of o.failed) {
      lines.push(`- **${f.name} no se ejecutó.** ${f.error} Esta área queda sin cubrir y debe resolverse a mano o volviendo a ejecutar la misión.`);
    }
    lines.push('');
  }

  lines.push(
    '## Siguientes pasos ordenados',
    '',
    `1. **Validar la demanda** — entrevistar a ${randomInt(rng, 15, 30)} clientes objetivo y recoger preventas. Responsable: Estrategia.`,
    '2. **Fijar los supuestos** — sustituir cada cifra modelada por una medida. Responsable: Finanzas.',
    '3. **Construir el recorrido de la transacción** — un único flujo completo, nada más. Responsable: Código.',
    '4. **Activar un canal** — medir el coste por cliente retenido, no por contacto. Responsable: Marketing.',
    '',
    '## Riesgos que se arrastran',
    '',
    '- La demanda se da por supuesta, no está probada. Es el riesgo que invalida todos los demás.',
    '- El coste de captación determina todo el modelo financiero y tiene el mayor margen de error.',
    '- La concentración en pocos canales crea un punto único de fallo en la distribución.',
    '',
    '## Sin resolver',
    '',
    qaReview
      ? '- Las contradicciones que señaló la revisión de calidad entre los supuestos de Finanzas y de Marketing **no están resueltas en este informe**. Necesitan un único responsable que las concilie antes de empezar a gastar.'
      : '- No hubo revisión de calidad, así que este informe no ha sido auditado.',
    '- Ningún agente dispone de datos primarios de mercado. Trata este documento como un plan para conseguir esos datos, no como evidencia.',
  );

  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function capitalise(value: string): string {
  return value.length === 0 ? value : value.charAt(0).toUpperCase() + value.slice(1);
}

/**
 * Pull the first real prose paragraph out of an agent result, skipping the
 * banner, headings, tables and code. A bare list item is used only as a
 * fallback, since it reads badly out of its list context.
 */
function firstSubstantiveParagraph(markdown: string): string {
  const candidates = markdown.split('\n').map((line) => line.trim()).filter((line) => {
    return (
      line.length > 0 &&
      !line.startsWith('>') &&
      !line.startsWith('#') &&
      !line.startsWith('|') &&
      !line.startsWith('```') &&
      !line.startsWith('**Tema:**')
    );
  });

  const isListItem = (line: string) => /^([-*+]\s|\d+[.)]\s)/.test(line);

  return candidates.find((line) => !isListItem(line)) ?? candidates[0] ?? '_No hay contenido que resumir._';
}
