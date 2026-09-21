import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';

import { Badge, Button, EmptyState, ErrorBanner, ListSkeleton, Notice, PageHeader, Panel, SectionTitle } from '../components/primitives.tsx';
import {
  PLATFORM_LABELS,
  VOICE_LANG_LABELS,
  base64ToBlob,
  createContent,
  deleteContent,
  generateImage,
  generateVoice,
  getMedia,
  groupContent,
  isoToLocalInput,
  listContent,
  localInputToIso,
  mediaStatus,
  shareContent,
  updateContent,
  type Bucket,
  type ContentItem,
  type MediaStatus,
  type Platform,
  type VoiceLang,
} from '../lib/content.ts';

// min-w-0 + appearance-none: iOS Safari gives date inputs an intrinsic width that overflows the card.
const FIELD = 'block min-h-[44px] w-full min-w-0 max-w-full appearance-none rounded-xl border border-[var(--color-edge-bright)] bg-transparent px-3 text-base text-[var(--color-ink)]';
const LABEL = 'mb-1 block text-[0.8rem] font-semibold text-[var(--color-ink)]';

const BUCKETS: { key: Bucket; title: string; empty: string }[] = [
  { key: 'due', title: 'Toca publicar', empty: 'Nada pendiente ahora mismo.' },
  { key: 'scheduled', title: 'Programados', empty: 'Ninguna pieza con fecha futura.' },
  { key: 'draft', title: 'Borradores', empty: 'Sin borradores.' },
  { key: 'published', title: 'Publicados', empty: 'Todavía no has publicado nada desde aquí.' },
];

function when(iso: string | null): string {
  if (iso === null) return 'Sin fecha';
  return new Date(iso).toLocaleString('es', { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
}

/**
 * The content calendar: prepare a post (text, picture, voice-over), give it a
 * date, and when the time comes hand it to the phone's share sheet with one tap.
 * Nothing is posted by itself.
 */
export function ContentPage() {
  const [items, setItems] = useState<ContentItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [media, setMedia] = useState<MediaStatus | null>(null);
  const [now, setNow] = useState(() => Date.now());

  const load = useCallback(async () => {
    try {
      setItems(await listContent());
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'No se pudo cargar el calendario.');
    }
  }, []);

  useEffect(() => {
    void load();
    mediaStatus().then(setMedia).catch(() => setMedia(null));
    const timer = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(timer);
  }, [load]);

  const groups = useMemo(() => (items === null ? null : groupContent(items, now)), [items, now]);

  function replace(item: ContentItem) {
    setItems((current) => (current === null ? current : current.map((i) => (i.id === item.id ? item : i))));
  }

  return (
    <div>
      <PageHeader icon="calendar" title="Contenidos" description="Prepara publicaciones con texto, imagen y voz, dales fecha, y cuando toque las publicas con un toque desde el móvil." />

      {media !== null && !media.image && (
        <div className="mb-4">
          <Notice title="Imágenes sin activar">
            Faltan CLOUDFLARE_ACCOUNT_ID y CLOUDFLARE_API_TOKEN en Render. El calendario funciona igual; solo no podrás generar imágenes todavía.
          </Notice>
        </div>
      )}

      <NewPiece
        onCreated={(item) => setItems((current) => [item, ...(current ?? [])])}
      />

      {error !== null && <div className="mt-4"><ErrorBanner message={error} onRetry={() => void load()} /></div>}
      {groups === null && error === null && <div className="mt-6"><ListSkeleton rows={3} /></div>}

      {groups !== null && items !== null && items.length === 0 && (
        <div className="mt-6">
          <EmptyState icon="calendar" title="Aún no hay contenidos" body="Crea la primera pieza arriba. Puedes empezar solo con el título y completar el resto después." />
        </div>
      )}

      {groups !== null &&
        items !== null &&
        items.length > 0 &&
        BUCKETS.map(({ key, title, empty }) => (
          <section key={key} className="mt-7">
            <SectionTitle>{`${title} · ${groups[key].length}`}</SectionTitle>
            {groups[key].length === 0 ? (
              <p className="text-[0.82rem] text-[var(--color-ink-faint)]">{empty}</p>
            ) : (
              <div className="space-y-3">
                {groups[key].map((item) => (
                  <Piece key={item.id} item={item} media={media} onChange={replace} onDeleted={(id) => setItems((c) => (c ?? []).filter((i) => i.id !== id))} due={key === 'due'} />
                ))}
              </div>
            )}
          </section>
        ))}
    </div>
  );
}

function NewPiece({ onCreated }: { onCreated: (item: ContentItem) => void }) {
  const [title, setTitle] = useState('');
  const [platform, setPlatform] = useState<Platform>('instagram');
  const [when_, setWhen] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit() {
    setBusy(true);
    setError(null);
    try {
      const scheduledAt = localInputToIso(when_);
      onCreated(await createContent({ title, platform, ...(scheduledAt === null ? {} : { scheduledAt }) }));
      setTitle('');
      setWhen('');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'No se pudo crear.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Panel className="space-y-3 p-4 sm:p-5">
      <div>
        <label htmlFor="c-title" className={LABEL}>Nueva pieza</label>
        <input id="c-title" className={FIELD} placeholder="Ej.: Reel del lanzamiento de CookieLab" value={title} maxLength={120} onChange={(e) => setTitle(e.target.value)} />
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        <div>
          <label htmlFor="c-platform" className={LABEL}>Dónde la publicarás</label>
          <select id="c-platform" className={FIELD} value={platform} onChange={(e) => setPlatform(e.target.value as Platform)}>
            {(Object.keys(PLATFORM_LABELS) as Platform[]).map((p) => <option key={p} value={p}>{PLATFORM_LABELS[p]}</option>)}
          </select>
        </div>
        <div>
          <label htmlFor="c-when" className={LABEL}>Fecha y hora (opcional)</label>
          <input id="c-when" type="datetime-local" className={FIELD} value={when_} onChange={(e) => setWhen(e.target.value)} />
        </div>
      </div>
      {error !== null && <p role="alert" className="text-[0.82rem] text-rose-500">{error}</p>}
      <Button onClick={() => void submit()} busy={busy} disabled={title.trim() === ''}>Crear pieza</Button>
    </Panel>
  );
}

function Piece({ item, media, due, onChange, onDeleted }: { item: ContentItem; media: MediaStatus | null; due: boolean; onChange: (i: ContentItem) => void; onDeleted: (id: string) => void }) {
  const [open, setOpen] = useState(due);
  const [caption, setCaption] = useState(item.caption);
  const [imagePrompt, setImagePrompt] = useState(item.imagePrompt);
  const [voiceText, setVoiceText] = useState(item.voiceText);
  const langs = media?.voiceLangs ?? [];
  const [chosenLang, setLang] = useState<VoiceLang | null>(null);
  // Spanish first (the app's language), else whatever the configured voice offers.
  const lang: VoiceLang | null = chosenLang !== null && langs.includes(chosenLang) ? chosenLang : langs.includes('es') ? 'es' : (langs[0] ?? null);
  const [when_, setWhen] = useState(isoToLocalInput(item.scheduledAt));
  const [imageUrl, setImageUrl] = useState<string | null>(null);
  const [audioUrl, setAudioUrl] = useState<string | null>(null);
  const [imageData, setImageData] = useState<{ base64: string; mime: string } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);

  // Media is fetched only when the card is opened, and re-fetched when it changes.
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    const urls: string[] = [];
    if (item.hasImage) {
      getMedia(item.id, 'image')
        .then((m) => {
          if (cancelled) return;
          const url = URL.createObjectURL(base64ToBlob(m.base64, m.mime));
          urls.push(url);
          setImageUrl(url);
          setImageData(m);
        })
        .catch(() => undefined);
    } else {
      setImageUrl(null);
      setImageData(null);
    }
    if (item.hasAudio) {
      getMedia(item.id, 'audio')
        .then((m) => {
          if (cancelled) return;
          const url = URL.createObjectURL(base64ToBlob(m.base64, m.mime));
          urls.push(url);
          setAudioUrl(url);
        })
        .catch(() => undefined);
    } else {
      setAudioUrl(null);
    }
    return () => {
      cancelled = true;
      urls.forEach((u) => URL.revokeObjectURL(u));
    };
  }, [open, item.id, item.hasImage, item.hasAudio, item.updatedAt]);

  async function run(name: string, work: () => Promise<ContentItem | void>) {
    setBusy(name);
    setError(null);
    setInfo(null);
    try {
      const result = await work();
      if (result) onChange(result);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Algo ha fallado.');
    } finally {
      setBusy(null);
    }
  }

  const save = () =>
    run('save', async () => {
      const scheduledAt = localInputToIso(when_);
      const saved = await updateContent(item.id, { caption, imagePrompt, voiceText, scheduledAt });
      setInfo('Guardado.');
      return saved;
    });

  const publish = () =>
    run('share', async () => {
      // Save the latest text first so what is shared is what is on screen.
      await updateContent(item.id, { caption });
      const outcome = await shareContent({ ...item, caption }, imageData);
      if (outcome === 'cancelled') return;
      setInfo(outcome === 'copied' ? 'El texto está copiado. Pégalo en la app donde vayas a publicar.' : 'Enviado a tu app. Cuando lo hayas publicado, márcalo como publicado.');
    });

  return (
    <Panel className="p-4">
      <button type="button" onClick={() => setOpen((v) => !v)} className="flex w-full items-start justify-between gap-3 text-left" aria-expanded={open}>
        <span className="min-w-0">
          <span className="block truncate text-[0.95rem] font-semibold text-[var(--color-ink)]">{item.title}</span>
          <span className="mt-0.5 block text-[0.78rem] text-[var(--color-ink-dim)]">{item.status === 'published' ? `Publicado ${when(item.publishedAt)}` : when(item.scheduledAt)}</span>
        </span>
        <span className="flex shrink-0 flex-wrap justify-end gap-1.5">
          <Badge>{PLATFORM_LABELS[item.platform]}</Badge>
          {item.hasImage && <Badge tone="signal">Imagen</Badge>}
          {item.hasAudio && <Badge tone="signal">Voz</Badge>}
          {due && <Badge tone="warn">Toca ya</Badge>}
        </span>
      </button>

      {open && (
        <div className="mt-4 space-y-4">
          <Field label="Texto de la publicación" id={`cap-${item.id}`}>
            <textarea id={`cap-${item.id}`} rows={5} className={`${FIELD} py-2`} value={caption} maxLength={4000} onChange={(e) => setCaption(e.target.value)} />
          </Field>

          <Field label="Fecha y hora" id={`when-${item.id}`}>
            <input id={`when-${item.id}`} type="datetime-local" className={FIELD} value={when_} onChange={(e) => setWhen(e.target.value)} />
          </Field>

          <div className="space-y-2 rounded-xl border border-[var(--color-line)] p-3">
            <Field label="Imagen: descríbela" id={`img-${item.id}`}>
              <textarea id={`img-${item.id}`} rows={2} className={`${FIELD} py-2`} placeholder="Ej.: Close-up photo of chocolate chip cookies on a rustic wooden table, warm light" value={imagePrompt} maxLength={1500} onChange={(e) => setImagePrompt(e.target.value)} />
            </Field>
            <p className="text-[0.75rem] text-[var(--color-ink-faint)]">Escríbela en inglés: el generador gratuito entiende mucho mejor el inglés que el español.</p>
            {imageUrl !== null && <img src={imageUrl} alt={item.title} className="max-h-80 w-full rounded-xl object-contain" />}
            <Button variant="ghost" disabled={media?.image !== true || imagePrompt.trim() === ''} busy={busy === 'image'} onClick={() => void run('image', () => generateImage(item.id, imagePrompt))}>
              {item.hasImage ? 'Generar otra imagen' : 'Generar imagen'}
            </Button>
          </div>

          <div className="space-y-2 rounded-xl border border-[var(--color-line)] p-3">
            <Field label="Voz: qué debe decir" id={`voice-${item.id}`}>
              <textarea id={`voice-${item.id}`} rows={3} className={`${FIELD} py-2`} value={voiceText} maxLength={1500} onChange={(e) => setVoiceText(e.target.value)} />
            </Field>
            <Field label="Idioma de la voz" id={`lang-${item.id}`}>
              <select id={`lang-${item.id}`} className={FIELD} value={lang ?? ''} disabled={langs.length === 0} onChange={(e) => setLang(e.target.value as VoiceLang)}>
                {langs.map((l) => <option key={l} value={l}>{VOICE_LANG_LABELS[l]}</option>)}
              </select>
            </Field>
            {langs.length === 0 && <p className="text-[0.75rem] text-[var(--color-ink-faint)]">La voz no está activada: falta GEMINI_API_KEY en Render.</p>}
            {langs.length > 0 && !langs.includes('es') && <p className="text-[0.75rem] text-[var(--color-ink-faint)]">Con esta voz solo hay inglés y francés. Para español e italiano añade GEMINI_API_KEY en Render.</p>}
            {audioUrl !== null && <audio controls src={audioUrl} className="w-full" />}
            <Button variant="ghost" disabled={lang === null || voiceText.trim() === ''} busy={busy === 'voice'} onClick={() => lang !== null && void run('voice', () => generateVoice(item.id, voiceText, lang))}>
              {item.hasAudio ? 'Generar otra voz' : 'Generar voz'}
            </Button>
          </div>

          {error !== null && <p role="alert" className="text-[0.82rem] text-rose-500">{error}</p>}
          {info !== null && <p role="status" className="text-[0.82rem] text-emerald-500">{info}</p>}

          <div className="flex flex-wrap gap-2">
            <Button onClick={() => void save()} busy={busy === 'save'}>Guardar</Button>
            {item.status !== 'published' && (
              <>
                <Button variant="ghost" onClick={() => void publish()} busy={busy === 'share'}>Publicar ahora</Button>
                <Button variant="ghost" onClick={() => void run('done', () => updateContent(item.id, { status: 'published' }))} busy={busy === 'done'}>Marcar como publicado</Button>
              </>
            )}
            {item.status === 'published' && (
              <Button variant="ghost" onClick={() => void run('undo', () => updateContent(item.id, { status: 'draft', scheduledAt: null }))} busy={busy === 'undo'}>Volver a borrador</Button>
            )}
            <Button
              variant="danger"
              busy={busy === 'delete'}
              onClick={() => {
                if (window.confirm('¿Borrar esta pieza?')) void run('delete', async () => { await deleteContent(item.id); onDeleted(item.id); });
              }}
            >
              Borrar
            </Button>
          </div>
        </div>
      )}
    </Panel>
  );
}

function Field({ label, id, children }: { label: string; id: string; children: ReactNode }) {
  return (
    <div>
      <label htmlFor={id} className={LABEL}>{label}</label>
      {children}
    </div>
  );
}
