/**
 * Computer-use architecture.
 *
 * The rule is API first: operating a screen is the fallback when no API, tool
 * or connector can do the job. When a screen must be operated, the loop is
 *
 *     OBSERVE → PLAN → ACT → OBSERVE → VERIFY → RECOVER
 *
 * with a bounded number of steps, a memory of what it has seen, stuck
 * detection, per-action permission checks, and an approval hook for anything
 * that leaves the machine or moves money.
 *
 * No driver is connected in this build. `NotConnectedDriver` says so instead
 * of pretending. The loop never targets a platform unless the operator has
 * attested that automation there is permitted; MADRE does not decide that for
 * anyone, and it does nothing to hide that it is automated.
 */

import type { PermissionLevel, PermissionRequest } from '../types.ts';
import { hash, sleep } from '../util.ts';
import type { PermissionPolicy } from '../permissions/policy.ts';

// ---------------------------------------------------------------------------
// Ports
// ---------------------------------------------------------------------------

export interface Observation {
  /** What the screen or page shows, as text a planner can read. */
  text: string;
  /** Where the driver is: a URL, a window title, an app name. */
  location: string;
  at: string;
}

export type UiAction =
  | { kind: 'navigate'; target: string }
  | { kind: 'click'; target: string }
  | { kind: 'type'; target: string; text: string }
  | { kind: 'scroll'; direction: 'up' | 'down' }
  | { kind: 'wait'; ms: number }
  | { kind: 'read'; target: string };

export interface ComputerDriver {
  readonly id: string;
  readonly connected: boolean;
  observe(): Promise<Observation>;
  act(action: UiAction): Promise<void>;
}

/** Mensaje único para cuando no hay ningún controlador conectado. */
export const NO_DRIVER = 'No hay ningún controlador de uso del ordenador conectado en esta versión.';

export class NotConnectedDriver implements ComputerDriver {
  readonly id = 'none';
  readonly connected = false;
  observe(): Promise<Observation> {
    return Promise.reject(new Error(NO_DRIVER));
  }
  act(): Promise<void> {
    return Promise.reject(new Error(NO_DRIVER));
  }
}

/** Decides the next action from what it has seen. A model-backed planner implements this. */
export interface UiPlanner {
  next(input: { goal: string; observation: Observation; history: readonly TraceEntry[]; recovering: boolean }): Promise<UiAction | { kind: 'done'; summary: string } | { kind: 'give_up'; reason: string }>;
}

/** Says whether the goal has been reached, from the screen. */
export type Verifier = (observation: Observation) => boolean | Promise<boolean>;

// ---------------------------------------------------------------------------
// Interface choice: API first
// ---------------------------------------------------------------------------

export type InterfaceChoice =
  | { via: 'api'; toolId: string; reason: string }
  | { via: 'browser' | 'desktop'; reason: string }
  | { via: 'none'; reason: string };

export interface ChooseInput {
  /** Usable tools that could do the job through an API or connector. */
  apiTools: readonly string[];
  surface: 'web' | 'desktop';
  /** Platform name, checked against the operator's attestations. */
  platform: string | null;
  /** Operator-attested platforms where automation is permitted. */
  automationAttested: readonly string[];
  driverConnected: boolean;
}

export function chooseInterface(input: ChooseInput): InterfaceChoice {
  const api = input.apiTools[0];
  if (api !== undefined) return { via: 'api', toolId: api, reason: 'Existe una API o un conector, así que no hace falta manejar ninguna pantalla.' };
  if (input.platform !== null && !input.automationAttested.map((p) => p.toLowerCase()).includes(input.platform.toLowerCase())) {
    return { via: 'none', reason: `No se ha confirmado que las normas de "${input.platform}" permitan automatizarla, así que no se intentará.` };
  }
  if (!input.driverConnected) return { via: 'none', reason: NO_DRIVER };
  return { via: input.surface === 'web' ? 'browser' : 'desktop', reason: 'No hay ninguna API disponible y la automatización está permitida.' };
}

// ---------------------------------------------------------------------------
// Action risk
// ---------------------------------------------------------------------------

const MONEY_TARGET = /\b(?:pay|purchase|buy|checkout|order now|place order|donate|transfer|subscribe|pagar|comprar|finalizar compra|suscribir|acquista|paga)\b/i;
const PUBLISH_TARGET = /\b(?:publish|post|tweet|share|send|submit|publicar|enviar|pubblica|invia)\b/i;
const DELETE_TARGET = /\b(?:delete|remove|erase|eliminar|borrar|elimina|cancella)\b/i;

export function permissionForAction(action: UiAction): PermissionRequest {
  const label = 'target' in action ? action.target : action.kind;
  let level: PermissionLevel = 'READ';
  if (action.kind === 'click' || action.kind === 'type') {
    level = 'EXTERNAL_ACTION';
    if (MONEY_TARGET.test(label) || (action.kind === 'type' && MONEY_TARGET.test(action.text))) level = 'FINANCIAL';
    else if (PUBLISH_TARGET.test(label)) level = 'PUBLISH';
    else if (DELETE_TARGET.test(label)) level = 'DELETE';
  }
  if (action.kind === 'navigate') level = 'READ';
  return { level, subject: `${action.kind}:${label}`.slice(0, 120), description: `${action.kind} ${label}`.slice(0, 160) };
}

// ---------------------------------------------------------------------------
// The loop
// ---------------------------------------------------------------------------

export interface TraceEntry {
  step: number;
  phase: 'observe' | 'plan' | 'act' | 'verify' | 'recover';
  detail: string;
  at: string;
}

export interface ComputerUseResult {
  status: 'done' | 'gave_up' | 'step_limit' | 'refused' | 'aborted' | 'error';
  summary: string;
  steps: number;
  trace: TraceEntry[];
}

export interface LoopDeps {
  driver: ComputerDriver;
  planner: UiPlanner;
  verify: Verifier;
  policy: PermissionPolicy;
  /** Called for ASK actions. Return true to allow. With no hook, ASK is treated as a refusal. */
  approve?: (action: UiAction, request: PermissionRequest) => Promise<boolean>;
  now?: () => Date;
  wait?: (ms: number, signal?: AbortSignal) => Promise<void>;
}

export interface LoopOptions {
  goal: string;
  maxSteps?: number;
  /** Consecutive identical observations before the loop tries to recover. */
  stuckAfter?: number;
  /** Recovery attempts before giving up. */
  maxRecoveries?: number;
  memory?: number;
  signal?: AbortSignal;
}

export async function runComputerUseLoop(deps: LoopDeps, options: LoopOptions): Promise<ComputerUseResult> {
  const maxSteps = options.maxSteps ?? 20;
  const stuckAfter = options.stuckAfter ?? 3;
  const maxRecoveries = options.maxRecoveries ?? 2;
  const keep = options.memory ?? 12;
  const now = deps.now ?? (() => new Date());
  const wait = deps.wait ?? sleep;
  const trace: TraceEntry[] = [];
  const log = (step: number, phase: TraceEntry['phase'], detail: string): void => {
    trace.push({ step, phase, detail: detail.slice(0, 300), at: now().toISOString() });
    if (trace.length > 400) trace.splice(0, trace.length - 400);
  };

  if (!deps.driver.connected) {
    return { status: 'refused', summary: NO_DRIVER, steps: 0, trace };
  }

  let step = 0;
  let recoveries = 0;
  let recovering = false;
  let lastHash = '';
  let sameCount = 0;

  try {
    while (step < maxSteps) {
      if (options.signal?.aborted) return { status: 'aborted', summary: 'Detenido a petición.', steps: step, trace };
      step += 1;

      // OBSERVE
      const observation = await deps.driver.observe();
      log(step, 'observe', `${observation.location}: ${observation.text.slice(0, 120)}`);

      // VERIFY: has the goal already been reached?
      if (await deps.verify(observation)) {
        log(step, 'verify', 'El objetivo se ve en pantalla.');
        return { status: 'done', summary: 'El objetivo se ha verificado en pantalla.', steps: step, trace };
      }

      // Stuck detection: the same screen again and again means the last actions did nothing.
      const h = hash(`${observation.location}|${observation.text}`);
      sameCount = h === lastHash ? sameCount + 1 : 1;
      lastHash = h;
      if (sameCount >= stuckAfter) {
        recoveries += 1;
        log(step, 'recover', `La pantalla no cambia desde hace ${sameCount} ${sameCount === 1 ? 'paso' : 'pasos'} (recuperación ${recoveries}/${maxRecoveries}).`);
        if (recoveries > maxRecoveries) return { status: 'gave_up', summary: 'La pantalla dejó de cambiar y la recuperación no sirvió.', steps: step, trace };
        recovering = true;
        sameCount = 0;
      }

      // PLAN
      const decision = await deps.planner.next({ goal: options.goal, observation, history: trace.slice(-keep), recovering });
      recovering = false;
      if (decision.kind === 'done') {
        // The planner may claim success; the screen must agree.
        const after = await deps.driver.observe();
        if (await deps.verify(after)) return { status: 'done', summary: decision.summary, steps: step, trace };
        log(step, 'verify', 'El planificador dijo que había terminado, pero la pantalla no muestra el objetivo.');
        recovering = true;
        recoveries += 1;
        if (recoveries > maxRecoveries) return { status: 'gave_up', summary: 'No se pudo verificar el objetivo en pantalla.', steps: step, trace };
        continue;
      }
      if (decision.kind === 'give_up') {
        log(step, 'plan', `Se abandona: ${decision.reason}`);
        return { status: 'gave_up', summary: decision.reason, steps: step, trace };
      }
      log(step, 'plan', `${decision.kind} ${'target' in decision ? decision.target : ''}`);

      // ACT, after the permission check.
      const request = permissionForAction(decision);
      const verdict = deps.policy.evaluate(request);
      if (verdict.mode === 'BLOCK') {
        log(step, 'act', `Bloqueado: ${verdict.reason}`);
        return { status: 'refused', summary: verdict.reason, steps: step, trace };
      }
      if (verdict.mode === 'ASK') {
        const allowed = deps.approve !== undefined ? await deps.approve(decision, request) : false;
        if (!allowed) {
          log(step, 'act', `Sin aprobar: ${request.description}`);
          return { status: 'refused', summary: `Una persona debe aprobar antes esta acción: ${request.description}.`, steps: step, trace };
        }
      }
      if (decision.kind === 'wait') await wait(Math.min(decision.ms, 10_000), options.signal);
      else await deps.driver.act(decision);
      log(step, 'act', `Acción ${decision.kind} completada`);
    }
    return { status: 'step_limit', summary: `Detenido tras ${maxSteps} ${maxSteps === 1 ? 'paso' : 'pasos'} sin alcanzar el objetivo.`, steps: step, trace };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log(step, 'recover', `Error: ${message}`);
    return { status: options.signal?.aborted ? 'aborted' : 'error', summary: message, steps: step, trace };
  }
}
