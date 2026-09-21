/**
 * "Build me a website" end to end: the compiler plans the page step, the model
 * (a scripted OpenAI-compatible host) writes it, the report carries the page as
 * delivered, and the publish endpoint sends exactly that page to GitHub.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { silentLogger } from '@acc/domain';
import { createMadre } from '@acc/madre';
import { InProcessJobQueue, MissionService } from '@acc/orchestrator';
import { createProviderRegistry } from '@acc/providers';
import { createMemoryRepositories } from '@acc/repositories/memory';

import { GitHubPagesPublisher, type GitHubFetch } from '../publish/github-pages.ts';
import { createRouter } from './router.ts';

const PAGE = `<!doctype html>\n<html lang="it"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Biscotti Rossi</title></head><body><h1>Biscotti Rossi</h1>${'<p>Biscotto artigianale</p>'.repeat(80)}<script>const WHATSAPP_NUMBER="";</script></body></html>`;

function scriptedHost(): typeof fetch {
  return (async (_url: string, init?: { body?: string }) => {
    const body = JSON.parse(init?.body ?? '{}') as { messages?: { content?: string }[] };
    const prompt = body.messages?.map((m) => m.content ?? '').join('\n') ?? '';
    const text = /Construir la página web/.test(prompt) && !/OUTPUT FROM THE CREW/.test(prompt)
      ? `Página de pedidos por WhatsApp. Cambia nombre, precios y número.\n\n\`\`\`html\n${PAGE}\n\`\`\`\n\nNo tiene servidor ni pagos.`
      : `# Informe\n\nResumen del trabajo del equipo. ${/BEGIN CONSTRUIR/i.test(prompt) ? (prompt.includes(PAGE) ? 'ERROR: LA PÁGINA COMPLETA LLEGÓ AL INTEGRADOR.' : 'La página está adjunta.') : 'Contenido del paso.'}`;
    return new Response(JSON.stringify({ id: 'r', choices: [{ message: { content: text }, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 10 } }), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as unknown as typeof fetch;
}

describe('website mission end to end', () => {
  it('plans the page step, keeps the page in the report and publishes that exact page', async () => {
    const repositories = createMemoryRepositories();
    const providers = createProviderRegistry({
      mock: { minLatencyMs: 0, maxLatencyMs: 0 },
      openaiCompatible: { baseUrl: 'https://host.example/v1', apiKey: 'k', models: ['m'], fetch: scriptedHost() as never },
    });
    const queue = new InProcessJobQueue({ logger: silentLogger });
    const madre = createMadre({
      repositories, providers, enqueue: (job) => queue.enqueue(job), engine: { agentTimeoutMs: 5_000 }, sleep: () => Promise.resolve(),
      prices: { 'openai-compatible': { inputPer1kUsd: 0, outputPer1kUsd: 0 } },
    });
    queue.process(async (job) => { await madre.execute({ runId: job.runId, mode: 'madre' }); });
    queue.start();
    const missions = new MissionService({ repositories, providers, queue, logger: silentLogger, defaultMode: 'madre' });

    const calls: { method: string; url: string; body: any }[] = [];
    const github: GitHubFetch = async (url, init) => {
      const path = url.replace('https://api.github.com', '').split('?')[0]!;
      calls.push({ method: init.method, url: path, body: init.body === undefined ? null : JSON.parse(init.body) });
      if (path === '/repos/javier/acc-sites') return { ok: true, status: 200, json: async () => ({ private: false, default_branch: 'main' }) };
      if (init.method === 'PUT') return { ok: true, status: 201, json: async () => ({ commit: { html_url: 'https://github.com/c/1' } }) };
      if (path.endsWith('/pages')) return { ok: true, status: 200, json: async () => ({}) };
      return { ok: false, status: 404, json: async () => ({}) };
    };
    const router = createRouter({ missions, providers, madre: madre.service, logger: silentLogger, version: 't', sitePublisher: new GitHubPagesPublisher('tok', 'javier/acc-sites', github) });
    const call = async (method: 'GET' | 'POST', path: string, body?: unknown) => {
      const r = await router.handle({ method, path, query: {}, body, headers: {} });
      return { status: r.status, body: r.body as any };
    };

    const created = await call('POST', '/api/missions', { prompt: 'Créame una página web y una app de pedidos para mi pastelería de galletas en Turín' });
    const id = created.body.mission.id as string;
    await queue.drain();

    const snap = (await call('GET', `/api/missions/${id}/madre`)).body;
    assert.ok(snap.plan.steps.some((s: any) => s.capability === 'engineering.site'), 'the plan has a page-building step');

    const detail = (await call('GET', `/api/missions/${id}`)).body;
    assert.equal(detail.status, 'completed');
    const report = detail.runs[0].finalResult as string;
    assert.ok(report.includes(PAGE), 'the report carries the page exactly as delivered');
    assert.match(report, /## Página web/);
    assert.doesNotMatch(report, /LA PÁGINA COMPLETA LLEGÓ AL INTEGRADOR/, 'the integrator only got a note, not the whole page');

    const published = await call('POST', `/api/missions/${id}/site/publish`);
    assert.equal(published.status, 200);
    assert.match(published.body.site.url, /^https:\/\/javier\.github\.io\/acc-sites\/biscotti-rossi-[a-z0-9]{6}\/$/);
    const put = calls.find((c) => c.method === 'PUT')!;
    assert.equal(Buffer.from(put.body.content, 'base64').toString('utf8'), PAGE);
  });
});
