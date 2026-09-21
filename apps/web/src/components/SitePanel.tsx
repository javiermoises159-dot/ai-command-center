import { useEffect, useMemo, useState } from 'react';
import { checkSiteHtml, extractSiteHtml } from '@acc/contracts';

import { getSiteStatus, htmlDownloadUrl, publishSite, type PublishedSite, type SitePublishingStatus } from '../lib/site.ts';
import { Button, Notice, Panel, SectionTitle } from './primitives.tsx';

/**
 * The website the crew built: a preview, a download, and — when the server has
 * a GitHub token — a "Publicar" button that puts it online for free. The tap is
 * the approval; nothing is published on its own.
 */
export function SitePanel({ missionId, finalResult }: { missionId: string; finalResult: string | null }) {
  const html = useMemo(() => extractSiteHtml(finalResult), [finalResult]);
  const problems = useMemo(() => (html === null ? [] : checkSiteHtml(html)), [html]);
  const downloadUrl = useMemo(() => (html === null ? null : htmlDownloadUrl(html)), [html]);
  useEffect(() => () => { if (downloadUrl !== null) URL.revokeObjectURL(downloadUrl); }, [downloadUrl]);
  const [status, setStatus] = useState<SitePublishingStatus | null>(null);
  const [preview, setPreview] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [published, setPublished] = useState<PublishedSite | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (html === null) return;
    getSiteStatus().then(setStatus).catch(() => setStatus({ configured: false, repo: null }));
  }, [html]);

  if (html === null) return null;

  async function publish() {
    setBusy(true);
    setError(null);
    try {
      setPublished(await publishSite(missionId));
    } catch (e) {
      setError(e instanceof Error ? e.message : 'No se pudo publicar.');
    } finally {
      setBusy(false);
    }
  }

  async function copy(url: string) {
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    } catch {
      /* the address is on screen: it can be copied by hand */
    }
  }

  const ok = problems.length === 0;

  return (
    <section>
      <SectionTitle>Página web lista</SectionTitle>
      <Panel className="space-y-3 p-4 sm:p-5">
        <p className="text-[0.85rem] text-[var(--color-ink-dim)]">
          El equipo construyó una página completa en un solo archivo. Míralo antes de publicarlo: los pedidos llegan por WhatsApp (no hay servidor ni pagos).
        </p>

        {!ok && (
          <Notice title="No se puede publicar tal cual">{problems.join('; ')}.</Notice>
        )}

        <div className="flex flex-wrap gap-2">
          <Button variant="ghost" onClick={() => setPreview((v) => !v)}>
            {preview ? 'Ocultar vista previa' : 'Ver vista previa'}
          </Button>
          <a
            href={downloadUrl ?? undefined}
            download="index.html"
            className="inline-flex min-h-[44px] items-center justify-center rounded-xl border border-[var(--color-edge-bright)] px-4 text-sm text-[var(--color-ink)]"
          >
            Descargar index.html
          </a>
          {ok && status?.configured === true && published === null && (
            <Button onClick={publish} busy={busy}>
              Publicar en GitHub Pages
            </Button>
          )}
        </div>

        {preview && (
          // No allow-same-origin: the page runs in an opaque origin and cannot
          // read this app's cookies, storage or session.
          <iframe
            title="Vista previa de la página"
            srcDoc={html}
            sandbox="allow-scripts"
            className="h-[28rem] w-full rounded-lg border border-[var(--color-edge)] bg-white"
          />
        )}

        {status?.configured === false && ok && (
          <Notice tone="preview" title="Publicar gratis todavía no está activo">
            Para publicar con un toque hace falta un repositorio público de GitHub y un token: guarda GITHUB_TOKEN y GITHUB_SITES_REPO en Render (los pasos están en el README, «Publicar páginas»). Mientras tanto, puedes descargar el archivo.
          </Notice>
        )}

        {error !== null && (
          <p role="alert" className="rounded-lg border border-rose-500/30 bg-rose-500/8 px-3 py-2 text-[0.82rem] text-rose-900 dark:text-rose-200">
            {error}
          </p>
        )}

        {published !== null && (
          <div className="space-y-2 rounded-lg border border-emerald-500/30 bg-emerald-500/8 p-3 text-[0.85rem]">
            <p className="font-semibold text-[var(--color-ink)]">Publicada</p>
            <a href={published.url} target="_blank" rel="noopener noreferrer" className="break-all font-semibold text-[var(--color-signal)] underline">
              {published.url}
            </a>
            <p className="text-[0.78rem] text-[var(--color-ink-dim)]">GitHub tarda entre 1 y 2 minutos en mostrar la primera vez. Si da «404», espera un momento y recarga.</p>
            {published.note !== null && <p className="text-[0.78rem] text-amber-800 dark:text-amber-200">{published.note}</p>}
            <div>
              <Button variant="ghost" onClick={() => copy(published.url)}>
                {copied ? 'Copiada' : 'Copiar dirección'}
              </Button>
            </div>
          </div>
        )}
      </Panel>
    </section>
  );
}
