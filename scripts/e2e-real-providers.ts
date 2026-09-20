/**
 * REAL end-to-end check of MADRE against the vendors' actual APIs.
 *
 *   pnpm e2e:real
 *
 * It makes REAL, BILLED calls, so it only runs for a provider whose API key AND
 * model are in the environment (OPENAI_API_KEY + OPENAI_MODEL, ANTHROPIC_API_KEY
 * + ANTHROPIC_MODEL, GOOGLE_API_KEY + GEMINI_MODEL). For each configured provider
 * it runs ONE small mission, pinned to that provider, in-process against the
 * real server stack (in-memory persistence, no database needed), and checks
 * from the outside — over HTTP — that:
 *
 *   • every step was executed by that provider and model,
 *   • every result says source=real, simulated=false, and has a request id,
 *   • token usage was reported, and the cost is recorded (or honestly unknown),
 *   • the trace shows the router's explanation and the provider calls,
 *   • no API key appears in any response.
 *
 * It never simulates, never falls back to the mock and never prints PASS unless
 * a real call was made and every check held.
 *
 * Exit codes:  0 = PASS for every configured provider
 *              1 = FAIL (a real call was made and something was wrong)
 *              3 = BLOCKED (no credentials): NOT an implementation failure
 */

import type { AddressInfo } from 'node:net';

import { loadConfig } from '../apps/server/src/config.ts';
import { createContainer } from '../apps/server/src/container.ts';
import { createExpressApp } from '../apps/server/src/express-adapter.ts';

const MISSION = 'Explica en una frase qué es una cookie.';

interface Target {
  id: 'openai' | 'anthropic' | 'gemini';
  keyVar: string;
  modelVar: string;
  key: string | undefined;
  model: string | undefined;
}

function targets(env: NodeJS.ProcessEnv): Target[] {
  const v = (name: string): string | undefined => {
    const value = env[name]?.trim();
    return value === undefined || value === '' ? undefined : value;
  };
  return [
    { id: 'openai', keyVar: 'OPENAI_API_KEY', modelVar: 'OPENAI_MODEL', key: v('OPENAI_API_KEY'), model: v('OPENAI_MODEL')?.split(',')[0]?.trim() },
    { id: 'anthropic', keyVar: 'ANTHROPIC_API_KEY', modelVar: 'ANTHROPIC_MODEL', key: v('ANTHROPIC_API_KEY'), model: v('ANTHROPIC_MODEL')?.split(',')[0]?.trim() },
    { id: 'gemini', keyVar: 'GOOGLE_API_KEY', modelVar: 'GEMINI_MODEL', key: v('GOOGLE_API_KEY') ?? v('GEMINI_API_KEY'), model: v('GEMINI_MODEL')?.split(',')[0]?.trim() },
  ];
}

const env = process.env;
const all = targets(env);
const ready = all.filter((t) => t.key !== undefined && t.model !== undefined);

if (ready.length === 0) {
  console.log('REAL E2E: BLOCKED — credentials/provider not configured');
  for (const t of all) {
    const missing = [t.key === undefined ? t.keyVar : null, t.model === undefined ? t.modelVar : null].filter(Boolean).join(' + ');
    console.log(`  - ${t.id}: falta ${missing}`);
  }
  console.log('No se hizo ninguna llamada real. No es un fallo de la implementación: define las variables y vuelve a ejecutar.');
  process.exit(3);
}

// A custom endpoint means the calls do not go to the vendor. That is legitimate
// (a gateway, a self-hosted OpenAI-compatible server) but it is not the vendor's
// real API, so the result must never be reported as a REAL pass.
const customEndpoints = ['OPENAI_API_BASE_URL', 'ANTHROPIC_API_BASE_URL', 'GEMINI_API_BASE_URL'].filter((name) => (env[name] ?? '').trim() !== '');
if (customEndpoints.length > 0) {
  console.log(`AVISO: ${customEndpoints.join(', ')} apunta(n) a un endpoint personalizado. Esta ejecución NO cuenta como E2E real contra el proveedor.`);
}

const secrets = ready.map((t) => t.key!);
const failures: string[] = [];

let base = '';
async function api(path: string, init?: { method?: string; body?: unknown }): Promise<any> {
  const response = await fetch(`${base}${path}`, {
    method: init?.method ?? 'GET',
    headers: { 'content-type': 'application/json' },
    ...(init?.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
  });
  const text = await response.text();
  for (const secret of secrets) if (text.includes(secret)) failures.push(`La respuesta de ${path} contiene una API key.`);
  if (!response.ok) throw new Error(`${path} → HTTP ${response.status}: ${text.slice(0, 300)}`);
  return JSON.parse(text);
}

const summary: string[] = [];
for (const target of ready) {
  const label = `${target.id}/${target.model}`;
  const before = failures.length;
  console.log(`\n== ${label} ==`);

  // In MADRE mode the Smart Router — not the request — chooses the provider. To test
  // THIS provider and no other, the others are switched off for this run (the same
  // operator switch, MADRE_DISABLED_PROVIDERS, that production uses).
  const config = loadConfig({
    ...env,
    PERSISTENCE: 'memory',
    PORT: '0',
    // Only the model under test, so the router cannot pick a sibling model of the same provider.
    [target.modelVar]: target.model!,
    MADRE_DISABLED_PROVIDERS: all.filter((t) => t.id !== target.id).map((t) => t.id).join(','),
    // One pass, no revision loops: the smallest number of billed calls.
    MADRE_MAX_REVISION_ROUNDS: '0',
    MADRE_PARALLELISM: '1',
  });
  const container = await createContainer(config);
  const server = createExpressApp(container).listen(0);
  await new Promise<void>((resolve) => server.once('listening', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {

    const health = await api('/api/madre/providers/health', { method: 'POST' });
    const profile = (health.items as any[]).find((p) => p.id === target.id);
    console.log(`  salud: ${profile?.health?.status ?? '?'} (${profile?.health?.detail ?? ''})`);

    const created = await api('/api/missions', {
      method: 'POST',
      body: { prompt: MISSION, providerId: target.id, model: target.model, mode: 'madre', autoStart: true },
    });
    const missionId: string = created.mission.id;

    let status = 'pending';
    const deadline = Date.now() + 5 * 60_000;
    while (Date.now() < deadline) {
      const detail = await api(`/api/missions/${missionId}`);
      status = detail.status;
      if (status === 'completed' || status === 'failed' || status === 'cancelled') break;
      await new Promise((r) => setTimeout(r, 1500));
    }
    console.log(`  misión: ${status}`);
    if (status !== 'completed') failures.push(`${label}: la misión terminó en «${status}».`);

    const { trace } = await api(`/api/missions/${missionId}/trace`);
    const steps = (trace.steps as any[]).filter((s) => s.provider !== null);
    if (steps.length === 0) failures.push(`${label}: ningún paso llegó a un proveedor.`);
    let calls = 0;
    let tokens = 0;
    let unpriced = 0;
    for (const s of steps) {
      if (s.provider !== target.id || s.model !== target.model) failures.push(`${label}: «${s.title}» lo ejecutó ${s.provider}/${s.model}.`);
      if (s.source !== 'real' || s.simulated !== false) failures.push(`${label}: «${s.title}» no está marcado como real (source=${s.source}, simulated=${s.simulated}).`);
      if (s.router?.selectedProvider !== target.id) failures.push(`${label}: «${s.title}» no tiene explicación del router.`);
      const ok = (s.providerCalls as any[]).filter((c) => c.outcome === 'succeeded');
      if (ok.length === 0) failures.push(`${label}: «${s.title}» no tiene ninguna llamada correcta en el trace.`);
      for (const c of ok) {
        calls += 1;
        tokens += (c.promptTokens ?? 0) + (c.completionTokens ?? 0);
        if (!c.requestId) failures.push(`${label}: una llamada de «${s.title}» no trae request id.`);
        if (!(c.promptTokens > 0 && c.completionTokens > 0)) failures.push(`${label}: una llamada de «${s.title}» no informó de tokens.`);
      }
      if (s.costUsd === null) unpriced += 1;
    }
    const final = await api(`/api/missions/${missionId}`);
    const finalText: string = final.finalResult ?? '';
    if (finalText.trim().length === 0) failures.push(`${label}: no hay resultado final.`);
    console.log(`  llamadas reales: ${calls} · tokens: ${tokens} · coste conocido: ${trace.cost?.knownUsd ?? 0} USD${trace.cost?.unpricedCalls > 0 ? ` (≥: ${trace.cost.unpricedCalls} llamada(s) sin precio en MADRE_PRICES_JSON, su coste es desconocido, no 0)` : ''}`);
    console.log(`  resultado final: ${finalText.replace(/\s+/g, ' ').slice(0, 160)}…`);

    const audit = (await api(`/api/missions/${missionId}/madre`)).audit as any[];
    for (const type of ['provider.selected', 'provider.request_started', 'provider.request_succeeded', 'provider.cost_recorded']) {
      if (!audit.some((e) => e.type === type)) failures.push(`${label}: falta el evento de auditoría ${type}.`);
    }

    if (calls === 0) failures.push(`${label}: no hubo ninguna llamada real.`);
    summary.push(`${label}: ${failures.length === before && calls > 0 ? 'PASS' : 'FAIL'} (${calls} llamadas reales)`);
  } catch (error) {
    failures.push(`${label}: error inesperado: ${error instanceof Error ? error.message : String(error)}`);
    summary.push(`${label}: FAIL`);
  } finally {
    server.close();
    await container.shutdown();
  }
}

console.log('\n' + summary.join('\n'));
for (const t of all.filter((x) => !ready.includes(x))) console.log(`${t.id}: BLOCKED — credentials/provider not configured`);
if (failures.length > 0) {
  console.log('\nREAL E2E: FAIL');
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(1);
}
console.log(customEndpoints.length > 0 ? '\nE2E CON ENDPOINT PERSONALIZADO: PASS (no es un E2E real contra el proveedor)' : '\nREAL E2E: PASS');
