/**
 * Tool registry.
 *
 * A tool is a capability an agent can call that is not the model itself. The
 * registry is honest about what exists: a tool is `AVAILABLE` only when the
 * code behind it is in this repository and works; everything else is
 * `PLANNED` (no adapter yet), `NOT_CONNECTED` (an adapter is expected but its
 * service or credentials are missing) or `DISABLED` (deliberately switched off).
 *
 * Nothing in the catalog is connected to an external service. Status changes at
 * runtime go through `setStatus`, which the composition root uses when it
 * detects a real connection.
 */

import type {
  Capability,
  FieldSpec,
  PermissionLevel,
  RiskLevel,
  ToolCategory,
  ToolLimits,
  ToolSpec,
  ToolStatus,
} from '../types.ts';
import { formatValidationErrors, validateToolInput, type ToolValidation } from './validation.ts';

/** A filter over the catalog. Every field is optional; they combine with AND. */
export interface ToolQuery {
  capability?: Capability;
  category?: ToolCategory;
  status?: ToolStatus;
  /** True keeps only the tools that can be called right now, false the rest. */
  usable?: boolean;
  /** True keeps only the tools an operator has left switched on. */
  enabled?: boolean;
  /** Needs every one of these permission levels. */
  permissions?: PermissionLevel[];
  /** Case-insensitive match on id, name or description. */
  text?: string;
}

/** What an operator's switch-off recorded, so `enable` can undo it exactly. */
interface DisabledRecord {
  reason: string;
  previousStatus: ToolStatus;
  previousDetail: string;
}

export class ToolRegistry {
  private readonly tools = new Map<string, ToolSpec>();
  private readonly disabled = new Map<string, DisabledRecord>();

  constructor(specs: readonly ToolSpec[] = []) {
    for (const spec of specs) this.register(spec);
  }

  register(spec: ToolSpec): this {
    if (this.tools.has(spec.id)) throw new Error(`Tool "${spec.id}" is already registered.`);
    this.tools.set(spec.id, structuredClone(spec));
    return this;
  }

  get(id: string): ToolSpec | undefined {
    return this.tools.get(id);
  }

  /** Like `get`, but throws instead of returning undefined. */
  require(id: string): ToolSpec {
    const spec = this.tools.get(id);
    if (spec === undefined) throw new Error(`Unknown tool "${id}".`);
    return spec;
  }

  list(): ToolSpec[] {
    return [...this.tools.values()];
  }

  byCategory(category: ToolCategory): ToolSpec[] {
    return this.list().filter((t) => t.category === category);
  }

  byStatus(status: ToolStatus): ToolSpec[] {
    return this.list().filter((t) => t.status === status);
  }

  /** True when the tool can be called right now. A disabled tool never can. */
  isUsable(id: string): boolean {
    const spec = this.tools.get(id);
    if (spec === undefined || !spec.enabled) return false;
    return spec.status === 'AVAILABLE' || spec.status === 'CONNECTED' || spec.status === 'MOCK';
  }

  /** The operator switch, independent of whether the service behind it works. */
  isEnabled(id: string): boolean {
    return this.tools.get(id)?.enabled ?? false;
  }

  /** Why a tool was switched off, when an operator gave a reason. */
  disabledReason(id: string): string | null {
    return this.disabled.get(id)?.reason ?? null;
  }

  /**
   * Switch a tool off. It stops being routed to and stops executing, whatever
   * its status says; the status it had is remembered so `enable` can restore it.
   */
  disable(id: string, reason: string): void {
    const spec = this.require(id);
    const detail = reason.trim() === '' ? 'Deshabilitada por un operador.' : reason.trim();
    const existing = this.disabled.get(id);
    if (existing !== undefined) {
      existing.reason = detail;
      spec.statusDetail = detail;
      spec.enabled = false;
      return;
    }
    this.disabled.set(id, { reason: detail, previousStatus: spec.status, previousDetail: spec.statusDetail });
    spec.enabled = false;
    spec.status = 'DISABLED';
    spec.statusDetail = detail;
  }

  /**
   * Switch a tool back on and restore the status it had before. A tool whose
   * catalog entry is `DISABLED` (never implemented) stays unusable: the switch
   * is on again, but its status still says there is nothing behind it.
   */
  enable(id: string): void {
    const spec = this.require(id);
    spec.enabled = true;
    const record = this.disabled.get(id);
    if (record === undefined) return;
    spec.status = record.previousStatus;
    spec.statusDetail = record.previousDetail;
    this.disabled.delete(id);
  }

  /** Usable tools that provide a capability. */
  forCapability(capability: Capability): ToolSpec[] {
    return this.list().filter((t) => this.isUsable(t.id) && t.capabilities.includes(capability));
  }

  /** Every tool (usable or not) that would provide a capability. Used to explain gaps. */
  anyFor(capability: Capability): ToolSpec[] {
    return this.list().filter((t) => t.capabilities.includes(capability));
  }

  /** Discovery: the tools matching every field of the query, in catalog order. */
  discover(query: ToolQuery = {}): ToolSpec[] {
    const text = query.text?.trim().toLowerCase() ?? '';
    return this.list().filter((t) => {
      if (query.capability !== undefined && !t.capabilities.includes(query.capability)) return false;
      if (query.category !== undefined && t.category !== query.category) return false;
      if (query.status !== undefined && t.status !== query.status) return false;
      if (query.usable !== undefined && this.isUsable(t.id) !== query.usable) return false;
      if (query.enabled !== undefined && t.enabled !== query.enabled) return false;
      if (query.permissions !== undefined && !query.permissions.every((p) => t.permissions.includes(p))) return false;
      if (text !== '' && !`${t.id} ${t.name} ${t.description}`.toLowerCase().includes(text)) return false;
      return true;
    });
  }

  /** Every capability the catalog declares, sorted, for discovery by capability. */
  capabilities(): Capability[] {
    return [...new Set(this.list().flatMap((t) => t.capabilities))].sort();
  }

  // ---- permissions -------------------------------------------------------
  // The registry only reports what a tool demands. Whether a demand is granted
  // is the permission policy's decision, and lives outside this file.

  /** The permission levels a tool requires. Empty for an unknown tool. */
  permissionsFor(id: string): PermissionLevel[] {
    return [...(this.tools.get(id)?.permissions ?? [])];
  }

  /** True when the tool requires that level. */
  requiresPermission(id: string, level: PermissionLevel): boolean {
    return this.permissionsFor(id).includes(level);
  }

  // ---- input contract ----------------------------------------------------

  /** Check an input against a tool's declared schema and size ceiling. */
  validateInput(id: string, input: unknown): ToolValidation {
    const spec = this.tools.get(id);
    if (spec === undefined) return { ok: false, errors: [`No existe ninguna herramienta con el id «${id}».`] };
    return validateToolInput(spec, input);
  }

  /** The same check, as the sentence a failed `ToolResult` would carry. */
  explainInvalidInput(id: string, input: unknown): string | null {
    const spec = this.tools.get(id);
    if (spec === undefined) return `No existe ninguna herramienta con el id «${id}».`;
    const validation = validateToolInput(spec, input);
    return validation.ok ? null : formatValidationErrors(spec, validation.errors);
  }

  setStatus(id: string, status: ToolStatus, detail: string): void {
    const spec = this.require(id);
    const off = this.disabled.get(id);
    if (off !== undefined) {
      // An operator switched this tool off; a runtime detection does not undo
      // that. Remember what was detected so `enable` restores the truth.
      off.previousStatus = status;
      off.previousDetail = detail;
      return;
    }
    spec.status = status;
    spec.statusDetail = detail;
  }

  countByStatus(): Record<ToolStatus, number> {
    const counts: Record<ToolStatus, number> = {
      AVAILABLE: 0,
      CONNECTED: 0,
      MOCK: 0,
      PLANNED: 0,
      NOT_CONNECTED: 0,
      DISABLED: 0,
    };
    for (const tool of this.tools.values()) counts[tool.status] += 1;
    return counts;
  }
}

// ---------------------------------------------------------------------------
// Catalog
// ---------------------------------------------------------------------------

type Fields = Record<string, FieldSpec>;

const str = (description: string, required = false): FieldSpec => ({ type: 'string', description, required });
const num = (description: string, required = false): FieldSpec => ({ type: 'number', description, required });
const arr = (description: string, required = false): FieldSpec => ({ type: 'array', description, required });
const obj = (description: string, required = false): FieldSpec => ({ type: 'object', description, required });
const oneOf = (description: string, values: string[], required = false): FieldSpec => ({ type: 'string', description, required, enum: values });

/** Timeouts read better as seconds and minutes than as five-digit numbers. */
const SEC = (n: number): number => n * 1_000;
const MIN = (n: number): number => n * 60_000;

/**
 * Versions are the version of the *contract*, not a promise about the service:
 *
 *  1.0.0  implemented in this repository and in use.
 *  0.1.0  the schema, permissions and limits are declared, nothing runs yet.
 *
 * A breaking change to `inputSchema` bumps the major.
 */
const DECLARED_ONLY = '0.1.0';

interface Def {
  id: string;
  name: string;
  category: ToolCategory;
  description: string;
  capabilities?: Capability[];
  provider?: string | null;
  input?: Fields;
  output?: Fields;
  auth?: Partial<ToolSpec['auth']>;
  cost?: ToolSpec['cost'];
  locality?: ToolSpec['locality'];
  permissions?: PermissionLevel[];
  risk?: RiskLevel;
  status: ToolStatus;
  detail: string;
  version: string;
  timeoutMs: number;
  limits?: Partial<ToolLimits>;
  /** Only the tools an operator has switched off pass `false`. */
  enabled?: boolean;
}

function tool(def: Def): ToolSpec {
  return {
    id: def.id,
    name: def.name,
    category: def.category,
    description: def.description,
    capabilities: def.capabilities ?? [],
    provider: def.provider ?? null,
    // Strict on purpose: a call with a misspelt or invented field is refused,
    // not run with the field ignored.
    inputSchema: { fields: def.input ?? {}, additionalProperties: false },
    outputSchema: { fields: def.output ?? {} },
    auth: { required: false, kind: 'none', envVars: [], ...def.auth },
    cost: def.cost ?? { model: 'free', note: 'Sin coste por uso.' },
    locality: def.locality ?? 'local',
    permissions: def.permissions ?? ['READ'],
    risk: def.risk ?? 'low',
    status: def.status,
    statusDetail: def.detail,
    version: def.version,
    timeoutMs: def.timeoutMs,
    limits: { maxCallsPerRun: null, maxInputBytes: null, ...def.limits },
    enabled: def.enabled ?? true,
  };
}

const KEY = (...envVars: string[]): Partial<ToolSpec['auth']> => ({ required: true, kind: 'api_key', envVars });
const UNKNOWN_COST: ToolSpec['cost'] = { model: 'unknown', note: 'Depende del servicio elegido; no se supone ningún precio.' };

export function defaultToolSpecs(): ToolSpec[] {
  return [
    // ---- Real, inside this repository ----
    tool({
      id: 'memory.recall',
      name: 'Recuperación de memoria',
      category: 'system',
      description: 'Busca en la memoria de MADRE (contexto del usuario, decisiones, resultados, lecciones) por palabra clave, ámbito y tipo.',
      capabilities: ['memory.read'],
      input: { query: str('Palabras que buscar.', true), scope: str('Ámbito: user, project, mission o session.'), limit: num('Máximo de entradas.') },
      output: { entries: arr('Entradas de memoria coincidentes, con su fuente y confianza.') },
      version: '1.0.0',
      timeoutMs: SEC(5),
      limits: { maxCallsPerRun: 40, maxInputBytes: 8_000 },
      status: 'AVAILABLE',
      detail: 'Consulta el almacén de documentos. Solo lectura.',
    }),
    tool({
      id: 'memory.remember',
      name: 'Escritura en memoria',
      category: 'system',
      description: 'Guarda una entrada con su fuente y confianza. Lo que genera el modelo se guarda como no verificado.',
      capabilities: ['memory.write'],
      input: { type: str('Tipo de memoria.', true), title: str('Título breve.', true), content: str('El contenido.', true) },
      output: { id: str('Id de la entrada guardada.') },
      permissions: ['WRITE'],
      version: '1.0.0',
      timeoutMs: SEC(5),
      limits: { maxCallsPerRun: 80, maxInputBytes: 64_000 },
      status: 'AVAILABLE',
      detail: 'Solo escribe en el almacén de documentos. Los hechos exigen una fuente verificada.',
    }),
    tool({
      id: 'math.calculator',
      name: 'Calculadora',
      category: 'analytics',
      description: 'Evalúa con exactitud una expresión aritmética (+ - * / ^ % y paréntesis). Sirve para comprobar las cifras que cita un agente.',
      capabilities: ['finance.unit_economics', 'finance.budget', 'finance.experiment_cost'],
      input: { expression: str('Por ejemplo: 12 * (4 + 1.5).', true) },
      output: { value: num('El resultado.'), expression: str('La expresión tal como se evaluó.') },
      version: '1.0.0',
      timeoutMs: SEC(1),
      limits: { maxCallsPerRun: 200, maxInputBytes: 2_000 },
      status: 'AVAILABLE',
      detail: 'Analizador determinista incluido en este repositorio. Nunca ejecuta código arbitrario.',
    }),
    tool({
      id: 'sandbox.files',
      name: 'Archivos del entorno aislado',
      category: 'files',
      description: 'Escribe y lee archivos temporales en un directorio aislado con límites de tamaño y cantidad, y recoge los artefactos.',
      capabilities: ['files.sandbox'],
      input: { path: str('Ruta relativa dentro del entorno aislado.', true), content: str('Contenido del archivo al escribir.') },
      output: { bytes: num('Tamaño escrito o leído.') },
      permissions: ['READ', 'WRITE'],
      risk: 'low',
      version: '1.0.0',
      timeoutMs: SEC(10),
      limits: { maxCallsPerRun: 200, maxInputBytes: 1_000_000 },
      status: 'AVAILABLE',
      detail: 'Directorio temporal local. Se rechaza el recorrido de rutas. No ejecuta código.',
    }),
    tool({
      id: 'model.generate',
      name: 'Generación de texto',
      category: 'creation',
      description: 'Genera texto con el proveedor configurado. Así es como los agentes razonan.',
      capabilities: ['text.generate'],
      provider: 'proveedor configurado',
      input: { prompt: str('El prompt de la tarea.', true) },
      output: { text: str('Texto generado.') },
      cost: { model: 'per_token', note: 'Gratis con el simulado y con los modelos locales; los precios externos salen solo de la configuración.' },
      version: '1.0.0',
      timeoutMs: MIN(2),
      limits: { maxCallsPerRun: null, maxInputBytes: 400_000 },
      status: 'MOCK',
      detail: 'Lo atiende el proveedor simulado hasta que se conecte uno real.',
    }),

    // ---- Research ----
    tool({
      id: 'web.search',
      name: 'Búsqueda web',
      category: 'research',
      description: 'Busca en la web en vivo y devuelve resultados ordenados con sus URL.',
      capabilities: ['research.web'],
      provider: 'Tavily (plan gratuito)',
      input: { query: str('Consulta de búsqueda.', true), limit: num('Máximo de resultados.') },
      output: { results: arr('Título, URL, extracto y fecha.') },
      auth: KEY('TAVILY_API_KEY'),
      cost: { model: 'free', note: 'Plan gratuito de Tavily (cupo mensual limitado; al agotarse la llamada falla, no cobra).' },
      locality: 'remote',
      version: '1.0.0',
      timeoutMs: SEC(15),
      limits: { maxCallsPerRun: 30, maxInputBytes: 4_000 },
      status: 'NOT_CONNECTED',
      detail: 'Falta TAVILY_API_KEY (clave gratuita en tavily.com). Sin ella la investigación se basa en el conocimiento del modelo y lo indica.',
    }),
    tool({
      id: 'web.fetch',
      name: 'Descarga de páginas web',
      category: 'research',
      description: 'Descarga una página y extrae su texto legible para poder citarla.',
      capabilities: ['research.web'],
      input: { url: str('URL de la página.', true) },
      output: { text: str('Texto extraído.'), title: str('Título de la página.'), fetchedAt: str('Marca de tiempo ISO.') },
      locality: 'remote',
      permissions: ['READ', 'EXTERNAL_ACTION'],
      version: '1.0.0',
      timeoutMs: SEC(20),
      limits: { maxCallsPerRun: 30, maxInputBytes: 4_000 },
      status: 'NOT_CONNECTED',
      detail: 'Listo pero apagado: el servidor lo activa con WEB_FETCH_ENABLED=true (por defecto en producción). Solo lee páginas públicas: bloquea redes privadas y localhost.',
    }),
    tool({
      id: 'research.wikipedia',
      name: 'Wikipedia',
      category: 'research',
      description: 'Consulta información enciclopédica de contexto.',
      capabilities: ['research.web'],
      provider: 'Wikipedia',
      input: { title: str('Título del artículo o consulta.', true), lang: str('Código de idioma (es, en, it…). Por defecto es.') },
      output: { extract: str('Sección introductoria.'), url: str('Dirección del artículo.') },
      locality: 'remote',
      version: '1.0.0',
      timeoutMs: SEC(15),
      limits: { maxCallsPerRun: 30, maxInputBytes: 2_000 },
      status: 'NOT_CONNECTED',
      detail: 'Conector listo pero apagado: el servidor lo activa con WIKIPEDIA_ENABLED=true (por defecto en producción). No necesita clave.',
    }),

    // ---- Development and execution ----
    tool({
      id: 'sandbox.exec',
      name: 'Ejecución de código',
      category: 'development',
      description: 'Ejecuta código dentro del entorno aislado.',
      capabilities: ['data.analysis'],
      input: { language: str('Lenguaje.', true), source: str('Código fuente.', true) },
      output: { stdout: str('Salida.'), exitCode: num('Código de salida.') },
      permissions: ['EXECUTE'],
      risk: 'critical',
      version: '0.1.0',
      timeoutMs: SEC(30),
      limits: { maxCallsPerRun: 5, maxInputBytes: 200_000 },
      enabled: false,
      status: 'DISABLED',
      detail: 'No se ha implementado a propósito. La ejecución arbitraria necesita antes aislamiento en contenedor y aprobación en cada ejecución.',
    }),
    tool({
      id: 'dev.openhands',
      name: 'OpenHands',
      category: 'development',
      description: 'Agente de ingeniería de software de código abierto que edita un repositorio y ejecuta sus pruebas.',
      capabilities: ['engineering.build_plan'],
      provider: 'OpenHands (código abierto)',
      auth: { required: false, kind: 'local_service', envVars: ['OPENHANDS_URL'] },
      permissions: ['READ', 'WRITE', 'EXECUTE'],
      risk: 'high',
      version: '0.1.0',
      timeoutMs: MIN(10),
      limits: { maxCallsPerRun: 3, maxInputBytes: 200_000 },
      status: 'PLANNED',
      detail: 'Sin adaptador. Se ejecutaría en local y siempre con aprobación previa.',
    }),
    tool({
      id: 'dev.github',
      name: 'GitHub',
      category: 'development',
      description: 'Lee repositorios y abre incidencias y pull requests.',
      provider: 'GitHub',
      auth: { required: true, kind: 'oauth', envVars: ['GITHUB_TOKEN'] },
      locality: 'remote',
      permissions: ['READ', 'WRITE', 'EXTERNAL_ACTION'],
      risk: 'medium',
      version: '0.1.0',
      timeoutMs: SEC(20),
      limits: { maxCallsPerRun: 40, maxInputBytes: 100_000 },
      status: 'NOT_CONNECTED',
      detail: 'No hay token configurado y todavía no hay adaptador.',
    }),

    // ---- Media (local-first) ----
    tool({
      id: 'media.ffmpeg',
      name: 'FFmpeg',
      category: 'media',
      description: 'Corta, une, transcodifica y subtitula audio y vídeo.',
      capabilities: ['content.video'],
      provider: 'FFmpeg (código abierto)',
      auth: { required: false, kind: 'local_service', envVars: [] },
      permissions: ['READ', 'WRITE', 'EXECUTE'],
      risk: 'medium',
      version: '0.1.0',
      timeoutMs: MIN(5),
      limits: { maxCallsPerRun: 20, maxInputBytes: 8_000 },
      status: 'PLANNED',
      detail: 'Necesita ejecución en entorno aislado antes de poder integrarse.',
    }),
    tool({
      id: 'media.whisper',
      name: 'Whisper',
      category: 'media',
      description: 'Transcribe voz a texto en la máquina local.',
      capabilities: ['content.video', 'content.voice'],
      provider: 'Whisper (código abierto)',
      auth: { required: false, kind: 'local_service', envVars: [] },
      permissions: ['READ', 'EXECUTE'],
      version: '0.1.0',
      timeoutMs: MIN(5),
      limits: { maxCallsPerRun: 10, maxInputBytes: 8_000 },
      status: 'PLANNED',
      detail: 'Todavía no hay adaptador.',
    }),
    tool({
      id: 'media.image_generation',
      name: 'Generación de imágenes',
      category: 'media',
      description: 'Genera imágenes a partir de un prompt.',
      capabilities: ['design.visual_brief'],
      auth: KEY('IMAGE_API_KEY'),
      cost: UNKNOWN_COST,
      locality: 'remote',
      version: '0.1.0',
      timeoutMs: MIN(2),
      limits: { maxCallsPerRun: 10, maxInputBytes: 16_000 },
      status: 'NOT_CONNECTED',
      detail: 'No se ha elegido ni configurado ningún servicio de imágenes.',
    }),
    tool({
      id: 'media.video_generation',
      name: 'Generación de vídeo',
      category: 'media',
      description: 'Genera clips cortos a partir de un prompt o un guion gráfico.',
      capabilities: ['content.video'],
      auth: KEY('VIDEO_API_KEY'),
      cost: UNKNOWN_COST,
      locality: 'remote',
      version: '0.1.0',
      timeoutMs: MIN(10),
      limits: { maxCallsPerRun: 3, maxInputBytes: 16_000 },
      status: 'NOT_CONNECTED',
      detail: 'No se ha elegido ni configurado ningún servicio de vídeo.',
    }),
    tool({
      id: 'media.voice_generation',
      name: 'Generación de voz',
      category: 'media',
      description: 'Sintetiza una locución a partir de un guion.',
      capabilities: ['content.voice'],
      auth: KEY('VOICE_API_KEY'),
      cost: UNKNOWN_COST,
      locality: 'hybrid',
      version: '0.1.0',
      timeoutMs: MIN(2),
      limits: { maxCallsPerRun: 10, maxInputBytes: 32_000 },
      status: 'NOT_CONNECTED',
      detail: 'No se ha elegido ni configurado ningún servicio de voz; se preferiría un motor local.',
    }),
    tool({
      id: 'media.autoclip',
      name: 'AutoClip',
      category: 'media',
      description: 'Corta vídeos largos en clips cortos de forma automática.',
      capabilities: ['content.video'],
      provider: 'AutoClip (código abierto)',
      permissions: ['READ', 'WRITE', 'EXECUTE'],
      version: '0.1.0',
      timeoutMs: MIN(10),
      limits: { maxCallsPerRun: 3, maxInputBytes: 8_000 },
      status: 'PLANNED',
      detail: 'Integración sin empezar; depende de FFmpeg y Whisper.',
    }),
    tool({
      id: 'media.moneyprinter',
      name: 'MoneyPrinterTurbo',
      category: 'media',
      description: 'Compone vídeos cortos a partir de un tema: guion, material de archivo, voz y subtítulos.',
      capabilities: ['content.video', 'content.script'],
      provider: 'MoneyPrinterTurbo (código abierto)',
      permissions: ['READ', 'WRITE', 'EXECUTE'],
      risk: 'medium',
      version: '0.1.0',
      timeoutMs: MIN(15),
      limits: { maxCallsPerRun: 2, maxInputBytes: 16_000 },
      status: 'PLANNED',
      detail: 'Integración sin empezar. El resultado pasaría igualmente por QA y por la revisión de políticas de la plataforma antes de cualquier publicación.',
    }),

    // ---- Distribution and analytics (never connected without approval) ----
    tool({
      id: 'distribution.tiktok',
      name: 'TikTok',
      category: 'distribution',
      description: 'Publica y lee analíticas a través de la API oficial.',
      capabilities: ['content.publish', 'content.analytics'],
      provider: 'TikTok',
      auth: { required: true, kind: 'oauth', envVars: ['TIKTOK_CLIENT_KEY', 'TIKTOK_CLIENT_SECRET'] },
      locality: 'remote',
      permissions: ['EXTERNAL_ACTION', 'PUBLISH'],
      risk: 'high',
      version: '0.1.0',
      timeoutMs: SEC(60),
      limits: { maxCallsPerRun: 3, maxInputBytes: 64_000 },
      status: 'NOT_CONNECTED',
      detail: 'Sin credenciales de aplicación. Publicar exigiría siempre aprobación.',
    }),
    tool({
      id: 'distribution.instagram',
      name: 'Instagram',
      category: 'distribution',
      description: 'Publica y lee analíticas a través de la API oficial.',
      capabilities: ['content.publish', 'content.analytics'],
      provider: 'Meta',
      auth: { required: true, kind: 'oauth', envVars: ['META_APP_ID', 'META_APP_SECRET'] },
      locality: 'remote',
      permissions: ['EXTERNAL_ACTION', 'PUBLISH'],
      risk: 'high',
      version: '0.1.0',
      timeoutMs: SEC(60),
      limits: { maxCallsPerRun: 3, maxInputBytes: 64_000 },
      status: 'NOT_CONNECTED',
      detail: 'Sin credenciales de aplicación. Publicar exigiría siempre aprobación.',
    }),
    tool({
      id: 'distribution.youtube',
      name: 'YouTube',
      category: 'distribution',
      description: 'Publica y lee analíticas a través de la API oficial.',
      capabilities: ['content.publish', 'content.analytics'],
      provider: 'Google',
      auth: { required: true, kind: 'oauth', envVars: ['GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET'] },
      locality: 'remote',
      permissions: ['EXTERNAL_ACTION', 'PUBLISH'],
      risk: 'high',
      version: '0.1.0',
      timeoutMs: MIN(5),
      limits: { maxCallsPerRun: 3, maxInputBytes: 64_000 },
      status: 'NOT_CONNECTED',
      detail: 'Sin credenciales de aplicación. Publicar exigiría siempre aprobación.',
    }),
    tool({
      id: 'analytics.platform',
      name: 'Analíticas de plataforma',
      category: 'analytics',
      description: 'Lee las cifras de rendimiento de una plataforma conectada.',
      capabilities: ['content.analytics'],
      locality: 'remote',
      permissions: ['READ', 'EXTERNAL_ACTION'],
      version: '0.1.0',
      timeoutMs: SEC(30),
      limits: { maxCallsPerRun: 30, maxInputBytes: 4_000 },
      status: 'NOT_CONNECTED',
      detail: 'Necesita al menos una plataforma conectada.',
    }),

    // ---- Communication and automation ----
    tool({
      id: 'comms.email',
      name: 'Correo electrónico',
      category: 'communication',
      description: 'Redacta y envía correos electrónicos.',
      capabilities: ['sales.outreach'],
      auth: { required: true, kind: 'account', envVars: ['SMTP_URL'] },
      locality: 'remote',
      permissions: ['EXTERNAL_ACTION'],
      risk: 'high',
      version: '0.1.0',
      timeoutMs: SEC(30),
      limits: { maxCallsPerRun: 5, maxInputBytes: 64_000 },
      status: 'NOT_CONNECTED',
      detail: 'No hay ninguna cuenta de correo conectada. Cada envío exigiría aprobación.',
    }),
    tool({
      id: 'automation.scheduler',
      name: 'Planificador',
      category: 'automation',
      description: 'Ejecuta una misión de forma programada o al producirse un disparador.',
      capabilities: ['automation.workflows'],
      permissions: ['READ', 'EXECUTE'],
      risk: 'medium',
      version: '0.1.0',
      timeoutMs: SEC(10),
      limits: { maxCallsPerRun: 20, maxInputBytes: 8_000 },
      status: 'PLANNED',
      detail: 'Todavía no hay planificador.',
    }),

    // ---- Computer use ----
    tool({
      id: 'computer_use.browser',
      name: 'Control del navegador',
      category: 'computer_use',
      description: 'Opera un sitio web a través de un navegador cuando no hay API. Sigue el ciclo observar, planificar, actuar, verificar y recuperarse.',
      capabilities: ['browser.automation'],
      permissions: ['READ', 'EXTERNAL_ACTION'],
      risk: 'high',
      version: '0.1.0',
      timeoutMs: MIN(2),
      limits: { maxCallsPerRun: 60, maxInputBytes: 8_000 },
      status: 'NOT_CONNECTED',
      detail: 'El ciclo y el puerto de controlador existen; no hay ningún controlador conectado. Solo para plataformas que permiten la automatización.',
    }),
    tool({
      id: 'computer_use.desktop',
      name: 'Control del escritorio',
      category: 'computer_use',
      description: 'Opera una aplicación de escritorio observando la pantalla y actuando.',
      capabilities: ['computer.use'],
      permissions: ['READ', 'EXECUTE', 'EXTERNAL_ACTION'],
      risk: 'high',
      version: '0.1.0',
      timeoutMs: MIN(2),
      limits: { maxCallsPerRun: 60, maxInputBytes: 8_000 },
      status: 'NOT_CONNECTED',
      detail: 'El ciclo y el puerto de controlador existen; no hay ningún controlador conectado.',
    }),
  ];
}

export function createToolRegistry(): ToolRegistry {
  return new ToolRegistry(defaultToolSpecs());
}
