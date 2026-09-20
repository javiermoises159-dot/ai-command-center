/**
 * Visual reverse engineering.
 *
 * Turns a screenshot or recording of an interface into a reconstruction plan:
 * the screens, components, states and flows to rebuild from scratch. Only for
 * material the operator owns or is authorised to study. The gate is explicit
 * and must be answered before any plan is produced; it is not inferred.
 *
 * The plan never asks to copy protected assets: logos, trademarks, fonts under
 * restrictive licences, copy and imagery are listed as "replace with your own".
 */

export type Authorization = 'own' | 'authorized';

export interface ReverseRequest {
  /** Where the material comes from, in the requester's words. */
  subject: string;
  authorization: Authorization | 'none' | 'unknown';
  /** Evidence of authorisation for `authorized`: a licence, a contract, an email. */
  authorizationEvidence?: string;
  /** Observations already extracted from the material (by a person or a vision model). */
  observed: { screens?: string[]; components?: string[]; flows?: string[]; states?: string[]; tokens?: Record<string, string> };
}

export class ReverseEngineeringRefused extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ReverseEngineeringRefused';
  }
}

export interface ReconstructionPlan {
  subject: string;
  authorization: Authorization;
  steps: { order: number; title: string; detail: string }[];
  screens: string[];
  components: string[];
  flows: string[];
  states: string[];
  tokens: Record<string, string>;
  replaceWithOwn: string[];
  caveats: string[];
}

export function planReconstruction(req: ReverseRequest): ReconstructionPlan {
  if (req.authorization === 'none' || req.authorization === 'unknown') {
    throw new ReverseEngineeringRefused('Solo se planifica la reconstrucción de interfaces que te pertenecen o que estás autorizado a estudiar. Indica cuál de los dos casos es, o aporta material propio.');
  }
  if (req.authorization === 'authorized' && (req.authorizationEvidence ?? '').trim() === '') {
    throw new ReverseEngineeringRefused('El estudio autorizado necesita una referencia a la autorización (licencia, contrato o permiso por escrito).');
  }
  const o = req.observed;
  const screens = o.screens ?? [];
  const components = o.components ?? [];
  const flows = o.flows ?? [];
  const states = o.states ?? [];
  const tokens = o.tokens ?? {};
  const steps = [
    { order: 1, title: 'Inventario', detail: `Enumera ${screens.length === 1 ? 'la pantalla' : `las ${screens.length} pantallas`} y los estados que muestra cada una (vacío, cargando, error, con datos).` },
    { order: 2, title: 'Tokens', detail: 'Anota colores, espaciado, escala tipográfica y radios como tokens, y construye a partir de los tokens en lugar de valores en píxeles.' },
    { order: 3, title: 'Componentes', detail: `Construye primero ${components.length === 1 ? 'el componente compartido' : `los ${components.length} componentes compartidos`}, de forma aislada y con cada uno de sus estados.` },
    { order: 4, title: 'Pantallas', detail: 'Compón las pantallas a partir de los componentes, empezando por el ancho de móvil.' },
    { order: 5, title: 'Flujos', detail: `Conecta ${flows.length === 1 ? 'el flujo' : `los ${flows.length} flujos`} y compruébalos paso a paso contra la grabación.` },
    { order: 6, title: 'Comparación', detail: 'Compara el resultado con la referencia al mismo ancho y anota cada diferencia, sea intencionada o un error.' },
  ];
  return {
    subject: req.subject,
    authorization: req.authorization,
    steps,
    screens, components, flows, states, tokens,
    replaceWithOwn: ['Logotipos y marcas denominativas', 'Nombres registrados', 'Fotografías e ilustraciones', 'Textos publicitarios', 'Tipografías sin licencia para tu uso'],
    caveats: [
      'El plan parte de las observaciones aportadas; todo lo que no se haya observado (hover, animaciones, comportamiento tras un inicio de sesión) se desconoce y hay que comprobarlo.',
      'Reconstruir la estructura no da permiso para reutilizar material protegido.',
    ],
  };
}
