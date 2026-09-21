/**
 * Craft guides: what separates work that looks made by a person from work that
 * looks generated. They are plain text added to prompts (design, site, logo,
 * social copy, photo prompts), so every producer of visible material shares the
 * same standard. Kept in one place so it can be tuned without touching the rest.
 */

/** For anything visual the crew designs or builds: pages, brand, logos. */
export const VISUAL_CRAFT_GUIDE = [
  'OFICIO VISUAL (que se note que lo hizo una persona con criterio, no una plantilla)',
  '- Parte de UN detalle concreto del negocio (su producto, su barrio, cómo lo hacen) y deja que decida la paleta, la tipografía y el tono. Nada de "moderno y profesional".',
  '- Prohibido lo que delata a una IA: degradados morados o azules, efecto cristal, sombras difusas por todas partes, tres tarjetas iguales con un icono arriba, iconos de emoji, ilustraciones genéricas de personas, "Bienvenido a…", "Descubre…", "innovador", "de calidad", "premium", "soluciones".',
  '- Paleta corta y con carácter: un fondo cálido o neutro (no blanco puro), un color de texto casi negro, UN color de acento que sale del producto. Máximo 3 colores en total.',
  '- Tipografía: un titular con personalidad (serif como Georgia o Palatino, o sans muy compacta en mayúsculas) y un texto de lectura cómodo. Titulares grandes, alineados a la izquierda, con contraste de tamaño claro.',
  '- Composición con intención: rompe la simetría, alterna secciones de ancho completo con columnas descentradas, deja aire generoso y usa un ritmo irregular en vez de bloques idénticos apilados.',
  '- Toques hechos a mano: un subrayado o garabato en SVG, una etiqueta ligeramente girada, una cinta de precio, bordes con algo de textura. Pocos y bien elegidos, no decoración por rellenar.',
  '- Los textos los escribe el dueño del negocio en primera persona ("lo hacemos", "lo horneamos por la mañana"), con detalles reales: ingredientes, tamaños, cómo se pide, dónde está. Frases cortas.',
  '- No inventes datos: precios, direcciones, reseñas, cifras o fotos que no te hayan dado. Si falta algo, deja un texto provisional claramente marcado para que la persona lo complete.',
  '- Logotipos: una sola idea simple y reconocible a 32 px, con algo de personalidad en la forma o en las letras. Evita globos, hojas, engranajes, destellos, remolinos y degradados.',
].join('\n');

/** For social posts, captions and spoken scripts. */
export const CONTENT_VOICE_GUIDE = [
  'VOZ (como si el dueño lo escribiera desde el móvil)',
  '- Habla como una persona del negocio a una vecina o un vecino: cercano, concreto y con una sola idea por pieza.',
  '- Empieza con un hecho, una escena o un detalle real, nunca con "¡Descubre!", "¿Sabías que…?" ni "Te presentamos".',
  '- Nada de listas de beneficios ni de adjetivos vacíos (increíble, único, espectacular, delicioso). Enseña algo concreto en su lugar: cómo se hace, qué lleva, cuándo sale del horno.',
  '- Como mucho un emoji, y solo si aporta. Entre 3 y 5 hashtags, de verdad relacionados con el lugar y el producto, al final.',
  '- Frases de largo desigual, alguna muy corta. Un cierre natural ("los sábados por la mañana estamos en…") en vez de una llamada a la acción de manual.',
  '- No prometas ni inventes nada que no te hayan dicho.',
].join('\n');

/** For prompts sent to the picture generator when the image should look like a real photo. */
export const PHOTO_STYLE_GUIDE = [
  'Para fotografías: descríbelas como una foto real hecha con un móvil o una cámara sencilla, no como un render.',
  'Luz natural de ventana, encuadre algo imperfecto o de cerca, texturas reales (migas, harina, marcas de uso), colores suaves y poco saturados, fondo cotidiano (una mesa de madera, un paño de cocina).',
  'Evita "ultra detallado", "8k", "perfecto", "fondo de estudio", "cinematográfico". Sin texto, marcas de agua ni manos deformadas: si aparecen manos, que sea lo mínimo.',
].join(' ');
