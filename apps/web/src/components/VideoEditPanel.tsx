import { useEffect, useRef, useState } from 'react';

import { base64ToBlob, getMedia, listContent, MAX_UPLOAD_MB, runEdit, uploadVideo, type ContentItem } from '../lib/content.ts';
import { Button, Notice, Panel, SectionTitle } from './primitives.tsx';

const LINK = 'inline-flex min-h-[44px] items-center justify-center rounded-xl border border-[var(--color-edge-bright)] px-4 text-sm text-[var(--color-ink)]';

interface Clip { id: string; title: string; url: string }

/**
 * Upload a video you recorded and say what to do with it ("3 clips de 20 segundos,
 * verticales y con subtítulos"). The clips come back as drafts; nothing is published.
 */
export function VideoEditPanel() {
  const [sources, setSources] = useState<ContentItem[]>([]);
  const [sourceId, setSourceId] = useState('');
  const [request, setRequest] = useState('');
  const [uploading, setUploading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [step, setStep] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [notes, setNotes] = useState<string[]>([]);
  const [clips, setClips] = useState<Clip[]>([]);
  const alive = useRef(true);
  const urls = useRef<string[]>([]);
  useEffect(() => {
    listContent()
      .then((items) => {
        const withVideo = items.filter((i) => i.hasVideo);
        setSources(withVideo);
        setSourceId((current) => current || (withVideo[0]?.id ?? ''));
      })
      .catch(() => undefined);
    return () => {
      alive.current = false;
      for (const u of urls.current) URL.revokeObjectURL(u);
    };
  }, []);

  async function pick(file: File | undefined) {
    if (file === undefined) return;
    setUploading(true);
    setError(null);
    try {
      const item = await uploadVideo(file);
      setSources((s) => [item, ...s]);
      setSourceId(item.id);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'No se pudo subir el vídeo.');
    } finally {
      setUploading(false);
    }
  }

  async function go() {
    setBusy(true);
    setError(null);
    setNotes([]);
    setClips([]);
    setStep('Empezando');
    try {
      const done = await runEdit(sourceId, request, setStep, () => alive.current);
      setNotes(done.notes);
      const out: Clip[] = [];
      for (const item of done.items) {
        try {
          const m = await getMedia(item.id, 'video');
          const url = URL.createObjectURL(base64ToBlob(m.base64, m.mime));
          urls.current.push(url);
          out.push({ id: item.id, title: item.title, url });
        } catch {
          /* that clip is simply not there */
        }
      }
      setClips(out);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'No se pudo editar.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Panel className="space-y-3 p-4">
      <SectionTitle>Tus vídeos: editar y hacer clips</SectionTitle>
      <p className="text-sm text-[var(--color-ink-dim)]">
        Sube un vídeo tuyo (máximo {MAX_UPLOAD_MB} MB, si es más largo recórtalo antes en tu iPhone) y dile qué quieres: «3 clips de 20 segundos, verticales y con subtítulos», «quita los primeros 5 segundos»… Los clips quedan como borradores en Contenidos.
      </p>
      <label className={`${LINK} cursor-pointer`}>
        {uploading ? 'Subiendo…' : 'Subir un vídeo'}
        <input type="file" accept="video/*" className="hidden" disabled={uploading || busy} onChange={(e) => { void pick(e.target.files?.[0]); e.target.value = ''; }} />
      </label>
      {sources.length > 0 && (
        <select value={sourceId} onChange={(e) => setSourceId(e.target.value)} className="w-full rounded-xl border border-[var(--color-edge-bright)] bg-transparent p-3 text-base">
          {sources.map((s) => <option key={s.id} value={s.id}>{s.title}</option>)}
        </select>
      )}
      <textarea
        value={request}
        onChange={(e) => setRequest(e.target.value)}
        rows={3}
        maxLength={1500}
        placeholder="¿Qué edición quieres?"
        className="w-full rounded-xl border border-[var(--color-edge-bright)] bg-transparent p-3 text-base"
      />
      <Button busy={busy} disabled={sourceId === '' || request.trim() === '' || uploading} onClick={() => void go()}>Editar</Button>
      {busy && <p className="text-[0.75rem] text-[var(--color-ink-faint)]">{step}. Puede tardar varios minutos en el servidor gratuito; puedes esperar aquí.</p>}
      {error !== null && <Notice tone="mock" title="No se pudo">{error}</Notice>}
      {notes.map((n) => <Notice key={n} tone="mock" title="Aviso">{n}</Notice>)}
      {clips.map((c) => (
        <div key={c.id} className="space-y-2">
          <p className="text-sm font-medium">{c.title}</p>
          <video controls playsInline src={c.url} className="max-h-[28rem] w-full rounded-xl bg-black" />
          <a href={c.url} download={`${c.title.slice(0, 40) || 'clip'}.mp4`} className={LINK}>Descargar clip</a>
        </div>
      ))}
      {clips.length > 0 && <p className="text-sm"><a className="underline" href="#/content">Abrir en Contenidos</a></p>}
    </Panel>
  );
}
