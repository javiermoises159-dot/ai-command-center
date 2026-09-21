import { useEffect, useRef, useState } from 'react';

import { base64ToBlob, createInStudio, getMedia, waitForVideo, type ContentItem } from '../lib/content.ts';
import { Button, Notice, Panel, SectionTitle } from './primitives.tsx';

const EXT: Record<string, string> = { 'image/jpeg': 'jpg', 'image/png': 'png', 'audio/wav': 'wav', 'audio/mpeg': 'mp3', 'video/mp4': 'mp4' };
const LINK = 'inline-flex min-h-[44px] items-center justify-center rounded-xl border border-[var(--color-edge-bright)] px-4 text-sm text-[var(--color-ink)]';

interface Made { kind: 'image' | 'audio' | 'video'; url: string; ext: string }

/**
 * "Créame un logo": type what you want, the crew's AI prepares it and the real
 * generators (picture, voice, video) make it. Everything lands in the calendar
 * as a draft; nothing is published.
 */
export function StudioPanel() {
  const [request, setRequest] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [item, setItem] = useState<ContentItem | null>(null);
  const [notes, setNotes] = useState<string[]>([]);
  const [made, setMade] = useState<Made[]>([]);
  const [waiting, setWaiting] = useState(false);
  const alive = useRef(true);
  const urls = useRef<string[]>([]);
  useEffect(() => () => {
    alive.current = false;
    for (const u of urls.current) URL.revokeObjectURL(u);
  }, []);

  async function load(created: ContentItem, kinds: Made['kind'][]) {
    const out: Made[] = [];
    for (const kind of kinds) {
      try {
        const m = await getMedia(created.id, kind);
        const url = URL.createObjectURL(base64ToBlob(m.base64, m.mime));
        urls.current.push(url);
        out.push({ kind, url, ext: EXT[m.mime] ?? 'bin' });
      } catch {
        /* that file is simply not there */
      }
    }
    return out;
  }

  async function go() {
    setBusy(true);
    setError(null);
    setItem(null);
    setNotes([]);
    setMade([]);
    try {
      const res = await createInStudio(request);
      setItem(res.item);
      setNotes(res.notes);
      const kinds: Made['kind'][] = [];
      if (res.item.hasImage) kinds.push('image');
      if (res.item.hasAudio) kinds.push('audio');
      setMade(await load(res.item, kinds));
      if (res.videoStarted) {
        setWaiting(true);
        try {
          const done = await waitForVideo(res.item.id, () => alive.current);
          setItem(done);
          setMade((m) => m);
          const video = await load(done, ['video']);
          setMade((m) => [...m, ...video]);
        } catch (e) {
          setNotes((n) => [...n, e instanceof Error ? e.message : 'No se pudo crear el vídeo.']);
        } finally {
          setWaiting(false);
        }
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'No se pudo crear.');
    } finally {
      setBusy(false);
    }
  }

  const name = (item?.title ?? 'creacion').slice(0, 40) || 'creacion';
  return (
    <Panel className="space-y-3 p-4">
      <SectionTitle>Estudio: dile qué crear</SectionTitle>
      <p className="text-sm text-[var(--color-ink-dim)]">
        Escribe lo que quieres, por ejemplo «un logo para mi tienda de cookies en Turín» o «un reel para presentar mi tienda». La IA lo prepara y lo crea sola. Queda guardado como borrador en Contenidos.
      </p>
      <textarea
        value={request}
        onChange={(e) => setRequest(e.target.value)}
        rows={3}
        maxLength={2000}
        placeholder="¿Qué quieres crear?"
        className="w-full rounded-xl border border-[var(--color-edge-bright)] bg-transparent p-3 text-base"
      />
      <Button busy={busy} disabled={request.trim() === ''} onClick={() => void go()}>Crear</Button>
      {busy && <p className="text-[0.75rem] text-[var(--color-ink-faint)]">{waiting ? 'Creando el vídeo: puede tardar un minuto.' : 'Preparando y creando: unos 20–40 segundos.'}</p>}
      {error !== null && <Notice tone="mock" title="No se pudo">{error}</Notice>}
      {notes.map((n) => <Notice key={n} tone="mock" title="Aviso">{n}</Notice>)}
      {item !== null && <p className="text-sm font-medium">{item.title}</p>}
      {made.map((m) => (
        <div key={m.kind} className="space-y-2">
          {m.kind === 'image' && <img src={m.url} alt={name} className="max-h-96 w-full rounded-xl object-contain" />}
          {m.kind === 'audio' && <audio controls src={m.url} className="w-full" />}
          {m.kind === 'video' && <video controls playsInline src={m.url} className="max-h-[28rem] w-full rounded-xl bg-black" />}
          <a href={m.url} download={`${name}.${m.ext}`} className={LINK}>Descargar {m.kind === 'image' ? 'imagen' : m.kind === 'audio' ? 'audio' : 'vídeo'}</a>
        </div>
      ))}
      {item !== null && <p className="text-sm"><a className="underline" href="#/content">Abrir en Contenidos</a></p>}
    </Panel>
  );
}
