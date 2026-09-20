/**
 * MADRE contracts.
 *
 * Every artefact MADRE produces or consumes is declared here, in one file with
 * no imports. Two consequences follow from that:
 *
 *  - the web app can share these types (through `@acc/contracts`) without
 *    pulling in Node-only code;
 *  - everything is plain JSON: timestamps are ISO strings, no class instances,
 *    so a plan or a run state can be stored as a document and read back
 *    unchanged.
 *
 * Vocabulary
 * ----------
 * MissionIntent   what the user seems to want, classified from their words.
 * CompiledMission the intent unpacked into objective, context, constraints,
 *                 tasks and verification criteria — with provenance on every
 *                 statement, so a guess is never presented as a fact.
 * MissionPlan     the compiled mission scheduled as steps with dependencies.
 * MissionStep     one unit of work in the plan (an agent task, QA, integration,
 *                 or a request for human input).
 * RoutingDecision which agent, provider and tools a step will use, and why.
 * ExecutionResult what a step produced, with cost and provenance.
 * QAResult        the independent judge's verdict.
 * MemoryEntry     something worth remembering, with its source and confidence.
 */

// ---------------------------------------------------------------------------
// Provenance
// ---------------------------------------------------------------------------

/**
 * Where a statement comes from. This is the backbone of the "do not invent
 * facts" rule: a statement is only `verified` when a source backs it.
 *
 *  user_provided    the user said it.
 *  model_knowledge  general knowledge that a model may hold; not checked.
 *  hypothesis       a reasonable guess that needs testing.
 *  needs_research   a question that must be answered before relying on it.
 *  verified         confirmed against a named source or a deterministic tool.
 */
export type Provenance = 'user_provided' | 'model_knowledge' | 'hypothesis' | 'needs_research' | 'verified';

export interface Statement {
  text: string;
  provenance: Provenance;
  /** Required when `provenance` is `verified`. */
  source?: string;
}

// ---------------------------------------------------------------------------
// Intent and compiled mission
// ---------------------------------------------------------------------------

export type MissionKind =
  | 'launch_business'
  | 'market_research'
  | 'validation_experiment'
  | 'content_campaign'
  | 'document_analysis'
  | 'product_build'
  | 'growth'
  | 'financial_model'
  | 'general';

export type Language = 'es' | 'en' | 'it' | 'unknown';
export type Complexity = 'simple' | 'moderate' | 'complex';

/** Capability ids are dotted strings, e.g. `research.market`. See registry/capabilities. */
export type Capability = string;

export interface AmountMention {
  raw: string;
  value: number;
  currency: string | null;
}

export interface MissionIntent {
  rawText: string;
  language: Language;
  kind: MissionKind;
  secondaryKinds: MissionKind[];
  complexity: Complexity;
  /** Human-readable reasons behind the complexity call. */
  complexitySignals: string[];
  /** What the mission is about, in the user's own words; null if unclear. */
  subject: string | null;
  /** Extracted verbatim from the text. Nothing here is inferred. */
  mentions: {
    places: string[];
    timeframes: string[];
    amounts: AmountMention[];
  };
  needsFreshInformation: boolean;
  sensitivity: {
    involvesMoney: boolean;
    involvesPublishing: boolean;
    involvesExternalAction: boolean;
    involvesPersonalData: boolean;
  };
  /** 0..1 — how sure the classification is. Low when few keywords matched. */
  confidence: number;
  /** Questions that would sharpen the mission. Asked, not assumed. */
  ambiguities: string[];
}

export interface VerificationCriterion {
  id: string;
  description: string;
  /** Step ids the criterion applies to; `['*']` means every worker step. */
  appliesTo: string[];
  check: 'coverage' | 'evidence' | 'consistency' | 'actionability' | 'assumptions_labelled';
  severity: 'must' | 'should';
}

export interface Deliverable {
  title: string;
  format: 'markdown';
  sections: string[];
}

/** Something the mission needs that this build cannot provide yet. */
export interface CapabilityGap {
  capability: Capability;
  reason: string;
  /** Registry ids (agents, tools, providers) that would close the gap. */
  needs: string[];
  /** True when the mission cannot be completed honestly without it. */
  blocking: boolean;
}

export interface MissionTask {
  id: string;
  title: string;
  capability: Capability;
  description: string;
  /** Ids of tasks whose output this one uses. */
  after: string[];
  /** `soft` dependencies proceed with whatever the upstream produced, even if it failed. */
  dependency: 'hard' | 'soft';
}

export interface CompiledMission {
  intent: MissionIntent;
  objective: Statement;
  context: Statement[];
  constraints: Statement[];
  desiredOutcome: Statement;
  assumptions: Statement[];
  /** Things to find out. Never answered by the compiler. */
  openQuestions: string[];
  requiredCapabilities: Capability[];
  tasks: MissionTask[];
  verificationCriteria: VerificationCriterion[];
  expectedDeliverable: Deliverable;
}

// ---------------------------------------------------------------------------
// Plan
// ---------------------------------------------------------------------------

export type PermissionLevel = 'READ' | 'WRITE' | 'EXECUTE' | 'EXTERNAL_ACTION' | 'FINANCIAL' | 'PUBLISH' | 'DELETE';
export type PermissionMode = 'AUTO' | 'ASK' | 'BLOCK';

export type StepStatus =
  | 'QUEUED'
  | 'RUNNING'
  | 'WAITING'
  | 'BLOCKED'
  | 'FAILED'
  | 'RETRYING'
  | 'DONE'
  | 'CANCELLED';

export type StepKind = 'agent' | 'qa' | 'integrate' | 'input';

export interface StepDependency {
  stepId: string;
  /**
   * hard  the step cannot run unless the dependency is DONE (otherwise BLOCKED).
   * soft  the step waits for the dependency to settle and uses its output if any.
   */
  mode: 'hard' | 'soft';
}

export interface AgentTask {
  stepId: string;
  agentId: string;
  instruction: string;
  expectedOutput: string;
  constraints: string[];
  requiredCapabilities: Capability[];
  /** 1 (trivial) .. 5 (needs a strong model). Drives provider choice. */
  difficulty: 1 | 2 | 3 | 4 | 5;
  needsFreshInformation: boolean;
  /** Privacy-sensitive input: the router prefers local execution. */
  sensitive: boolean;
}

export interface ToolRequest {
  id: string;
  toolId: string;
  purpose: string;
  input: Record<string, unknown>;
  permission: PermissionLevel;
  /** When false, the step proceeds (and says so) if the tool is unavailable. */
  required: boolean;
}

export interface MissionStep {
  id: string;
  title: string;
  kind: StepKind;
  agentId: string;
  capability: Capability;
  dependsOn: StepDependency[];
  task: AgentTask;
  toolRequests: ToolRequest[];
  /** Ids from `CompiledMission.verificationCriteria`. */
  verification: string[];
  maxAttempts: number;
}

export interface MissionPlan {
  id: string;
  missionId: string | null;
  version: number;
  createdAt: string;
  planner: string;
  compiled: CompiledMission;
  steps: MissionStep[];
  /** Steps that may run together once their dependencies are met, in waves. */
  parallelGroups: string[][];
  gaps: CapabilityGap[];
  /**
   * Things the planner could not do the way the mission would like, said
   * plainly — for example a tool it could not build a valid input for. Optional
   * so plans stored before this field existed still load.
   */
  warnings?: string[];
}

// ---------------------------------------------------------------------------
// Registries: agents, providers, tools
// ---------------------------------------------------------------------------

export type CostClass = 'free' | 'low' | 'medium' | 'high';
export type RiskLevel = 'low' | 'medium' | 'high' | 'critical';

/** `planned` agents are declared so the architecture is visible; they never run. */
export type AgentStatus = 'active' | 'planned' | 'disabled';

export interface AgentSpec {
  id: string;
  name: string;
  description: string;
  kind: 'worker' | 'qa' | 'integrator';
  /** The id of the executing agent in `@acc/domain`, when one exists. */
  legacyAgentId: string | null;
  capabilities: Capability[];
  inputs: string[];
  outputs: string[];
  requiredTools: string[];
  optionalTools: string[];
  /** Provider tiers in order of preference. */
  preferredTiers: ProviderTier[];
  minModelQuality: 1 | 2 | 3 | 4 | 5;
  costClass: CostClass;
  status: AgentStatus;
  statusDetail: string;
  permissions: PermissionLevel[];
  maxParallelism: number;
  /** What QA must check on this agent's output. */
  verification: string[];
  risk: RiskLevel;
  accent: string;
  order: number;
}

/**
 * Where a result came from. Mirrors `ResultSource` in `@acc/domain`; declared
 * here because this file has no imports (see the note above).
 */
export type ResultSource = 'real' | 'mock';

/** Mirrors `ProviderErrorCode` in `@acc/domain`. */
export type ProviderErrorCode =
  | 'PROVIDER_UNCONFIGURED'
  | 'PROVIDER_AUTH_FAILED'
  | 'PROVIDER_QUOTA_EXHAUSTED'
  | 'PROVIDER_RATE_LIMITED'
  | 'PROVIDER_TIMEOUT'
  | 'PROVIDER_UNAVAILABLE'
  | 'PROVIDER_BAD_REQUEST'
  | 'PROVIDER_INVALID_RESPONSE'
  | 'PROVIDER_CAPABILITY_MISMATCH'
  | 'PROVIDER_CIRCUIT_OPEN'
  | 'PROVIDER_COST_UNKNOWN'
  | 'PROVIDER_CANCELLED'
  | 'PROVIDER_FAILED';

/** Mirrors `ProviderErrorInfo` in `@acc/domain`. Never holds a secret. */
export interface ProviderErrorInfo {
  code: ProviderErrorCode;
  stage: 'config' | 'routing' | 'cost' | 'capability' | 'request' | 'response';
  provider: string | null;
  model: string | null;
  retryable: boolean;
  /** Spanish, safe to show. */
  message: string;
  /** The underlying reason, already scrubbed of credentials. */
  cause: string | null;
}

export type ProviderTier = 'local' | 'local_strong' | 'external' | 'specialized' | 'mock';
/**
 * `UNCONFIGURED` is an implemented provider that lacks its key or model;
 * `NOT_CONNECTED` is one with nothing behind it yet (a declared stub, or a local
 * server that is not there); `DISABLED` is one the operator switched off.
 */
export type ProviderStatus = 'CONNECTED' | 'NOT_CONNECTED' | 'UNCONFIGURED' | 'DISABLED' | 'MOCK' | 'LOCAL' | 'ERROR';

/**
 * What a model can do, beyond producing text.
 *
 * These are declarations by the adapter, not probes: an adapter states what the
 * vendor documents. A capability a model does not have is `false`, never
 * omitted, so the router can require one without guessing.
 */
export interface ModelCapabilities {
  streaming: boolean;
  toolCalling: boolean;
  structuredOutput: boolean;
  embeddings: boolean;
  vision: boolean;
}

/** Hard ceilings the caller must respect. `null` = not published by the vendor. */
export interface ModelLimits {
  maxOutputTokens: number | null;
  requestsPerMinute: number | null;
  tokensPerMinute: number | null;
}

export interface ModelProfile {
  id: string;
  label: string;
  tier: ProviderTier;
  /** 1..5, a coarse editorial rating. Not a benchmark. */
  quality: 1 | 2 | 3 | 4 | 5;
  contextWindow: number | null;
  /** null = unknown. MADRE never guesses a price. */
  pricePer1kInputUsd: number | null;
  pricePer1kOutputUsd: number | null;
  typicalLatencyMs: number | null;
  /** True only when the model can use live information (search, browsing). */
  liveInformation: boolean;
  capabilities: ModelCapabilities;
  limits: ModelLimits;
}

/**
 * The outcome of asking a provider whether it is reachable *now*.
 *
 * `unknown` means nobody has checked yet; `not_connected` means there is
 * nothing to check because the provider has no credentials or no endpoint. A
 * provider is never reported healthy because its configuration looks complete.
 */
export type ProviderHealthStatus = 'ok' | 'degraded' | 'down' | 'not_connected' | 'unknown';

export interface ProviderHealth {
  status: ProviderHealthStatus;
  /** ISO timestamp of the check, or null when it has never run. */
  checkedAt: string | null;
  latencyMs: number | null;
  detail: string;
}

export interface ProviderProfile {
  id: string;
  label: string;
  status: ProviderStatus;
  statusDetail: string;
  tier: ProviderTier;
  privacy: 'on_device' | 'third_party' | 'simulated';
  models: ModelProfile[];
  /** What is needed to connect it. */
  requires: string | null;
  /** True when the server can actually execute tasks with it right now. */
  executable: boolean;
  /**
   * The states behind `executable`, kept apart because they are different
   * questions: is there an implementation (`implemented`), does it have its
   * credentials (`configured`), can it be called (`available`), has the
   * operator left it on (`enabled`), and did it answer a probe (`healthy`).
   * A provider is never `healthy` because it is `configured`.
   */
  implemented: boolean;
  configured: boolean;
  available: boolean;
  enabled: boolean;
  /** `true` after an `ok` probe, `false` after `down`/`degraded`, `null` when nobody has checked. */
  healthy: boolean | null;
  /** `mock` for the simulation; `real` for anything that actually runs a model. */
  source: ResultSource;
  /** Last known reachability. Updated by `checkProviderHealth`, never assumed. */
  health: ProviderHealth;
  /**
   * The circuit breaker's view of this provider: null while it has no record.
   * Filled in by the service from the router, which owns the breaker.
   */
  circuit?: CircuitState | null;
}

export type ToolStatus = 'AVAILABLE' | 'CONNECTED' | 'MOCK' | 'PLANNED' | 'NOT_CONNECTED' | 'DISABLED';

export type ToolCategory =
  | 'research'
  | 'creation'
  | 'development'
  | 'files'
  | 'communication'
  | 'automation'
  | 'media'
  | 'analytics'
  | 'distribution'
  | 'computer_use'
  | 'system';

export interface FieldSpec {
  type: 'string' | 'number' | 'boolean' | 'object' | 'array';
  description: string;
  required?: boolean;
  enum?: string[];
}

export interface ToolSchema {
  fields: Record<string, FieldSpec>;
  /**
   * `false` rejects any field the schema does not declare, so a typo in a
   * field name fails loudly instead of being ignored. Absent or `true` lets
   * extra fields through.
   */
  additionalProperties?: boolean;
}

export interface ToolSpec {
  id: string;
  name: string;
  category: ToolCategory;
  description: string;
  capabilities: Capability[];
  /** The service or open-source project behind the tool, when there is one. */
  provider: string | null;
  inputSchema: ToolSchema;
  outputSchema: ToolSchema;
  auth: {
    required: boolean;
    kind: 'none' | 'api_key' | 'oauth' | 'local_service' | 'account';
    envVars: string[];
  };
  cost: { model: 'free' | 'per_call' | 'per_token' | 'subscription' | 'unknown'; note: string };
  locality: 'local' | 'remote' | 'hybrid';
  permissions: PermissionLevel[];
  risk: RiskLevel;
  status: ToolStatus;
  statusDetail: string;
  /** Semver of the tool contract. A breaking schema change bumps the major. */
  version: string;
  /** How long a single call may take before the executor aborts it. */
  timeoutMs: number;
  limits: ToolLimits;
  /**
   * False when an operator has switched the tool off. A disabled tool is never
   * routed to and never executes, whatever its `status` says.
   */
  enabled: boolean;
}

export interface ToolLimits {
  /** Calls allowed within one run. `null` = no ceiling of its own. */
  maxCallsPerRun: number | null;
  /** Size ceiling for the serialised input. `null` = no ceiling of its own. */
  maxInputBytes: number | null;
}

// ---------------------------------------------------------------------------
// Routing
// ---------------------------------------------------------------------------

export interface RoutingDecision {
  stepId: string;
  agentId: string;
  /** Null when the step cannot run (see `blocked`). */
  provider: { id: string; model: string; tier: ProviderTier; status: ProviderStatus } | null;
  fallbacks: { providerId: string; model: string }[];
  tools: { toolId: string; status: ToolStatus; usable: boolean; note: string | null }[];
  execution: 'local' | 'external' | 'simulated' | 'none';
  needsExternalService: boolean;
  requiresApproval: boolean;
  approvalReasons: string[];
  /** 1 = most urgent (on the critical path). */
  priority: number;
  estimatedCostUsd: number | null;
  estimatedLatencyMs: number | null;
  /** 0..1 — how well the chosen route fits what the step needs. */
  confidence: number;
  warnings: string[];
  rationale: string[];
  blocked: {
    reason: string;
    kind: 'agent_planned' | 'provider_missing' | 'tool_missing' | 'privacy' | 'budget';
    /** The structured provider error behind the block, when there is one. */
    code?: ProviderErrorCode;
  } | null;
  /** Structured account of the provider choice. Absent on decisions stored before it existed. */
  explanation?: RouterExplanation;
}

/** Why a candidate was left out. Machine-readable; `reason` carries the words. */
export type ExclusionCode =
  | 'disabled'
  | 'not_implemented'
  | 'unconfigured'
  | 'unavailable'
  | 'unusable'
  | 'circuit_open'
  | 'avoided'
  | 'not_pinned'
  | 'mock_last_resort'
  | 'privacy'
  | 'capability_mismatch'
  | 'quality'
  | 'freshness'
  | 'budget'
  | 'cost_unknown';

export interface RouterCandidate {
  providerId: string;
  model: string;
  tier: ProviderTier;
  source: ResultSource;
  /** Weighted score in 0..1 once the candidate passed every hard requirement. */
  score: number | null;
  /** `null` = the price is unknown; never $0. */
  estimatedCostUsd: number | null;
  /** In the fallback order, after the selected one. */
  selected: boolean;
}

export interface ExcludedCandidate {
  providerId: string;
  /** `null` when the whole provider was excluded, not one of its models. */
  model: string | null;
  code: ExclusionCode;
  /** The structured provider error this exclusion corresponds to, when there is one. */
  errorCode: ProviderErrorCode | null;
  reason: string;
}

/**
 * The router's decision, as data: who was chosen, who else was considered, who
 * was turned away and why. Stored with the step and copied to the audit log, so
 * the trace can answer "why this provider" without re-running the router.
 */
export interface RouterExplanation {
  selectedProvider: string | null;
  selectedModel: string | null;
  candidates: RouterCandidate[];
  excludedCandidates: ExcludedCandidate[];
  reasons: string[];
}

// ---------------------------------------------------------------------------
// Execution
// ---------------------------------------------------------------------------

/**
 * The stages a tool call passes through, in order. A failed call names the
 * stage that stopped it, so "why didn't this run" always has an answer.
 */
export type ToolStage =
  | 'permission'
  | 'lookup'
  | 'enabled'
  | 'availability'
  | 'validation'
  | 'call_limit'
  | 'cost'
  | 'executor'
  | 'execution';

export type ToolErrorCode =
  | 'permission_denied'
  | 'approval_required'
  | 'unknown_tool'
  | 'tool_disabled'
  | 'tool_unavailable'
  | 'invalid_input'
  | 'call_limit_exceeded'
  | 'cost_blocked'
  | 'no_executor'
  | 'timeout'
  | 'cancelled'
  | 'execution_error';

export interface ToolResult {
  toolId: string;
  requestId: string;
  ok: boolean;
  output: Record<string, unknown> | null;
  /** Written for the person (and the agent) reading it: what stopped the call and why. */
  error: string | null;
  /** True when a deterministic computation or a named source backs the output. */
  verified: boolean;
  /** The stage that stopped a failed call. Absent on success and on results stored before the pipeline existed. */
  stage?: ToolStage | null;
  code?: ToolErrorCode | null;
  durationMs?: number;
}

export interface ExecutionResult {
  stepId: string;
  agentId: string;
  status: 'DONE' | 'FAILED';
  text: string;
  provider: string | null;
  model: string | null;
  requestId: string | null;
  promptTokens: number;
  completionTokens: number;
  costUsd: number | null;
  latencyMs: number;
  /**
   * Provenance: `real` for a model that actually ran, `mock` for the
   * simulation. Always set on new results; absent only on results persisted
   * before it existed, which `provenanceOf` derives from the provider id.
   */
  source?: ResultSource;
  simulated?: boolean;
  attempts: number;
  toolResults: ToolResult[];
  /** Notes such as "produced without live sources". Shown next to the result. */
  caveats: string[];
  error: string | null;
}

export interface StepHistoryEntry {
  at: string;
  status: StepStatus;
  note: string;
}

export interface StepState {
  stepId: string;
  status: StepStatus;
  attempts: number;
  revisions: number;
  startedAt: string | null;
  completedAt: string | null;
  routing: RoutingDecision | null;
  result: ExecutionResult | null;
  error: string | null;
  blockedReason: string | null;
  /** Approval id when WAITING. */
  waitingFor: string | null;
  /** The legacy `mission_agents` row mirrored by this step, when there is one. */
  executionId: string | null;
  history: StepHistoryEntry[];
  /**
   * Every tool call made for this step, successful or not. Kept here (and not
   * only on the result) so a step that ended FAILED or BLOCKED still shows
   * which tool calls were refused and why.
   */
  toolResults?: ToolResult[];
  /** True when the step ended FAILED because the process died while it ran. */
  interrupted?: boolean;
  /** The structured error that ended (or last interrupted) the step's provider calls. */
  providerError?: ProviderErrorInfo | null;
}

export type RunPhase = 'planning' | 'executing' | 'paused' | 'reviewing' | 'completed' | 'failed' | 'cancelled';

/** How a run is executed. Both go through the same engine and the same controls. */
export type RunMode = 'madre' | 'classic';

/**
 * What boot-time recovery decided about a run that was found unfinished.
 *
 *  completed    the persisted state proves the run had finished; only its closing was missing
 *  interrupted  the process died mid-run; nothing after the last persisted step is assumed
 *  failed       the run had already failed; recovery only closed the loose ends
 *  cancelled    the run had already been cancelled
 */
export type RecoveryOutcome = 'completed' | 'interrupted' | 'failed' | 'cancelled';

export interface RunRecoveryRecord {
  at: string;
  outcome: RecoveryOutcome;
  /** A new run of the mission can pick the work up. False when there is nothing to redo. */
  retryable: boolean;
  /** Why recovery did what it did, in plain words. */
  reason: string;
  /** Every step whose status recovery changed. */
  steps: { stepId: string; from: StepStatus; to: StepStatus }[];
}

export interface Blocker {
  stepId: string | null;
  kind: 'approval' | 'input' | 'tool_missing' | 'provider_missing' | 'budget' | 'dependency' | 'agent_planned' | 'error';
  reason: string;
  resolution: string;
}

export interface NextAction {
  kind:
    | 'approve'
    | 'provide_input'
    | 'run_research'
    | 'revise'
    | 'validate_assumption'
    | 'connect_tool'
    | 'connect_provider'
    | 'review_result'
    | 'retry'
    | 'none';
  title: string;
  detail: string;
}

export interface MadreRunState {
  runId: string;
  missionId: string;
  planId: string;
  phase: RunPhase;
  steps: StepState[];
  qaRounds: QAResult[];
  cost: CostSummary;
  blockers: Blocker[];
  nextAction: NextAction | null;
  /** 0..1, or null until enough has run. Combines routing fit and QA. */
  confidence: number | null;
  startedAt: string | null;
  updatedAt: string;
  completedAt: string | null;
  cancelRequested: boolean;
  /** Which planner made the plan. Absent on runs stored before classic mode ran through the engine: those are `madre`. */
  mode?: RunMode;
  /** Set when boot-time recovery had to close or repair this run. */
  recovery?: RunRecoveryRecord;
}

// ---------------------------------------------------------------------------
// QA / judge
// ---------------------------------------------------------------------------

export type QAVerdict = 'PASS' | 'PASS_WITH_WARNINGS' | 'NEEDS_REVISION' | 'BLOCKED';

export type QACategory =
  | 'responds_to_mission'
  | 'requirements'
  | 'unverified_data'
  | 'contradiction'
  | 'incomplete'
  | 'actionability'
  | 'needs_research'
  | 'hypothesis_as_fact'
  | 'style';

export interface QAIssue {
  id: string;
  category: QACategory;
  severity: 'info' | 'warning' | 'major' | 'blocker';
  stepId: string | null;
  agentId: string | null;
  message: string;
  evidence: string | null;
  suggestion: string | null;
}

export interface QAChecklistItem {
  question: string;
  answer: 'yes' | 'partial' | 'no' | 'n/a';
  note: string | null;
}

export interface QAResult {
  id: string;
  stage: 'workers' | 'final';
  round: number;
  verdict: QAVerdict;
  issues: QAIssue[];
  checklist: QAChecklistItem[];
  revisionRequests: { stepId: string; instruction: string; issueIds: string[] }[];
  summary: string;
  judge: { id: string; kind: 'rules' | 'model'; note: string };
  at: string;
}

// ---------------------------------------------------------------------------
// Permissions and approvals
// ---------------------------------------------------------------------------

export interface PermissionRequest {
  level: PermissionLevel;
  /** What is being touched: a tool id, an agent id, a path… */
  subject: string;
  /** Human-readable, used in the approval prompt. */
  description: string;
  /** Money involved, when the action moves any. */
  amountUsd?: number;
  /** True when the action stays inside MADRE's own stores or sandbox. */
  internal?: boolean;
}

export interface PermissionDecision {
  mode: PermissionMode;
  reason: string;
  level: PermissionLevel;
}

export interface ApprovalRequest {
  id: string;
  missionId: string;
  runId: string;
  stepId: string | null;
  kind: 'permission' | 'input';
  level: PermissionLevel | null;
  title: string;
  detail: string;
  status: 'pending' | 'approved' | 'denied';
  createdAt: string;
  decidedAt: string | null;
  /** For `input` approvals this is the text the user provided. */
  note: string | null;
}

// ---------------------------------------------------------------------------
// Cost
// ---------------------------------------------------------------------------

export interface CostRecord {
  id: string;
  at: string;
  missionId: string | null;
  runId: string | null;
  stepId: string | null;
  agentId: string | null;
  kind: 'model' | 'tool';
  provider: string;
  model: string | null;
  promptTokens: number;
  completionTokens: number;
  /** From the configured price table; null when no price is known. */
  estimatedUsd: number | null;
  /** From the vendor's own report, when it gives one. */
  actualUsd: number | null;
  latencyMs: number;
  /** `real` or `mock`. Absent on records written before provenance was tracked. */
  source?: ResultSource;
  /** The provider's request id for this call, when it gave one. */
  requestId?: string | null;
}

export interface Budget {
  perMissionUsd: number | null;
  dailyUsd: number | null;
  monthlyUsd: number | null;
  perAgentUsd: Record<string, number>;
  perToolUsd: Record<string, number>;
  /**
   * Warn once spending passes this share of a limit (0..1). `null` = no warning.
   * An alert never blocks anything; it is there so a limit is not a surprise.
   */
  alertAtFraction: number | null;
  /** What to do when a step would exceed a limit. */
  onExceed: 'block' | 'fallback_local' | 'ask';
}

export interface BudgetAlert {
  /** Which ceiling is close. */
  scope: 'mission' | 'daily' | 'monthly' | 'agent' | 'tool';
  /** The agent or tool id, when the scope names one. */
  subject: string | null;
  limitUsd: number;
  spentUsd: number;
  /** 0..1 — how much of the limit is already committed. */
  usedFraction: number;
  message: string;
}

export interface CostSummary {
  calls: number;
  promptTokens: number;
  completionTokens: number;
  /** Sum of the known costs. */
  knownUsd: number;
  /** Calls with no price, so `knownUsd` is a lower bound when this is > 0. */
  unpricedCalls: number;
  latencyMs: number;
  byProvider: Record<string, { calls: number; usd: number }>;
  byAgent: Record<string, { calls: number; usd: number }>;
  byTool: Record<string, { calls: number; usd: number }>;
}

export interface BudgetCheck {
  allowed: boolean;
  /** The limit that would be crossed, when not allowed. */
  reason: string | null;
  action: 'proceed' | 'block' | 'fallback_local' | 'ask';
  remainingUsd: { mission: number | null; daily: number | null; monthly: number | null };
  /** Ceilings the call does not cross but is close to. Informational. */
  alerts: BudgetAlert[];
}

// ---------------------------------------------------------------------------
// Memory
// ---------------------------------------------------------------------------

export type MemoryType =
  | 'user_context'
  | 'project_context'
  | 'mission_history'
  | 'fact'
  | 'decision'
  | 'preference'
  | 'result'
  | 'lesson'
  | 'external_source'
  | 'temporary';

export type MemoryScope = 'user' | 'project' | 'mission' | 'session';

export interface MemoryEntry {
  id: string;
  type: MemoryType;
  scope: MemoryScope;
  title: string;
  content: string;
  source: {
    origin: 'user' | 'agent' | 'system' | 'tool' | 'qa';
    /** URL, tool id, document name… whatever lets a reader check the claim. */
    ref: string | null;
  };
  /** 0..1. */
  confidence: number;
  /** True only when confirmed by the user, a tool or an external source. */
  verified: boolean;
  missionId: string | null;
  runId: string | null;
  tags: string[];
  createdAt: string;
  expiresAt: string | null;
}

// ---------------------------------------------------------------------------
// Research
// ---------------------------------------------------------------------------

export type ClaimKind = 'FACT' | 'ASSUMPTION' | 'ANALYSIS' | 'OPINION' | 'UNKNOWN';

// ---------------------------------------------------------------------------
// Audit
// ---------------------------------------------------------------------------

export type AuditActor = 'madre' | 'compiler' | 'router' | 'engine' | 'judge' | 'policy' | 'user' | 'tool' | 'memory' | 'cost';

export interface AuditEvent {
  id: string;
  at: string;
  actor: AuditActor;
  type: string;
  message: string;
  missionId: string | null;
  runId: string | null;
  stepId: string | null;
  data: Record<string, unknown> | null;
}

// ---------------------------------------------------------------------------
// Aggregates served by the API
// ---------------------------------------------------------------------------

export interface MadreSnapshot {
  missionId: string;
  /** Null when the mission has never run in MADRE mode. */
  runId: string | null;
  plan: MissionPlan | null;
  state: MadreRunState | null;
  approvals: ApprovalRequest[];
  audit: AuditEvent[];
}

export interface WorldModel {
  generatedAt: string;
  user: { memoryEntries: number; preferences: string[] };
  projects: { entries: number };
  missions: { total: number; running: number; completed: number; failed: number; waiting: number };
  agents: { active: number; planned: number; total: number };
  tools: Record<ToolStatus, number>;
  providers: { connected: number; local: number; mock: number; notConnected: number; error: number };
  knowledge: { entries: number; verified: number; lessons: number };
  constraints: { budget: Budget; permissions: Record<PermissionLevel, PermissionMode> };
  resources: { executableProviders: string[]; usableTools: string[] };
  goals: { title: string; missionId: string; status: string }[];
  /** What exists but does nothing yet, or is missing altogether. */
  gaps: string[];
  /** What MADRE can do right now, in plain words. */
  canDo: string[];
  /** The most useful things to do next. */
  next: string[];
}

// ---------------------------------------------------------------------------
// Routing policy
// ---------------------------------------------------------------------------

/**
 * What the router optimises for, as data rather than branches.
 *
 * The ladder in `tierOrder` is the backbone: local first, simulated last. The
 * weights only break ties between candidates that already satisfy every hard
 * requirement (capability, quality floor, privacy, budget), so no weight can
 * talk the router into a model that cannot do the job.
 */
export interface RoutingPolicy {
  /** Preference order applied before any weighting. */
  tierOrder: ProviderTier[];
  weights: {
    quality: number;
    cost: number;
    latency: number;
    privacy: number;
  };
  /** Never route to a third-party provider, whatever the step asks for. */
  localOnly: boolean;
  /** Consecutive failures before a provider is taken out of rotation. */
  circuitBreakerThreshold: number;
  /** How long a tripped provider stays out. */
  circuitBreakerCooldownMs: number;
  /** Candidate fallbacks recorded on each decision. */
  maxFallbacks: number;
}

/** One provider's standing with the circuit breaker. */
export interface CircuitState {
  providerId: string;
  consecutiveFailures: number;
  /** Open = out of rotation until `openedUntil`. */
  open: boolean;
  openedUntil: string | null;
  lastFailure: string | null;
  /**
   * True from the moment a cooldown expires until the next call settles: the
   * provider is offered again, but one more failure puts it straight back out.
   */
  probation: boolean;
}

// ---------------------------------------------------------------------------
// Observability
// ---------------------------------------------------------------------------

/**
 * One link in the chain that produced a result: which step, which agent, which
 * model, which tools, what it cost, what QA said, and what a person decided.
 *
 * The trace is assembled from records that already exist (plan, run state,
 * cost, QA, approvals, audit). It stores nothing new — it is a view, so it can
 * never drift from what actually happened.
 */
export interface TraceStep {
  stepId: string;
  title: string;
  agentId: string;
  status: StepStatus;
  attempts: number;
  provider: string | null;
  model: string | null;
  execution: 'local' | 'external' | 'simulated' | 'none' | null;
  routingRationale: string[];
  tools: { toolId: string; ok: boolean; verified: boolean; error: string | null; stage: ToolStage | null; code: ToolErrorCode | null }[];
  costUsd: number | null;
  unpricedCalls: number;
  latencyMs: number | null;
  startedAt: string | null;
  completedAt: string | null;
  error: string | null;
  /** QA issues raised against this step, across every round. */
  qaIssues: { category: QACategory; severity: QAIssue['severity']; message: string }[];
  approvals: { id: string; kind: ApprovalRequest['kind']; status: ApprovalRequest['status']; title: string }[];
  outputChars: number | null;
  /** Provenance of what ran: `real`, `mock`, or `null` when nothing ran. */
  source: ResultSource | null;
  simulated: boolean | null;
  requestId: string | null;
  /** The router's structured account of the provider choice. */
  router: RouterExplanation | null;
  /** One entry per provider call, in order: attempt, provider, model, timing, outcome. */
  providerCalls: ProviderCallTrace[];
  /** The structured error the step ended with, when a provider call failed. */
  providerError: ProviderErrorInfo | null;
}

/** One request to a provider, rebuilt from the audit log. */
export interface ProviderCallTrace {
  attempt: number;
  provider: string;
  model: string;
  startedAt: string;
  endedAt: string | null;
  latencyMs: number | null;
  outcome: 'succeeded' | 'failed' | 'in_flight';
  requestId: string | null;
  source: ResultSource | null;
  simulated: boolean | null;
  promptTokens: number | null;
  completionTokens: number | null;
  error: ProviderErrorInfo | null;
}

export interface MissionTrace {
  missionId: string;
  runId: string;
  phase: RunPhase;
  objective: string;
  steps: TraceStep[];
  qaRounds: { verdict: QAVerdict; scope: string; round: number; issues: number }[];
  cost: CostSummary;
  /** Audit events in order, so a decision can be followed backwards. */
  events: { at: string; type: string; message: string; stepId: string | null; data: Record<string, unknown> | null }[];
  startedAt: string | null;
  completedAt: string | null;
  /** How the run was engineered: `madre` (compiled plan) or `classic` (fixed pipeline). */
  mode: RunMode;
  /** Present when boot-time recovery had to repair this run. */
  recovery: RunRecoveryRecord | null;
}
