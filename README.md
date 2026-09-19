# AI Command Center

Multi-agent mission orchestration. You write a mission in plain language; the
system turns it into a project and drives eight specialist agents through it in
sequence, audits the output, and merges it into one brief.

```
USER → MISSION → ORCHESTRATOR → AGENTS → QA → INTEGRATOR → RESULT
```

This is not a chatbot and not a model aggregator. The core of the product is the
execution engine: a persisted state machine over missions, runs and agent
executions, driven asynchronously so an HTTP request never waits for the crew.

---

## Status: what actually works

**Working end to end, today, with no API keys:**

- Mission creation, run scheduling, sequential agent execution, QA, integration
- Full persistence in PostgreSQL (missions, runs, agent executions, multiple
  runs per mission, complete history)
- Asynchronous execution — `POST /api/missions` returns in milliseconds while
  the agents keep working
- Error handling: per-agent failures, run aborts, timeouts, crash recovery
- REST API with an OpenAPI 3.1 document and a typed client
- React PWA with a live pipeline view, polling, and iPhone support

**The one simulated part:** `MockProvider`. It generates structured, on-topic
Markdown from the mission text but performs **no reasoning** — every result it
produces is prefixed with a banner saying so. It exists to prove the
orchestration machinery, not to advise anyone. Swap in a real provider and
nothing else changes.

**Not implemented (declared, not faked):** OpenAI, Anthropic, Gemini and
OpenAI-compatible adapters exist as typed stubs. They appear in
`GET /api/providers` as `planned`, and selecting one returns `503` with an
explanation. They never silently fall back to the mock.

---

## Install

Requires **Node ≥ 22.12** (Vite 7's floor), **pnpm 10**, and **PostgreSQL ≥ 14**.

```bash
pnpm install
cp .env.example .env          # defaults work for a local Postgres
createdb ai_command_center    # or point DATABASE_URL at an existing database
```

pnpm 10 blocks postinstall scripts by default, so `package.json` declares
`pnpm.onlyBuiltDependencies` for `esbuild` and `@tailwindcss/oxide` — both ship
native binaries the build needs. Without that list `pnpm install` would succeed
and `pnpm build` would fail with a binary-not-found error.

Migrations run automatically on boot (`DB_AUTO_MIGRATE=true`). To run them by
hand:

```bash
pnpm db:migrate
```

### Changing the schema

`packages/database/src/migrations/*.sql` is hand-authored and is the single
source of truth for what runs against the database. drizzle-kit is used for
**diffing only**:

```bash
pnpm db:diff     # writes a proposed migration into packages/database/drizzle-generated/
```

Review it, then copy the statements into a new numbered file in
`src/migrations/` and mirror the change in `schema.ts`. Letting drizzle-kit
write directly into `src/migrations/` would put two numbering schemes and two
journals in one folder.

### Running without a database

For a quick look with nothing to install:

```bash
PERSISTENCE=memory pnpm dev
```

Everything works, but data is lost on restart. It is not a production mode and
the server warns about it on boot.

---

## Run

```bash
pnpm dev          # API on :3001 and the web app on :5173, together
```

Or separately:

```bash
pnpm dev:server
pnpm dev:web
```

Open <http://localhost:5173>. Vite proxies `/api` to the server, so the browser
stays same-origin and CORS never comes into it.

### Trying the failure paths

The MockProvider reads control directives from the mission text, so error
handling can be exercised without touching the server:

| Directive | Effect |
| --- | --- |
| `[fail:marketing]` | Marketing throws. The run continues; QA and the Integrator document the gap. The mission ends `failed` **with** a partial brief. |
| `[fail:qa]` | QA throws. The run aborts, the Integrator is marked `skipped`, no final result. |
| `[fail:integrator]` | The Integrator throws. Seven agents complete, no final result. |
| `[slow:2000]` | Every agent call takes ~2s — useful for watching the live pipeline. |

Example: `Launch an online cookie store in Italy [fail:marketing]`

Directives are stripped from titles and surfaced explicitly in the UI, never
hidden.

---

## Verify

```bash
pnpm verify        # typecheck + tests + build
```

Individually:

```bash
pnpm typecheck     # two projects: server+packages (node types), then the web app (DOM + vite types)
pnpm test          # node:test via tsx — no test framework dependency
pnpm build         # esbuild bundle → apps/server/dist/main.js, then vite build of the web app
```

The server bundle externalises `pg` (native bindings cannot be bundled), which
is why it is emitted inside `apps/server/` — Node then resolves `pg` from
`apps/server/node_modules`. The SQL migrations are copied next to the bundle so
boot-time auto-migration works in production as well as in dev. Run it with
`pnpm --filter @acc/server start`.

`pnpm typecheck:core` typechecks only the dependency-free core (domain,
providers, orchestrator, in-memory adapter, HTTP router). It is an
**architectural guard**: if any of those files ever imports Express, Drizzle,
Zod or a vendor SDK, it stops compiling.

---

## Project structure

```
packages/
  domain/         Entities, state machine, agent catalog, ports, validation.
                  Zero dependencies — the rule that keeps the core testable.
  providers/      AIProvider implementations: MockProvider + four planned stubs,
                  behind a registry.
  orchestrator/   MissionService (lifecycle), MissionOrchestrator (execution),
                  InProcessJobQueue, crash recovery.
  repositories/   Port implementations: in-memory and Drizzle/PostgreSQL.
  database/       Drizzle schema, SQL migrations, migration runner, pool.
  contracts/      Zod schemas, OpenAPI 3.1 document, typed API client.

apps/
  server/         config · container (composition root) · http/ (framework-
                  agnostic router) · express-adapter.ts (~40 lines of glue)
  web/            React + Vite + Tailwind v4 PWA, mobile-first.
```

### Why it is shaped this way

**The domain has no dependencies.** It declares ports; adapters implement them.
That is what lets the entire orchestration pipeline be tested against in-memory
repositories with no database and no network.

**The orchestrator depends on `AIProvider`, never on a vendor.** Adding OpenAI
means writing one adapter and registering it. No call site changes.

**The HTTP router is framework-agnostic.** Route handlers are plain functions
from `HttpRequest` to `HttpResponse`, so every endpoint is unit-tested without
booting a server, and Express is a thin adapter that could be swapped for
Fastify by rewriting one file.

**Agent rows are written up front.** Creating a run persists all eight agents as
`pending` immediately, which is what lets the UI draw the whole pipeline the
instant a mission is created instead of having agents appear one by one.

**The queue is a port.** `InProcessJobQueue` is honest about its limits: jobs
live in this process's memory, so the server sweeps unfinished runs on boot and
marks them failed rather than leaving them `running` forever. Replacing it with
pg-boss or BullMQ means writing one class.

---

## Data model

```
missions 1───n mission_runs 1───n mission_agents
```

A mission keeps `id`, `prompt`, `title`, `status`, `finalResult`, `createdAt`,
`updatedAt`. Each run records its attempt number, provider, model, status,
result and error. Each agent execution records `agentId`, `name`, `orderIndex`,
`status`, `task`, `result`, `error`, provider usage, and its timestamps.

`mission_agents` carries both `run_id` and `mission_id`, and a composite foreign
key on `(run_id, mission_id)` makes that denormalisation impossible to corrupt —
an agent cannot point at a run belonging to a different mission.

Starting a run is three writes — the run row, the eight agent rows, the mission
status — and they happen in **one transaction**, through `Repositories.transaction`.
A run persisted without its agents would otherwise be picked up by the
orchestrator and reported `completed` having done nothing. The job is enqueued
only after the transaction commits, so a worker can never see a rolled-back run,
and the orchestrator refuses outright to execute a run with zero agents.

### States

Mission and run: `pending → running → completed | failed`

Agent: `pending → running → completed | failed`, plus `pending → skipped` when a
run aborts before that agent's turn. Illegal transitions are rejected, not
silently applied.

### Failure policy

A **worker** failure (Strategy…Finance) is survivable: the agent is marked
`failed`, the run continues, and QA and the Integrator are told what is missing
so the brief documents its own gap. The mission ends `failed`, but the partial
brief is still stored — losing the Integrator's work because one worker failed
helps nobody.

A **QA or Integrator** failure aborts the run: without an audit or a merge there
is no deliverable. Remaining agents are marked `skipped`.

Configurable with `CONTINUE_ON_WORKER_FAILURE`.

---

## API

| Method | Path | Notes |
| --- | --- | --- |
| `POST` | `/api/missions` | `202` + the full mission; agents run in the background. `201` when `autoStart:false`. |
| `GET` | `/api/missions` | `?limit&offset&status` |
| `GET` | `/api/missions/:id` | Mission with every run and agent execution |
| `POST` | `/api/missions/:id/run` | `202`; `409` if a run is already in flight |
| `GET` | `/api/agents` | The agent catalog |
| `GET` | `/api/providers` | Registered providers and availability |
| `GET` | `/api/stats` | Mission counts by status |
| `GET` | `/api/health` | Liveness |
| `GET` | `/api/openapi.json` | OpenAPI 3.1 document |

Errors are uniform: `{ "error": { "code", "message", "issues": [] } }`. Stack
traces are never returned.

The frontend polls `GET /api/missions/:id` while a mission is active and stops
as soon as it settles, so an idle tab makes no requests.

---

## Environment variables

All read by the **server**. The frontend bundle contains no secrets and talks
only to this API.

| Variable | Default | Purpose |
| --- | --- | --- |
| `PORT` | `3001` | HTTP port |
| `CORS_ORIGIN` | `http://localhost:5173` | Comma-separated allowed origins |
| `LOG_LEVEL` | `info` | `debug` / `info` / `warn` / `error` |
| `PERSISTENCE` | `postgres` | `postgres` or `memory` |
| `DATABASE_URL` | — | Required when `PERSISTENCE=postgres` |
| `DB_POOL_MAX` | `10` | Connection pool size |
| `DB_AUTO_MIGRATE` | `true` | Apply pending migrations on boot |
| `DB_SSL` | `false` | Needed by most hosted Postgres |
| `AI_PROVIDER` | `mock` | Provider id; only `mock` is implemented |
| `AI_MODEL` | first model | Model id |
| `QUEUE_CONCURRENCY` | `1` | Concurrent mission runs |
| `CONTINUE_ON_WORKER_FAILURE` | `true` | Keep going after a worker agent fails |
| `AGENT_TIMEOUT_MS` | `60000` | Per-agent budget |
| `MOCK_MIN_LATENCY_MS` | `250` | Simulated latency floor |
| `MOCK_MAX_LATENCY_MS` | `900` | Simulated latency ceiling |

Provider keys (`OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `GEMINI_API_KEY`,
`OPENAI_COMPATIBLE_BASE_URL`) are listed in `.env.example` but **do nothing
yet** — the adapters that would read them are stubs.

---

## Adding an AI provider

The whole point of the architecture. Concretely, for OpenAI:

**1. Install the SDK**

```bash
pnpm add openai --filter @acc/providers
```

**2. Replace the stub** in `packages/providers/src/planned/openai.ts`. It
currently extends `PlannedProvider`; make it implement `AIProvider` directly:

```ts
export class OpenAIProvider implements AIProvider {
  readonly id: ProviderId = 'openai';
  readonly label = 'OpenAI';
  readonly availability = 'available' as const;

  constructor(private readonly apiKey: string) {}

  listModels(): readonly ProviderModel[] {
    return [{ id: 'gpt-4.1-mini', label: 'GPT-4.1 mini' }];
  }

  async execute(task: ProviderTask, signal?: AbortSignal): Promise<ProviderResult> {
    // 1. call the vendor with task.systemPrompt + task.prompt
    // 2. map the response onto ProviderResult:
    //    { provider, model, text, usage, requestId, finishReason, latencyMs }
    // 3. wrap any vendor error in ProviderFailedError — vendor error types
    //    must not cross this boundary
  }
}
```

**3. Register it** in `createProviderRegistry`
(`packages/providers/src/index.ts`), reading the key from the server config.

**4. Select it** with `AI_PROVIDER=openai`, or per mission via `providerId` in
the request body.

Nothing in the orchestrator, the service, the API or the frontend changes. Each
stub file carries its own implementation sketch in a comment, including which
SDK call to make and which fields to map.

`ProviderTask` also carries a structured `context` alongside the rendered
`prompt`, so an adapter can use a vendor's native shape — multi-turn messages,
cache breakpoints — instead of re-parsing a string.

---

## Testing

```bash
pnpm test
```

Tests run on `node:test` through `tsx`. There is no test framework dependency —
Node 22 ships one.

The orchestration tests drive the **real** service, queue, orchestrator and mock
provider against in-memory repositories, with only the clock and the provider's
sleep substituted. The pipeline they exercise is the pipeline the server runs.
The API tests drive the real router the same way. Coverage includes the happy
path, worker failure, QA abort, integrator failure, re-runs, concurrent-run
rejection, pagination, crash recovery, and the full error surface.

`packages/contracts/src/parity.test.ts` asserts that the Zod contract and the
dependency-free domain validators accept and reject exactly the same inputs, so
the deliberate duplication between them cannot drift.

---

## Mobile / PWA

Mobile-first throughout: bottom tab bar within thumb reach, 44px minimum touch
targets, 16px inputs (which stops iOS Safari zooming on focus), safe-area
insets for the notch and home indicator, and `100dvh` so the layout survives the
collapsing Safari toolbar.

Add to Home Screen on iOS gives a standalone app with its own icon and splash
behaviour. The service worker caches the app shell only — never `/api`
responses, because a stale pipeline would be worse than an honest network error.

---

## Roadmap

Deliberately **not** built yet, to keep the core honest:

- Real provider adapters (the seam is ready)
- A durable queue — pg-boss on the existing Postgres is the obvious step
- Streaming agent output (SSE) instead of polling
- Parallel execution of independent agents; the pipeline is sequential by design
  for now because every agent currently consumes its predecessors
- Tools: image / video / voice generation, web search, storage, GitHub, social
- Authentication and multi-tenancy — there is no user model yet
