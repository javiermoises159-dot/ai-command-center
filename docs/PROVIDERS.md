# Proveedores reales de MADRE (Fase 2)

Este documento describe la capa de proveedores reales, el Smart Router, el
circuit breaker, el coste, la procedencia (provenance) y la auditoría que los
rodean. Todo lo que aquí figura como «implementado» está cubierto por tests
offline. Lo que **no** se ha podido comprobar contra un proveedor real se dice
expresamente (ver *Qué está verificado y qué no*).

```
Misión → Mission Compiler → DAG Planner → Smart Router → Provider real
       → Agente → ToolPipeline → QA → Resultado → PostgreSQL
       → Trace + Audit + Provenance
```

No hay un segundo motor: todo pasa por `MadreEngine`. Los proveedores **nunca**
llaman a herramientas; las herramientas siguen entrando solo por el
`ToolPipeline` (permiso → habilitada → búsqueda → validación de esquema → coste
de herramienta → ejecución → resultado → trace/audit → continuación).

## Proveedores

| Proveedor | Estado | Endpoint | Autenticación |
| --- | --- | --- | --- |
| OpenAI | Adapter real (`packages/providers/src/real/openai.ts`) | `POST {base}/chat/completions` (Chat Completions, `max_completion_tokens`) | `Authorization: Bearer` |
| Anthropic | Adapter real (`real/anthropic.ts`) | `POST {base}/messages` (`max_tokens` obligatorio) | `x-api-key` + `anthropic-version: 2023-06-01` |
| Google Gemini | Adapter real (`real/gemini.ts`), **Google AI Studio (clave de la Gemini API), no Vertex** | `POST {base}/models/{modelo}:generateContent` | cabecera `x-goog-api-key` (la clave nunca va en la URL) |
| Ollama | **No implementado en esta fase** (sigue como el proveedor local ya preparado; requiere una máquina con Ollama) | — | — |
| OpenAI-compatible | Adapter real (`real/openai-compatible.ts`): OpenRouter, Groq, Cerebras, Mistral, GitHub Models… Requiere `OPENAI_COMPAT_BASE_URL`, `OPENAI_COMPAT_API_KEY` y `OPENAI_COMPAT_MODEL` (sin URL por defecto) | `POST {base}/chat/completions` (`max_tokens`; si falta `usage`, cuenta 0) | `Authorization: Bearer` |
| Cerebras / Mistral / NVIDIA NIM / Cloudflare Workers AI | Tres proveedores propios sobre el mismo adapter (`real/hosted-compat.ts`), con su URL incorporada. Cerebras: `CEREBRAS_API_KEY` + `CEREBRAS_MODEL` (p. ej. `gpt-oss-120b`). Mistral: `MISTRAL_API_KEY` + `MISTRAL_MODEL` (p. ej. `mistral-small-latest`). NVIDIA NIM: `NVIDIA_API_KEY` + `NVIDIA_MODEL` (p. ej. `nvidia/nemotron-3.5-lightning-30b-a3b`; base `https://integrate.api.nvidia.com/v1`). Cloudflare: `CLOUDFLARE_API_TOKEN` + `CLOUDFLARE_ACCOUNT_ID` + `CLOUDFLARE_MODEL` (p. ej. `@cf/meta/llama-3.1-8b-instruct`). Se asume plan gratuito (0 USD); si pasas a uno de pago, defínelo en `MADRE_PRICES_JSON`. Los ids de modelo envejecen: cópialos del panel de cada servicio | `POST {base}/chat/completions` | `Authorization: Bearer` |
| Mock | Simulación local, siempre marcada `source: mock`, `simulated: true` | — | — |

Los adapters usan `fetch` simple (inyectable en tests), **sin SDK** y **sin
bucle de reintentos**: los reintentos son del motor (`healing`), para no
duplicarlos. El timeout por petición es 120 s por defecto y respeta además el
`AbortSignal` del motor (cancelación y timeout de agente).

### Configuración (solo variables de entorno del servidor)

| Variable | Significado |
| --- | --- |
| `OPENAI_API_KEY`, `OPENAI_MODEL` | Clave y modelo(s) de OpenAI. `OPENAI_MODEL` admite una lista separada por comas |
| `ANTHROPIC_API_KEY`, `ANTHROPIC_MODEL` | Ídem para Anthropic |
| `ANTHROPIC_MAX_TOKENS` | Tope de salida cuando la tarea no pide uno (por defecto 4096) |
| `GOOGLE_API_KEY`, `GEMINI_MODEL` | Ídem para Gemini. `GEMINI_API_KEY` se acepta como alias; si están las dos gana `GOOGLE_API_KEY` |
| `OPENAI_API_BASE_URL`, `ANTHROPIC_API_BASE_URL`, `GEMINI_API_BASE_URL` | Opcionales: pasarela o servidor compatible. `ANTHROPIC_BASE_URL` **no se lee** a propósito (es enrutado del entorno, no configuración de MADRE) |
| `MADRE_DISABLED_PROVIDERS` | Lista de ids que el operador desactiva (`openai,gemini`) |
| `MADRE_PRICES_JSON` | Precios por 1k tokens, clave `proveedor` o `proveedor:modelo` |

No hay ningún modelo por defecto incorporado: sin `*_MODEL` el proveedor queda
**sin configurar**, no se inventa un modelo. Las claves viven solo en el proceso
del servidor: no van al frontend, ni a PostgreSQL, ni a trace, audit, logs o
respuestas de la API. Los adapters las eliminan de cualquier texto de error del
proveedor (clave exacta, `sk-…`, `AIza…`, `Bearer …`, `?key=`), y hay tests que
comprueban que ni la clave ni un prefijo largo aparecen en audit, coste, estado,
trace o catálogo aunque el proveedor la devuelva en su cuerpo de error.

### No confundir: configurado / disponible / sano

- **Implementado**: existe un adapter real.
- **Configurado**: hay clave **y** modelo. Sin ellos el estado es `UNCONFIGURED` («Sin configurar»).
- **Habilitado**: el operador no lo ha desactivado (`MADRE_DISABLED_PROVIDERS`) → si no, `DISABLED`.
- **Disponible/ejecutable**: implementado + configurado + habilitado + sin fallo permanente ni circuito abierto.
- **Sano** (`healthy`): solo `true` tras una sonda real (`POST /api/madre/providers/health`, que llama al listado de modelos del proveedor, sin coste). Tener la clave puesta nunca lo marca sano: es `null` hasta que alguien lo comprueba.

Un proveedor sin configurar **jamás** produce una respuesta simulada: si se
intenta usar, falla con `PROVIDER_UNCONFIGURED`.

## Contrato de proveedor

`AIProvider` (`packages/domain/src/provider.ts`) expone id y nombre, modelos con
sus capacidades, `configuration()` (configurado + qué variables faltan),
`health()`, y `execute(task, signal)`. `execute` devuelve un `ProviderResult`
normalizado: `provider`, `model`, `text`, `usage` (tokens), `requestId` (el del
proveedor), `finishReason`, `latencyMs`, **`source`** (`real|mock`) y
**`simulated`**. El coste no lo calcula el adapter: lo calcula el
`CostController` con la tabla de precios central.

Un resultado real es siempre `source: real, simulated: false`, y uno simulado
`source: mock, simulated: true`. El runner comprueba la coherencia
(`assertProvenance`): si un adapter miente sobre su procedencia, el resultado se
descarta con un error interno; nunca se guarda una simulación como si fuese real
ni al revés.

### Errores estructurados

`ProviderError` lleva `code`, `stage`, `provider`, `model`, `retryable`,
`message` (en español, para la persona usuaria) y `cause`. Los códigos son en inglés:

| Código | Reintenta | Cuenta para el circuito | Permanente |
| --- | --- | --- | --- |
| `PROVIDER_UNCONFIGURED` | no | no | sí |
| `PROVIDER_AUTH_FAILED` (401/403) | no | no | sí |
| `PROVIDER_QUOTA_EXHAUSTED` (sin saldo/cuota) | no | no | sí |
| `PROVIDER_RATE_LIMITED` (429, respeta `Retry-After`) | sí | sí | no |
| `PROVIDER_TIMEOUT` | sí | sí | no |
| `PROVIDER_UNAVAILABLE` (5xx, red) | sí | sí | no |
| `PROVIDER_INVALID_RESPONSE` (200 mal formado) | sí (no si es una negativa) | sí | no |
| `PROVIDER_BAD_REQUEST` (resto de 4xx; 404 = modelo inexistente) | no | no | no |
| `PROVIDER_CAPABILITY_MISMATCH` | no | no | no |
| `PROVIDER_CIRCUIT_OPEN`, `PROVIDER_COST_UNKNOWN`, `PROVIDER_CANCELLED`, `PROVIDER_FAILED` | no | no | no |

## Smart Router

Para cada paso considera: habilitado, configurado, capacidad exigida (y capacidad
del modelo), circuito, salud, coste/presupuesto, requisitos del paso, prioridad e
historial de fallos. **No elige** un proveedor deshabilitado, sin configurar,
con circuito abierto, sin la capacidad pedida o que incumpla el presupuesto.

Cada decisión lleva una explicación estructurada (`decision.explanation`):
`selectedProvider`, `selectedModel`, `candidates` (con puntuación) y
`excludedCandidates`, cada uno con `code` (`disabled`, `not_implemented`,
`unconfigured`, `unavailable`, `unusable`, `circuit_open`, `avoided`,
`not_pinned`, `privacy`, `capability_mismatch`, `quality`, `freshness`,
`budget`, `cost_unknown`, `mock_last_resort`), `errorCode` y motivo en español.
La explicación va al audit (`provider.selected`) y a la traza (`step.router`).

Reglas que conviene conocer:

- **En modo MADRE el proveedor lo elige el router, no la petición.** `providerId`/`model` de `POST /api/missions` solo fijan el proveedor en modo `classic`. Si hay un proveedor real configurado, una misión MADRE «con mock» se ejecuta en el real (con coste). Para aislar un proveedor concreto se desactivan los demás con `MADRE_DISABLED_PROVIDERS` (así lo hace `pnpm e2e:real`).

- **La simulación solo se usa si no hay ningún proveedor real «en juego»**
  (implementado, configurado y habilitado). Si hay uno configurado pero no
  utilizable (circuito abierto, clave rechazada, evitado), el paso queda
  **BLOQUEADO** con el motivo y «No se sustituye por la simulación». Una misión
  fijada expresamente al mock sigue en el mock.
- Una sonda de salud `down` de menos de 120 s baja al candidato al final de la
  cola con un aviso; no lo excluye.
- El desempate es determinista: id de proveedor y luego id de modelo, en orden alfabético.
- Ante coste desconocido con presupuesto activo, se rechaza (`PROVIDER_COST_UNKNOWN`).

## Circuit breaker

Es el **existente** (`packages/madre/src/router/circuit.ts`), sin segunda
implementación. Flujo: fallo → `recordFailure` → umbral (3 seguidos) → **OPEN** →
el router lo excluye → tras el enfriamiento (60 s) → **HALF_OPEN** (a prueba) →
la siguiente llamada es la sonda: éxito = **CLOSED**, fallo = **OPEN** de nuevo.

Decisión documentada sobre errores permanentes: `AUTH_FAILED`,
`QUOTA_EXHAUSTED` y `UNCONFIGURED` **no** cuentan para el circuito. Esperar un
enfriamiento no arregla una clave rechazada, y el circuito reabriría el
proveedor contra el mismo rechazo cada minuto. En su lugar el proveedor pasa a
`ERROR` («fuera de servicio») y el router lo deja fuera hasta reiniciar el
servidor o corregir la configuración. Los errores transitorios (timeout, 429,
5xx, respuesta inválida) sí cuentan.

Además, si un fallo abre el circuito **durante** los reintentos de un paso, el
paso se reencamina en vez de enviar otra petición al proveedor que acaba de
quedar fuera.

## Coste

Se reutiliza `CostController`. Antes de ejecutar se estima (1500 tokens de
entrada / 700 de salida, fijos) y se aprueba o rechaza; tras la llamada se
registra el uso **real** (tokens del proveedor, latencia, `requestId`,
`source`). El coste se registra **antes** de validar la respuesta: una respuesta
inservible no sale gratis.

- Precio conocido → coste calculado con `MADRE_PRICES_JSON` (no hay precios en el código).
- Precio desconocido **con** presupuesto → se rechaza antes de ejecutar (0 peticiones).
- Precio desconocido **sin** presupuesto → se ejecuta y el coste queda `null`
  («sin precio conocido»), contado en `unpricedCalls`; **nunca** se convierte en 0.

## Procedencia (provenance)

Cada resultado, línea de coste, llamada de la traza y evento de auditoría lleva
`provider`, `model`, `source` y `simulated`. Se persiste con el estado de la
ejecución y el ledger de costes. Los resultados guardados antes de la Fase 2 se
leen por su id de proveedor (`mock` → simulado), nunca por conjetura. El juez de
QA distingue resultados reales, simulados, de herramienta y de QA: un resultado
simulado no puede pasar de `PASS_WITH_WARNINGS`.

## Auditoría

Los eventos usan la convención con puntos que ya tenía MADRE. Correspondencia
con los nombres pedidos:

| Pedido | Evento |
| --- | --- |
| `provider_selected` | `provider.selected` (lleva la explicación completa) |
| `provider_request_started` | `provider.request_started` |
| `provider_request_succeeded` | `provider.request_succeeded` |
| `provider_request_failed` | `provider.request_failed` (código, fase, reintentable) |
| `provider_circuit_opened` | `provider.circuit_opened` |
| `provider_circuit_half_open` | `provider.circuit_half_open` (se emite en el siguiente enrutado tras el enfriamiento) |
| `provider_circuit_closed` | `provider.circuit_closed` |
| `provider_cost_recorded` | `provider.cost_recorded` (`priced: false` si no hay precio) |
| `provider_unconfigured` | `provider.unconfigured` (una vez por ejecución y proveedor) |
| `provider_excluded` | `provider.excluded` |

La traza (`GET /api/missions/:id/trace`) reconstruye por paso `providerCalls`
(intentos, resultado, tokens, latencia, `requestId`), `router` (la explicación),
`source`, `simulated` y `providerError`.

## Cómo ejecutar los tests

```bash
pnpm test               # todo, offline: no necesita claves ni red
pnpm typecheck
pnpm typecheck:core
pnpm build
```

Los tests de proveedores son offline: los adapters se ejercitan con un
`fetch` falso a nivel HTTP (`packages/providers/src/real/real.test.ts`), el router
en `router/router.providers.test.ts`, y la integración completa en
`execution/engine.providers.test.ts` (misión → planner → motor → router →
adapter real → resultado → trace, con solo `fetch` sustituido). Los que
dependen de credenciales están separados: es el E2E real, más abajo.

## Cómo ejecutar el E2E real

```bash
export OPENAI_API_KEY=... OPENAI_MODEL=...          # y/o
export ANTHROPIC_API_KEY=... ANTHROPIC_MODEL=...    # y/o
export GOOGLE_API_KEY=... GEMINI_MODEL=...
pnpm e2e:real
```

Hace **llamadas reales y de pago**, así que solo se ejecuta para los proveedores
que tengan clave **y** modelo. Por cada uno lanza una misión mínima («Explica en
una frase qué es una cookie.», fijada a ese proveedor, sin rondas de revisión, ≈5
llamadas) y comprueba por HTTP: proveedor y modelo de cada paso, `source=real`,
`simulated=false`, `requestId`, tokens, coste, explicación del router en la
traza, eventos de auditoría y que ninguna respuesta contiene la clave.

Códigos de salida: `0` PASS, `1` FAIL, `3` **BLOCKED** (sin credenciales; no es
un fallo de implementación). Sin claves imprime
`REAL E2E: BLOCKED — credentials/provider not configured` y no hace ninguna
llamada. Si se define `*_API_BASE_URL`, el resultado se etiqueta como «endpoint
personalizado» y **no** cuenta como E2E real.

## Qué está verificado y qué no

- Verificado offline: adapters (petición, autenticación, extracción de texto y
  tokens, errores, timeout, cancelación), registro, router, circuito, coste,
  procedencia, auditoría, traza y el flujo completo del motor.
- La plomería del script E2E se comprobó contra un servidor local falso que
  imita la API de OpenAI (etiquetado como no real).
- **No verificado**: ninguna llamada a OpenAI, Anthropic o Gemini reales. Las
  formas de petición y respuesta siguen la documentación pública de cada API; hasta
  ejecutar `pnpm e2e:real` con claves reales, no se debe considerar comprobado que
  el proveedor las acepta.

## Qué queda

- Ejecutar `pnpm e2e:real` con claves reales de cada proveedor (requiere las claves).
- Ollama: necesita una máquina con Ollama; no se implementa en esta fase.
- `OpenAICompatibleProvider` sigue siendo un stub.
- El circuito no está compartido entre instancias y el fallo permanente dura hasta reiniciar.
- La estimación previa usa tamaños fijos (1500/700 tokens); la sonda del circuito es «la siguiente llamada», y con concurrencia puede haber más de una a prueba.
- Sin streaming, sin llamadas a herramientas nativas de los proveedores (los proveedores no llaman a herramientas por diseño).

## Backups when a free quota runs out

- **Text:** every configured provider is a backup for the others (Gemini, Groq, Cerebras, Mistral, NVIDIA, Cloudflare, and now OpenRouter with `OPENROUTER_API_KEY` + `OPENROUTER_MODEL` and SambaNova with `SAMBANOVA_API_KEY` + `SAMBANOVA_MODEL`). The router skips one that fails and tries the next.
- **Pictures** (`content/media.ts`, `chainImages`): Cloudflare, then Gemini's picture model (same key), then Hugging Face (`HF_TOKEN`), then Pollinations (no key). A service that reports its quota as spent (429) is skipped for 30 minutes.
- **Voice:** Gemini, then Cloudflare for English and French.
- **Transcription:** Cloudflare Whisper, then Groq Whisper (`GROQ_API_KEY`).
