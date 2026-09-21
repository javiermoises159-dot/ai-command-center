import { useEffect, useMemo, useState } from 'react';
import { applyWhatsappNumber, checkSiteHtml, extractSiteHtml, whatsappDigits } from '@acc/contracts';

import { getSiteStatus, htmlDownloadUrl, publishSite, type PublishedSite, type SitePublishingStatus } from '../lib/site.ts';
import { Button, Notice, Panel, SectionTitle } from './primitives.tsx';

/**
 * The website the crew built: a preview, a download, and — when the server has
 * a GitHub token — a "Publicar" button that puts it online for free. The tap is
 * the approval; nothing is published on its own.
 */
export function SitePanel({ missionId, finalResult }: { missionId: string; finalResult: string | null }) {
  const original = useMemo(() => extractSiteHtml(finalResult), [finalResult]);
  const [whatsapp, setWhatsapp] = useState(() => {
    try {
      return localStorage.getItem('acc.whatsapp') ?? '';
    } catch {
      return '';
    }
  });
  const html = useMemo(() => (original === null ? null : applyWhatsappNumber(original, whatsapp)), [original, whatsapp]);
  const numberOk = whatsappDigits(whatsapp) !== null;
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
    if (original === null) return;
    getSiteStatus().then(setStatus).catch(() => setStatus({ configured: false, repo: null }));
  }, [original]);

  if (html === null) return null;

  async function publish() {
    setBusy(true);
    setError(null);
    try {
      setPublished(await publishSite(missionId, whatsapp));
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

        <div>
          <label htmlFor="wa-number" className="mb-1 block text-[0.8rem] font-semibold text-[var(--color-ink)]">
            Tu número de WhatsApp (con prefijo)
          </label>
          <input
            id="wa-number"
            type="tel"
            inputMode="tel"
            autoComplete="tel"
            placeholder="+39 333 1234567"
            value={whatsapp}
            onChange={(e) => {
              setWhatsapp(e.target.value);
              try {
                localStorage.setItem('acc.whatsapp', e.target.value);
              } catch {
                /* a convenience only */
              }
            }}
            className="min-h-[44px] w-full rounded-xl border border-[var(--color-edge-bright)] bg-transparent px-3 text-base text-[var(--color-ink)]"
          />
          <p className="mt-1 text-[0.75rem] text-[var(--color-ink-faint)]">
            {numberOk ? 'Los pedidos llegarán a este número.' : 'Sin número, el botón de WhatsApp avisará de que falta configurarlo.'}
          </p>
        </div>

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
          {ok && numberOk && status?.configured === true && published === null && (
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
