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

**Real AI providers (Phase 2):** OpenAI, Anthropic and Google Gemini (Gemini
API key from Google AI Studio, not Vertex) have real adapters. They are enabled
purely by server-side environment variables (`OPENAI_API_KEY` + `OPENAI_MODEL`,
`ANTHROPIC_API_KEY` + `ANTHROPIC_MODEL`, `GOOGLE_API_KEY` + `GEMINI_MODEL`). A
provider without them is `Sin configurar` and is **never** answered by the
simulation. Every result carries `provider`, `model`, `source` (`real`|`mock`) and
`simulated`. See [`docs/PROVIDERS.md`](docs/PROVIDERS.md).

**Not verified against the real vendors:** everything is tested offline with a
fake HTTP layer. No live call to OpenAI, Anthropic or Gemini has been made from
this repository yet; `pnpm e2e:real` does it once you provide keys and reports
`BLOCKED` (not a failure) when you do not.

**The simulated part:** `MockProvider`. It generates structured, on-topic
Markdown from the mission text but performs **no reasoning** — every result it
produces is prefixed with a banner saying so and marked `simulated`. It is used
only when no real provider is configured at all (or a mission is pinned to it).

**Not implemented (declared, not faked):** Ollama (needs a local machine) stays
as the previously prepared provider, and the OpenAI-compatible adapter is a typed
stub that appears as `planned`; selecting it returns `503` with an explanation.
Neither silently falls back to the mock.

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

## MADRE (mission engine)

On top of the classic pipeline there is **MADRE** (`packages/madre`): it compiles
the objective into a plan, routes each step to a provider, executes the plan as a
DAG with retries, QA/judge, permissions, budgets, approvals and memory, and shows
all of it in the app (Dashboard → Mission Command Center, mission *Plan &
execution*). It is the default (`DEFAULT_MISSION_MODE=madre`); the classic
pipeline stays available per mission and runs on the same engine, with the same
routing, permission, cost, audit, trace, cancellation and crash-recovery
guarantees (see *Classic mode* in `docs/MADRE.md`).

The provider is still the simulated one, so MADRE reports low confidence and says
so. Real AI providers, web search, publishing and media tools are **not
connected**. Full, honest status, layers, API and how to connect a provider:
[`docs/MADRE.md`](docs/MADRE.md).

The interface is in Spanish — including everything the engine generates and every
API message a person can read. Identifiers, routes and code stay in English. The
text catalogue is `apps/web/src/i18n/es/`; another language is another folder of
the same shape, with no new dependency.

There is **no authentication yet**: every caller of the API is the same anonymous
caller, which is the blocker for exposing the server beyond a trusted network.
`RATE_LIMIT_MAX` is a guard rail against runaway clients, not a security control.

---

## Project structure

```
packages/
  domain/         Entities, state machine, agent catalog, ports, validation.
                  Zero dependencies — the rule that keeps the core testable.
  providers/      AIProvider implementations behind a registry: real OpenAI /
                  Anthropic / Gemini adapters (real/), MockProvider, Ollama,
                  and an OpenAI-compatible stub (planned/).
  orchestrator/   MissionService (lifecycle), MissionOrchestrator (execution),
                  InProcessJobQueue, crash recovery.
  repositories/   Port implementations: in-memory and Drizzle/PostgreSQL.
  database/       Drizzle schema, SQL migrations, migration runner, pool.
  contracts/      Zod schemas, OpenAPI 3.1 document, typed API client.
  madre/          Mission engine: compiler, planner, router, execution engine,
                  QA/judge, permissions, cost, memory, capability modules.

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
| `AI_PROVIDER` | `mock` | Default provider id: `mock`, `openai`, `anthropic`, `gemini` (a real one must be configured) |
| `AI_MODEL` | first model | Model id |
| `QUEUE_CONCURRENCY` | `1` | Concurrent mission runs |
| `CONTINUE_ON_WORKER_FAILURE` | `true` | Keep going after a worker agent fails |
| `AGENT_TIMEOUT_MS` | `60000` | Per-agent budget |
| `MOCK_MIN_LATENCY_MS` | `250` | Simulated latency floor |
| `MOCK_MAX_LATENCY_MS` | `900` | Simulated latency ceiling |

Provider variables (server only; never sent to the browser, database, trace or
audit): `OPENAI_API_KEY`/`OPENAI_MODEL`, `ANTHROPIC_API_KEY`/`ANTHROPIC_MODEL`/
`ANTHROPIC_MAX_TOKENS`, `GOOGLE_API_KEY` (alias `GEMINI_API_KEY`)/`GEMINI_MODEL`,
`CEREBRAS_API_KEY`/`CEREBRAS_MODEL`, `MISTRAL_API_KEY`/`MISTRAL_MODEL`, `CLOUDFLARE_API_TOKEN`/`CLOUDFLARE_ACCOUNT_ID`/`CLOUDFLARE_MODEL` (free-tier hosts, assumed 0 USD), `NEWS_ENABLED`, `GITHUB_TOKEN`/`GITHUB_SITES_REPO` (site publishing), the optional `*_API_BASE_URL` overrides, `MADRE_DISABLED_PROVIDERS` and
`MADRE_PRICES_JSON` (prices per 1k tokens; a model without a price is refused
under a budget, never priced at $0). A provider needs **both** a key and a model
to count as configured — there is no built-in default model. Details and the full
list: `.env.example` and [`docs/PROVIDERS.md`](docs/PROVIDERS.md).

---

## Content calendar (Contenidos)

The **Contenidos** screen (More → Contenidos) holds posts prepared in advance: a title, the text, a date and time, and the platform. For each one you can generate a **picture** (Cloudflare Workers AI, FLUX schnell; the description is translated to English automatically) and a **voice-over**. Pictures need `CLOUDFLARE_ACCOUNT_ID` and `CLOUDFLARE_API_TOKEN` (a token with the *Workers AI* permission). The voice uses **Gemini text-to-speech** when a Gemini key is set (`GOOGLE_API_KEY` or `GEMINI_API_KEY`; model `GEMINI_TTS_MODEL`, default `gemini-2.5-flash-preview-tts`; Spanish, Italian, English, French, German, Portuguese) and otherwise Cloudflare MeloTTS, which on Workers AI only accepts English and French (it answers `Invalid input` to `es`). Both use free allowances. Without any of these keys the calendar still works.

With a picture and a voice-over ready, **Crear vídeo** (made in the background; the screen polls `GET /api/content/:id/video` until it is done) builds a vertical 720x1280 mp4 (blurred backdrop, the picture centred, the voice as soundtrack, the text as timed captions) with ffmpeg on the server — no extra service and no cost. The Docker image installs `ffmpeg` and `fonts-dejavu-core`; without ffmpeg the button says so. Videos are capped at 60 seconds and stored with the item (`0003_content_video.sql`). `POST /api/content/:id/video`, `GET /api/content/:id/media/video`.

When a scheduled time arrives the piece moves to **Toca publicar**. **Publicar ahora** opens the phone's share sheet with the picture and the text, so it goes to the chosen app with one more tap; nothing is posted on the person's behalf. Then **Marcar como publicado**. Automatic posting to platform APIs is a later step.

Endpoints: `GET/POST /api/content`, `PATCH/DELETE /api/content/:id`, `POST /api/content/:id/image|voice`, `GET /api/content/:id/media/image|audio`, `GET /api/content/status`. Storage is the `content_items` table (migration `0002_content_items.sql`); media is kept in the row as base64.

## Publishing websites (GitHub Pages, free)

A mission that asks the crew to *build* a page or a simple ordering app (for example "créame una página web y una app de pedidos") gets an `engineering.site` step. The result is ONE self-contained HTML file: no external scripts, fonts or images, no network calls; orders are sent through a WhatsApp link (there is no server and no payment). The page is shown in a sandboxed preview on the mission screen and can be downloaded.

To publish it with one tap:

1. Create a **public** repository (for example `acc-sites`) with a README.
2. Create a **fine-grained personal access token** limited to that repository only, with `Contents: Read and write` and `Pages: Read and write`.
3. Set `GITHUB_TOKEN` and `GITHUB_SITES_REPO=owner/acc-sites` on the server (Render).

The token stays on the server. Each site is written to `<repo>/<folder>/index.html` and served at `https://<owner>.github.io/<repo>/<folder>/`. Nothing is published unless a person taps *Publicar*, and the page is checked again on the server before it is sent (`checkSiteHtml` in `@acc/domain`).

## Adding an AI provider

The three vendors above already follow the pattern; use them as the template
(`packages/providers/src/real/`).

**1. Write the adapter.** Extend `RealProvider` (`real/real-provider.ts`) and
implement the vendor-specific parts only: the request (URL, headers, body), how
to read text / token usage / request id out of the response, and a cheap health
probe. HTTP, timeout, `AbortSignal`, status → structured `ProviderError`
classification, `Retry-After` and secret scrubbing are shared in `real/http.ts`.
Use plain `fetch` (injectable for tests) and do **not** add a retry loop: the
engine owns retries.

**2. Declare its configuration.** Report `configuration()` honestly (key **and**
model required, no default model) and mark the result `source: 'real'`,
`simulated: false`.

**3. Add the env reader** in `real/env.ts` (`realProviderOptionsFromEnv`) and
register the adapter in `createProviderRegistry` (`packages/providers/src/index.ts`).
Add the provider id to `ProviderId` in `packages/domain` and its catalog entry
(`packages/madre/src/registry/providers.ts`); leave a price `null` until you
have confirmed it, and put real prices in `MADRE_PRICES_JSON`.

**4. Test it offline** with the `fakeFetch` helper
(`real/fixtures.test-support.ts`): success, 401, 429 + `Retry-After`, 5xx,
timeout, malformed body, cancellation, and that the key never appears in an error.

The router, circuit breaker, cost controller, engine, trace and audit need no
change. `ProviderTask` also carries a structured `context`, so an adapter can use
a vendor's native shape instead of re-parsing the rendered prompt.

---

## Testing

```bash
pnpm test        # everything, offline: no keys, no network, no database
pnpm e2e:real    # OPT-IN. Real, billed calls; prints BLOCKED without keys
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

- A live end-to-end run against the real OpenAI / Anthropic / Gemini APIs (needs your keys: `pnpm e2e:real`); Ollama and the OpenAI-compatible adapter
- A durable queue — pg-boss on the existing Postgres is the obvious step
- Streaming agent output (SSE) instead of polling
- Parallel execution of independent agents; the pipeline is sequential by design
  for now because every agent currently consumes its predecessors
- Tools: image / video / voice generation, web search, storage, GitHub, social
- Authentication and multi-tenancy — there is no user model yet

### Send a report to the calendar / download audio

On a finished mission, **Crear piezas en Contenidos** asks a real AI provider (never the simulator) to turn the report into draft pieces (`POST /api/missions/:id/content`). Each piece's voice can be downloaded as an audio file from the Contenidos screen.

### Creative studio

In **Creatividad**, type what you want ("un logo para mi tienda", "un reel…"). `POST /api/content/studio` has a real AI provider write the brief, then runs the real generators (Cloudflare picture, Gemini voice, ffmpeg video) and saves the result as a draft in the calendar. Videos are built from one still per caption joined with ffmpeg's concat demuxer, which is cheap enough for a free server.

### Video upload, editing and clips

In **Creatividad → Tus vídeos** you upload a video (max 30 MB, sent as base64 to `POST /api/content/upload`) and describe the edit in plain language. `POST /api/content/:id/edit` runs in the background: ffmpeg reads the file, Cloudflare Whisper (optional) transcribes it, a real AI provider plans the cuts, and ffmpeg renders each clip (optionally 9:16 centre-cropped, with burnt-in captions). Each clip is saved as a draft in the calendar. Publishing to platforms is not automated.

### Assistant and real publishing

On the Panel, **Pídeme lo que quieras** sends one free-text request to `POST /api/assistant`. A real AI provider turns it into up to four actions from a fixed menu (`create`, `campaign`, `edit_video`); they run in the background (poll `GET /api/assistant/:id`). Campaigns become dated draft pieces with pictures. Publishing is not on the menu: `POST /api/content/:id/publish` runs only when the person taps a button, through the adapters in `content/publish.ts` (Telegram: `TELEGRAM_BOT_TOKEN` + `TELEGRAM_CHAT_ID`; Facebook page: `FACEBOOK_PAGE_ID` + `FACEBOOK_PAGE_TOKEN`). Instagram and TikTok stay manual through the phone's share sheet.
