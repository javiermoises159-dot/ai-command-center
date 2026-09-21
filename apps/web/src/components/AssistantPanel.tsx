import { useEffect, useRef, useState } from 'react';

import { askAssistant, mediaStatus, publishTo, type AssistantStatus, type ContentItem, type MediaStatus } from '../lib/content.ts';
import { Button, Notice, Panel, SectionTitle } from './primitives.tsx';

const EXAMPLES = ['Prepárame una campaña de 2 semanas para mis cookies en Turín', 'Créame un logo para CookieLab', 'Corta mi último vídeo en 3 clips verticales con subtítulos'];

/**
 * One box: say what you want and the app does it with its real tools (pieces,
 * campaigns with dates and pictures, clips). Publishing is never automatic: each
 * finished piece gets a button, and the tap is the approval.
 */
export function AssistantPanel() {
  const [request, setRequest] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<AssistantStatus | null>(null);
  const [caps, setCaps] = useState<MediaStatus | null>(null);
  const [published, setPublished] = useState<Record<string, string>>({});
  const [publishing, setPublishing] = useState<string | null>(null);
  const alive = useRef(true);
  useEffect(() => {
    mediaStatus().then(setCaps).catch(() => setCaps(null));
    return () => {
      alive.current = false;
    };
  }, []);

  async function go() {
    setBusy(true);
    setError(null);
    setStatus(null);
    setPublished({});
    try {
      await askAssistant(request, setStatus, () => alive.current);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'No se pudo completar la petición.');
    } finally {
      setBusy(false);
    }
  }

  async function publishAll(target: 'telegram' | 'facebook', label: string, items: ContentItem[]) {
    if (!window.confirm(`¿Publicar ${items.length} ${items.length === 1 ? 'pieza' : 'piezas'} ahora en ${label}? Se enviarán de verdad.`)) return;
    setPublishing(target);
    for (const item of items) {
      try {
        await publishTo(item.id, target);
        setPublished((p) => ({ ...p, [`${target}:${item.id}`]: 'ok' }));
      } catch (e) {
        setPublished((p) => ({ ...p, [`${target}:${item.id}`]: e instanceof Error ? e.message : 'error' }));
      }
    }
    setPublishing(null);
  }

  const items = status?.items ?? [];
  const done = status?.state === 'done';
  return (
    <Panel className="space-y-3 p-4">
      <SectionTitle>Pídeme lo que quieras</SectionTitle>
      <p className="text-sm text-[var(--color-ink-dim)]">Escribe qué necesitas y lo hago con las herramientas de la app: campañas con fechas y fotos, logos, publicaciones, clips de tus vídeos. Publicar lo apruebas tú con un botón.</p>
      <textarea
        value={request}
        onChange={(e) => setRequest(e.target.value)}
        rows={3}
        maxLength={2000}
        placeholder={EXAMPLES[0]}
        className="w-full rounded-xl border border-[var(--color-edge-bright)] bg-transparent p-3 text-base"
      />
      <div className="flex flex-wrap gap-2">
        {EXAMPLES.map((e) => (
          <button key={e} type="button" onClick={() => setRequest(e)} className="rounded-full border border-[var(--color-edge-bright)] px-3 py-1.5 text-[0.75rem] text-[var(--color-ink-dim)]">
            {e}
          </button>
        ))}
      </div>
      <Button busy={busy} disabled={request.trim() === ''} onClick={() => void go()}>Hazlo</Button>
      {busy && <p className="text-[0.75rem] text-[var(--color-ink-faint)]">{status?.step ?? 'Entendiendo tu petición'}. Puede tardar un par de minutos.</p>}
      {error !== null && <Notice tone="mock" title="No se pudo">{error}</Notice>}
      {status !== null && status.reply !== '' && <p className="text-sm">{status.reply}</p>}
      {(status?.notes ?? []).map((n) => <Notice key={n} tone="mock" title="Aviso">{n}</Notice>)}
      {done && items.length > 0 && (
        <div className="space-y-2">
          <p className="text-sm font-medium">{items.length} {items.length === 1 ? 'pieza creada' : 'piezas creadas'}</p>
          <ul className="space-y-1 text-sm text-[var(--color-ink-dim)]">
            {items.map((i) => (
              <li key={i.id}>
                {i.title}{i.scheduledAt !== null ? ` · ${new Date(i.scheduledAt).toLocaleDateString('es', { day: 'numeric', month: 'short' })}` : ''}
                {(caps?.publishers ?? []).map((p) => (published[`${p.target}:${i.id}`] === 'ok' ? <span key={p.target} className="ml-2 text-emerald-600">✓ {p.label}</span> : published[`${p.target}:${i.id}`] !== undefined ? <span key={p.target} className="ml-2 text-red-600">{published[`${p.target}:${i.id}`]}</span> : null))}
              </li>
            ))}
          </ul>
          <div className="flex flex-wrap gap-2">
            {(caps?.publishers ?? []).map((p) => (
              <Button key={p.target} variant="ghost" busy={publishing === p.target} onClick={() => void publishAll(p.target, p.label, items)}>Publicar todo en {p.label}</Button>
            ))}
          </div>
          {(caps?.publishers ?? []).length === 0 && <p className="text-[0.75rem] text-[var(--color-ink-faint)]">Aún no hay ninguna red conectada para publicar desde aquí; puedes compartirlas desde Contenidos con el móvil.</p>}
          <p className="text-sm"><a className="underline" href="#/content">Abrir en Contenidos</a></p>
        </div>
      )}
      {done && items.length === 0 && (status?.notes ?? []).length === 0 && status?.reply === '' && <p className="text-sm text-[var(--color-ink-dim)]">Hecho.</p>}
    </Panel>
  );
}
