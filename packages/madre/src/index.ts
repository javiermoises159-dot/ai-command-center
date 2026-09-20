/**
 * @acc/madre — the MADRE core.
 *
 * Mission Compiler, Planner, Smart Router, registries, execution engine,
 * QA judge, memory, permissions, cost control and the engines built on them.
 * Nothing here talks to a network; providers and tools arrive through ports.
 */

export * from './types.ts';
export { createMadre, MadreService, MadreNotFoundError, type Madre, type MadreConfig, type CompilePreview, type Overview } from './service.ts';
export { MadreEngine, type EngineOptions, type EngineOutcome } from './execution/engine.ts';
export { ProviderStepRunner, type StepRunner, type StepRunInput, type StepRunOutput } from './execution/runner.ts';
export { RulesPlanner, type Planner } from './compiler/planner.ts';
export { compileMission } from './compiler/compile.ts';
export { EXAMPLE_MISSIONS } from './fixtures/missions.ts';
export { SmartRouter } from './router/router.ts';
export { RulesJudge, type Judge } from './qa/judge.ts';
export { HUMAN_WRITING_GUIDE, lintProse } from './qa/prose.ts';
export { AgentRegistry, createAgentRegistry } from './registry/agents.ts';
export { ToolRegistry, createToolRegistry } from './registry/tools.ts';
export { ProviderCatalog, profileLocalModel } from './registry/providers.ts';
export { PermissionPolicy } from './permissions/policy.ts';
export { ApprovalService, ApprovalError } from './permissions/approvals.ts';
export { CostController, DEFAULT_ALERT_AT_FRACTION, NO_BUDGET, type PriceTable } from './cost/controller.ts';
export { MemoryService } from './memory/service.ts';
export { AuditLog } from './audit.ts';
export { ToolPipeline, TOOL_STAGE_LABEL, type ToolCall } from './tools/pipeline.ts';
export { LocalToolExecutor, IMPLEMENTED_TOOLS, type ToolExecutor } from './tools/executor.ts';
export { validateToolInput } from './registry/validation.ts';
export { MadreStore, KINDS } from './store.ts';
export { buildWorldModel } from './world/builder.ts';
export { LocalSandbox, SandboxError } from './sandbox/local-sandbox.ts';
export { runComputerUseLoop, NotConnectedDriver, chooseInterface, type ComputerDriver } from './computer-use/loop.ts';
export * from './pipelines/content.ts';
export * from './pipelines/media.ts';
export * from './pipelines/faceless.ts';
export type { PipelineReport, StageReadiness, StageSpec } from './pipelines/stages.ts';
export * from './growth/affiliate.ts';
export * from './trading/simulation.ts';
export * from './research/engine.ts';
export * from './business/opportunity.ts';
export * from './reverse/visual.ts';
export * from './profiles/multi-profile.ts';

export { RunRecovery, isUnsettled, type RecoveryReport, type RecoveredRun } from './execution/recovery.ts';
export { ClassicPlanner, CLASSIC_PLANNER_ID } from './compiler/classic.ts';
