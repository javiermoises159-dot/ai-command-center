/**
 * The tool pipeline.
 *
 * Every tool call an agent makes goes through here, and only here. A call is
 * either executed or refused *with a structured reason* — there is no third
 * outcome in which it quietly disappears.
 *
 *   agent
 *     → permission     may this action happen at all? (BLOCK stops it; ASK needs an approval)
 *     → lookup         does the tool exist?
 *     → enabled        has an operator switched it off?
 *     → availability   is anything actually connected behind it?
 *     → validation     does the input satisfy the tool's schema and size ceiling?
 *     → call limit     has this run used up the tool's `maxCallsPerRun`?
 *     → cost           does it fit the budget — the per-tool ceiling included?
 *     → executor       is there an implementation?
 *     → execution      run it, under the tool's own timeout
 *     → result         recorded in the cost ledger and the audit trail
 *
 * "Lookup" comes before "enabled" on purpose: a tool that does not exist is not
 * a disabled tool, and saying so would send the operator looking for a switch
 * that is not there. Permission comes first because whether an action may
 * happen does not depend on whether anyone built it.
 *
 * Every refusal is a failed `ToolResult` that names the stage and a machine
 * readable code, is written to the audit log (and so shows up in the trace),
 * and carries a sentence the agent can be given: the step's prompt includes
 * it, so the model is told what it does not have instead of inventing it.
 */

import type { AuditLog } from '../audit.ts';
import type { CostController } from '../cost/controller.ts';
import type { PermissionPolicy } from '../permissions/policy.ts';
import type { ToolRegistry } from '../registry/tools.ts';
import type { PermissionLevel, ToolErrorCode, ToolRequest, ToolResult, ToolStage } from '../types.ts';
import { unique } from '../util.ts';
import type { ToolExecutor } from './executor.ts';

export interface ToolCall {
  request: ToolRequest;
  missionId: string;
  runId: string;
  stepId: string;
  agentId: string;
  /** True when a person has approved this step, so an ASK permission is satisfied. */
  approved: boolean;
  signal?: AbortSignal;
}

export interface ToolPipelineDeps {
  tools: ToolRegistry;
  policy: PermissionPolicy;
  cost: CostController;
  audit: AuditLog;
  executor: ToolExecutor;
}

/** How each stage is named in a message a person reads. */
export const TOOL_STAGE_LABEL: Record<ToolStage, string> = {
  permission: 'permisos',
  lookup: 'búsqueda de la herramienta',
  enabled: 'interruptor del operador',
  availability: 'disponibilidad',
  validation: 'validación de la entrada',
  call_limit: 'límite de llamadas',
  cost: 'control de coste',
  executor: 'ejecutor',
  execution: 'ejecución',
};

class ToolTimeoutError extends Error {
  constructor(readonly toolId: string, readonly timeoutMs: number) {
    super(`La herramienta «${toolId}» no respondió en ${timeoutMs} ms.`);
    this.name = 'ToolTimeoutError';
  }
}

export class ToolPipeline {
  constructor(private readonly d: ToolPipelineDeps) {}

  /** Never rejects. */
  async run(call: ToolCall): Promise<ToolResult> {
    const startedAt = Date.now();
    const { request } = call;
    const { tools, policy, cost } = this.d;
    const ids = { missionId: call.missionId, runId: call.runId, stepId: call.stepId };
    const refuse = (stage: ToolStage, code: ToolErrorCode, error: string): Promise<ToolResult> =>
      this.refuse(call, stage, code, error, Date.now() - startedAt, ids);

    try {
      const spec = tools.get(request.toolId);
      const name = spec?.name ?? request.toolId;

      // ---- permission ------------------------------------------------------
      // Every level the tool demands, plus the one the plan asked for.
      const levels: PermissionLevel[] = unique([request.permission, ...(spec?.permissions ?? [])]);
      for (const level of levels) {
        const decision = policy.evaluate({
          level,
          subject: request.toolId,
          description: request.purpose,
          internal: spec?.locality === 'local',
        });
        if (decision.mode === 'BLOCK') {
          return await refuse('permission', 'permission_denied', `Permiso denegado para «${name}»: ${decision.reason}`);
        }
        if (decision.mode === 'ASK' && !call.approved) {
          return await refuse('permission', 'approval_required', `«${name}» necesita la aprobación de una persona y no la tiene: ${decision.reason}`);
        }
      }

      // ---- lookup ----------------------------------------------------------
      if (spec === undefined) {
        return await refuse('lookup', 'unknown_tool', `No existe ninguna herramienta con el id «${request.toolId}».`);
      }

      // ---- enabled ---------------------------------------------------------
      if (!tools.isEnabled(spec.id)) {
        const why = tools.disabledReason(spec.id);
        return await refuse('enabled', 'tool_disabled', `«${spec.name}» está deshabilitada${why !== null ? `: ${why}` : ' por un operador.'}`);
      }

      // ---- availability ----------------------------------------------------
      if (!tools.isUsable(spec.id)) {
        return await refuse('availability', 'tool_unavailable', `«${spec.name}» no se puede usar ahora (${spec.status}): ${spec.statusDetail}`);
      }

      // ---- validation ------------------------------------------------------
      const explained = tools.explainInvalidInput(spec.id, request.input);
      if (explained !== null) return await refuse('validation', 'invalid_input', explained);

      // ---- call limit ------------------------------------------------------
      const limit = spec.limits.maxCallsPerRun;
      if (limit !== null) {
        const used = (await cost.summary({ runId: call.runId })).byTool[spec.id]?.calls ?? 0;
        if (used >= limit) {
          return await refuse('call_limit', 'call_limit_exceeded', `«${spec.name}» ya se ha llamado ${used} ${used === 1 ? 'vez' : 'veces'} en esta ejecución y su límite es ${limit}.`);
        }
      }

      // ---- cost ------------------------------------------------------------
      // A free tool costs nothing; every other tool has an unknown price, and an
      // unknown price is never assumed to be zero. With no budget in force the
      // call is allowed and recorded as unpriced; with one, it is refused.
      const estimatedUsd = spec.cost.model === 'free' ? 0 : null;
      const check = await cost.check({
        missionId: call.missionId,
        agentId: call.agentId,
        providerId: spec.id,
        toolId: spec.id,
        estimatedUsd,
      });
      if (!check.allowed) {
        return await refuse('cost', 'cost_blocked', check.reason ?? `«${spec.name}» no cabe en el presupuesto.`);
      }
      for (const alert of check.alerts) {
        await this.d.audit.record('cost', 'cost.alert', alert.message, ids, { toolId: spec.id, scope: alert.scope, usedFraction: alert.usedFraction });
      }

      // ---- executor --------------------------------------------------------
      if (!this.d.executor.canRun(spec.id)) {
        return await refuse('executor', 'no_executor', `«${spec.name}» está declarada pero no tiene ejecutor en esta versión.`);
      }

      // ---- execution -------------------------------------------------------
      let result: ToolResult;
      const timeout = new AbortController();
      const timer = setTimeout(() => timeout.abort(new ToolTimeoutError(spec.id, spec.timeoutMs)), spec.timeoutMs);
      const signal = call.signal === undefined ? timeout.signal : AbortSignal.any([call.signal, timeout.signal]);
      try {
        result = await raceAbort(this.d.executor.execute(request, { missionId: call.missionId, runId: call.runId, stepId: call.stepId, signal }), signal);
      } catch (error) {
        if (timeout.signal.aborted) {
          result = failed(request, 'execution', 'timeout', `«${spec.name}» no respondió en ${spec.timeoutMs} ms.`);
        } else if (call.signal?.aborted === true) {
          result = failed(request, 'execution', 'cancelled', `La llamada a «${spec.name}» se canceló.`);
        } else {
          result = failed(request, 'execution', 'execution_error', `«${spec.name}» falló al ejecutarse: ${error instanceof Error ? error.message : String(error)}`);
        }
      } finally {
        clearTimeout(timer);
      }

      // ---- result ----------------------------------------------------------
      const durationMs = Date.now() - startedAt;
      const finished: ToolResult = { ...result, durationMs };
      // A call that reached the executor is a call, whether or not it worked.
      await cost.record({
        missionId: call.missionId,
        runId: call.runId,
        stepId: call.stepId,
        agentId: call.agentId,
        kind: 'tool',
        provider: spec.id,
        actualUsd: spec.cost.model === 'free' ? 0 : null,
        latencyMs: durationMs,
      });
      await this.d.audit.record(
        'tool',
        'tool.executed',
        finished.ok ? `${spec.id}: correcto (${durationMs} ms).` : `${spec.id}: falló — ${finished.error ?? 'sin detalle'}`,
        ids,
        { toolId: spec.id, ok: finished.ok, stage: finished.stage ?? null, code: finished.code ?? null, durationMs },
      );
      return finished;
    } catch (error) {
      // The pipeline's own machinery failed (the ledger, the audit store). That
      // is still a structured refusal, never an exception into the engine.
      return failed(request, 'execution', 'execution_error', `La llamada a «${request.toolId}» no se pudo completar: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private async refuse(
    call: ToolCall,
    stage: ToolStage,
    code: ToolErrorCode,
    error: string,
    durationMs: number,
    ids: { missionId: string; runId: string; stepId: string },
  ): Promise<ToolResult> {
    await this.d.audit.record(
      'tool',
      'tool.refused',
      `«${call.request.toolId}» rechazada (${TOOL_STAGE_LABEL[stage]}): ${error}`,
      ids,
      { toolId: call.request.toolId, stage, code, required: call.request.required },
    );
    return { ...failed(call.request, stage, code, error), durationMs };
  }
}

function failed(request: ToolRequest, stage: ToolStage, code: ToolErrorCode, error: string): ToolResult {
  return { toolId: request.toolId, requestId: request.id, ok: false, output: null, error, verified: false, stage, code };
}

/** Settle with `promise`, or reject as soon as `signal` aborts, whichever comes first. */
function raceAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => reject(signal.reason instanceof Error ? signal.reason : new Error('La llamada se abortó.'));
    if (signal.aborted) {
      onAbort();
      return;
    }
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort));
  });
}
