# MADRE — the mission engine

MADRE turns a human objective into a verifiable operation:

```
USER → Mission Compiler → Planner → Smart Router → Agents → Tools
     → Execution Engine → QA / Judge → Result → Memory → Next action
```

It lives in `packages/madre` and is built **on top of** the existing orchestrator.
The classic eight-agent pipeline is still selectable (`mode: "classic"`) and
`DEFAULT_MISSION_MODE=madre` makes MADRE the default. Both modes run on the same
engine — see *Classic mode* below.

## Honest status

| Area | State |
| --- | --- |
| Mission Compiler, Planner (DAG), Smart Router, Execution Engine (retries, healing, bounded revisions, cancel, pause/resume) | **Implemented**, rule-based and deterministic, unit + integration tested |
| QA / Judge (structure, prose, simulated-output and unverified-claim checks) | **Implemented**, rule-based. It does not reason about truth |
| Memory (with provenance), World Model, Cost Controller, Permissions + Approvals, Audit | **Implemented**, persisted in PostgreSQL (`madre_documents`) |
| Tool registry: declared schema, version, permissions, risk, timeout, per-run limits, enable/disable, input validation | **Implemented** |
| Tool execution | **Executable today: `memory.recall` and `math.calculator`.** Every other tool in the catalogue is refused explicitly (`no_executor` or `tool_unavailable`) with a reason in the trace and the audit log; nothing is dropped. See *Tool pipeline* |
| Provider health checks (`POST /api/madre/providers/health`) | **Implemented** — a real probe. Nothing is reported healthy because its configuration looks complete |
| Model capability declarations (streaming, tool calling, structured output, embeddings, vision) and per-model limits | **Declared, not probed**. For unconnected providers these are what the vendor documents; MADRE cannot confirm any of it until the adapter exists |
| Routing policy (`RoutingPolicy`) | **Implemented** — weights only break ties between candidates that already satisfy every hard requirement |
| Circuit breaker | **Implemented and wired to real outcomes**: a transient provider failure counts, three in a row take it out of rotation for a cooldown, then one probation call decides. Permanent configuration errors (rejected key, no quota) do not count: the provider is taken out of service instead. See *Circuit breaker* and [PROVIDERS.md](PROVIDERS.md) |
| Crash recovery | **Implemented**: on boot the persisted run state is reconciled with the legacy rows. See *Boot-time recovery* |
| Cost control: per-mission, daily, monthly, per-agent and per-tool ceilings, plus alerts before a limit | **Implemented**. A model with no configured price is refused rather than guessed |
| Trace (`GET /api/missions/:id/trace`) | **Implemented** — a view over records that already exist, so it cannot drift from what happened |
| Rate limit | **Implemented** as a guard rail (in-process, per address), not a security control |
| OpenAI / Anthropic / Gemini | **Real adapters, tested offline against a fake HTTP layer; not yet verified against the live vendors** (needs keys: `pnpm e2e:real`). Configured only with a key **and** a model; unconfigured = `Sin configurar`, never simulated. Every result carries `source` / `simulated`. See [PROVIDERS.md](PROVIDERS.md) |
| Mock provider | Simulated, labelled `simulated` in every result; used only when no real provider is configured, or when a mission is pinned to it. A configured-but-unusable real provider blocks the step instead of falling back to it |
| Ollama | **Not implemented in Phase 2** (needs a local machine). Works only when `OLLAMA_BASE_URL` and models are configured; tested against an injected fake, not a live Ollama |
| OpenAI-compatible | **Not connected** (typed stub; 503 if selected; never falls back to the mock silently) |
| Web search / fetch, GitHub, image / video / voice generation, TikTok / Instagram / YouTube, analytics, email, scheduler, browser / desktop control | **Not connected** — adapters throw `NotConnectedError`, tools show `NOT_CONNECTED` |
| Code execution sandbox | **Disabled** (permission `EXECUTE` is blocked). `sandbox.files` is a file-only local sandbox |
| Content / media / faceless-factory pipelines | **Planning + readiness only**: they report per stage whether it could run, and what is missing. Nothing is published |
| Affiliate accounting, trading research, research engine, opportunity assessment, visual reverse engineering, multi-profile operations | **Pure libraries with tests**, not wired to live services. Trading is simulation only (`LiveExecutionGuard` always refuses). Reverse engineering refuses without proof the target is your own or authorised. Multi-profile rejects anti-bot / evasion techniques |

A run on the mock provider reports **low confidence** and a QA verdict capped at
`PASS_WITH_WARNINGS`. That is intentional: simulated text is not analysis.

## Tool pipeline

A step reaches a tool through exactly one door, `ToolPipeline.run()`
(`tools/pipeline.ts`), and every call passes these stages in this order:

1. **permission** — the permission policy (`BLOCK` refuses, `ASK` needs an approved step)
2. **lookup** — the tool exists
3. **enabled** — the operator has not switched it off
4. **availability** — the tool is connected and usable
5. **validation** — the input satisfies the tool's declared schema (required fields, types, enums, and *no unknown fields* — every catalogue tool is strict)
6. **call limit** — per-run call ceiling
7. **cost** — per-tool ceiling; a tool with a paid cost model and no known price is **refused** when a budget is active, never estimated and never assumed to be 0
8. **executor** — something can actually run it (`no_executor` otherwise)
9. **execution** — with a timeout and cancellation

Every refusal is a structured `ToolResult` (`stage`, `code`, `error`) that lands in
`StepState.toolResults`, in the audit log (`tool.refused`) and in the trace. The
agent's prompt gets a *TOOLS THAT COULD NOT BE USED* section with the reason, so it
does not invent what the tool would have returned. A tool marked `required` that
fails stops the step (`BLOCKED`) before any model is called. The planner builds
valid inputs at the source (`memory.recall` gets its `query`); a tool whose input
cannot exist yet (`math.calculator`) is not requested at planning time and the plan
says so in `plan.warnings`.

## Circuit breaker

`CircuitBreaker` (`router/circuit.ts`) lives inside the `SmartRouter`. The engine
reports every attempt's outcome: a transient provider-side failure (timeout, rate
limit, unavailable, invalid response) calls `recordFailure`; a success calls `recordSuccess`.
At the threshold (3) the breaker opens (`provider.circuit_opened` in the audit log),
the router excludes that provider, and after the cooldown (60 s) it comes back **on
probation**: one success closes it (`provider.circuit_closed`), one failure re-opens
it. Unusable output, malformed requests, budget refusals and cancellations do not
count. A permanent configuration error (rejected key, exhausted quota) does not
count either: a cooldown would not fix it, so the provider is marked out of service
(`ERROR`) until the operator corrects it or the server restarts. If a failure opens
the circuit while a step is retrying, the step is re-routed rather than sent to the
provider again. The provider catalogue shows an open circuit as `ERROR` with the reason.

## Boot-time recovery

The in-process queue dies with the process. On boot, before the queue starts,
`madre.recover()` (`execution/recovery.ts`) reconciles everything the last process
left behind. The **persisted run state is the only authority**; the legacy tables
(`mission_runs`, `mission_agents`, `missions`) are aligned to it:

- A run found mid-flight is **interrupted**, never completed: steps left
  `RUNNING`/`RETRYING` become `FAILED` with `interrupted: true`; steps that never
  started become `BLOCKED` ("la ejecución se interrumpió antes de llegar a este
  paso"); finished steps keep their results untouched; a pending approval of the
  dead run is denied. The run is `failed` and **retryable** (a new run of the
  mission can be started).
- A run whose state says it had finished (`completed`/`failed`/`cancelled`) but
  whose legacy row was never closed is closed to match.
- A paused run with a person still to hear from is left alone; one whose approvals
  were all decided while the server was down is queued to continue.
- The state is written **first**, then the legacy rows; a crash between the two
  is finished by the next boot.
- It is **idempotent**: a second pass finds nothing to change, and the audit event
  (`run.recovered`) has a fixed id per run, so it exists once.
- What cannot be repaired (a closed legacy row that contradicts the state — the
  legacy repositories refuse to reopen a closed run) is reported as a *conflict*,
  never papered over.
- Every recovered run records what was changed and why in `state.recovery`, which
  the trace, the API and the run panel show.

`madre.inspect(missionId)` lists every way a mission's records disagree; a healthy
system returns nothing. The old boot sweep (`recoverUnfinishedRuns`) stays as a
safety net and warns if it ever has to close something.

## Classic mode

`mode: "classic"` is the fixed eight-agent pipeline (strategy, research, code,
design, marketing, finance, QA, integrator). It used to run in a separate
orchestrator and bypassed routing, permissions, cost, audit, trace and
cancellation. It now runs **on the MADRE engine**: `ClassicPlanner`
(`compiler/classic.ts`) lays the eight agents out as a plan and everything after
that is the shared engine, so it cannot skip a control — there is no second code
path. The queue handler sends both modes to `madre.execute`.

What is deliberately different from a MADRE mission:

| | MADRE | Classic |
| --- | --- | --- |
| Plan | compiled from the objective | the fixed catalogue order |
| Provider | chosen by the router | the one the mission was started with (`RouteOptions.pin`); if it is unavailable the step is blocked, never rerouted |
| Context | declared dependencies | every step sees everything before it |
| Retries / fallback | up to 2 attempts, provider fallback | one attempt |
| Planned tools | yes | none |
| Judge revision rounds | up to `MADRE_MAX_REVISION_ROUNDS` | none (the judge still reports) |
| On a worker failure | dependents blocked | `CONTINUE_ON_WORKER_FAILURE` (default): carry on and say what is missing |
| Prompts | MADRE prompt builder | same builder; the personas are the catalogue's |

Cancellation works for classic (executing, paused or still queued). Old classic
runs (before this change) have no MADRE state; the UI says so. `MissionOrchestrator`
remains in `packages/orchestrator` with its tests but is no longer wired into the server.

## Layers

- `types.ts`, `capabilities.ts` — plain-JSON contracts (mission spec, plan, step, QA, cost, memory, approvals).
- `compiler/` — objective → mission spec with **provenance** on every statement (`user_stated`, `inferred`, `default`, `assumption`); `planner.ts` builds the step DAG.
- `registry/` — agents (8 active, 11 prepared), tools, providers, each with an honest status.
- `router/` — ladder LOCAL → stronger local → external → specialised; the mock is the last resort and marks output `simulated`. Unknown prices are `null`, never guessed.
- `execution/` — DAG scheduler with bounded parallelism, timeouts, retries, self-healing, revision rounds, cancel, approvals/resume, and a mirror into the legacy `mission_agents` rows so the old UI keeps working.
- `permissions/` — `READ`/`WRITE` auto, `EXECUTE` block, `EXTERNAL_ACTION`/`PUBLISH`/`DELETE` ask, `FINANCIAL` block. Overrides can only tighten.
- `cost/`, `memory/`, `world/`, `qa/`, `audit.ts`, `store.ts` — budget checks, memory with provenance, world snapshot, judge, audit trail, generic document store.
- `pipelines/`, `growth/`, `trading/`, `research/`, `business/`, `reverse/`, `profiles/`, `computer-use/`, `sandbox/` — the capability modules listed above.
- `service.ts` — `createMadre(config)`: the single composition point the server uses.

The core packages depend on nothing external (`pnpm typecheck:core` enforces it
for `domain`).

## API

`POST /api/missions` accepts `mode: "madre" | "classic"`. Extra routes:

`GET /api/madre/{overview,agents,providers,tools,permissions,activity,approvals,budget}`,
`POST /api/madre/providers/health`, `GET /api/missions/:id/trace`,
`POST /api/madre/compile`, `GET|POST /api/madre/memory`, `DELETE /api/madre/memory/:id`,
`PATCH /api/madre/budget`, `POST /api/madre/approvals/:id/{approve,deny}`,
`GET /api/missions/:id/madre`, `POST /api/missions/:id/cancel`.

All are in `/api/openapi.json`; a test keeps the document and the router in sync.

## Configuration

See `.env.example`: `DEFAULT_MISSION_MODE`, `OLLAMA_BASE_URL`, `MADRE_PARALLELISM`,
`MADRE_MAX_REVISION_ROUNDS`, `MADRE_BUDGET_PER_MISSION_USD`, `MADRE_BUDGET_DAILY_USD`,
`MADRE_BUDGET_MONTHLY_USD`, `MADRE_BUDGET_ON_EXCEED` (`block` | `fallback_local` | `ask`),
`MADRE_PRICES_JSON`, `MADRE_BUDGET_ALERT_AT_PERCENT`, `MADRE_TOOL_BUDGETS_JSON`,
`RATE_LIMIT_MAX`, `RATE_LIMIT_WINDOW_MS`. Keys and prices live only on the server.

## Interface language

Everything a person reads is in Spanish: the app, the text the engine
generates, API error messages and validation issues. Identifiers, enum values,
route names, code and comments stay in English, and the web app maps every enum
to a Spanish label rather than printing the code. The catalogue lives in
`apps/web/src/i18n/es/`, grouped by screen, with parameterised and plural texts
as small functions so no sentence is assembled in a component. Adding a language
means adding a folder with the same shape — `Messages`, derived from `es`, makes
the compiler enforce it. There is no i18n dependency; `t` is a plain object.

The default theme follows the device. Text the model returns follows the
mission's language and defaults to Spanish.

## Producción: lo que falta

Audited, and deliberately not faked:

- **No authentication and no authorisation.** There is no user model, so every
  caller of the API is the same anonymous caller. This is the single blocker
  for exposing the server beyond a trusted network.
- **The rate limit is in-process.** A second instance keeps its own counters,
  and it is per address. It stops runaway clients, not attackers.
- **CORS** is an explicit allowlist (`CORS_ORIGIN`), never `*`.
- **Secrets** are read from the server environment only and never reach the
  browser. `.env` is git-ignored; only `.env.example` is committed.
- **Destructive operations** are limited to deleting a memory entry, which is
  scoped and audited. `EXECUTE` is blocked and there is no code sandbox.
- **Backups** are not handled here: the database is plain PostgreSQL, so its own
  backup tooling applies.

## Connecting a real provider

OpenAI, Anthropic and Gemini are already connected: set the key **and** model
variables (see [PROVIDERS.md](PROVIDERS.md) and `.env.example`) and, if you use a
budget, their prices in `MADRE_PRICES_JSON`. Check with
`POST /api/madre/providers/health` (a real, unbilled probe) and run
`pnpm e2e:real` for one minimal billed mission per configured provider.

To add another vendor, see the README section *Adding an AI provider*. The
router, planner and engine need no change.

## Tests

`pnpm test` runs everything (`packages/**`, `apps/server/**`, `apps/web/src/**`).
MADRE tests use an in-memory `MadreStore`, a fake clock and scripted providers, so
they are deterministic. `packages/database/test/sql-contract.sql` checks the
migration on real PostgreSQL.
