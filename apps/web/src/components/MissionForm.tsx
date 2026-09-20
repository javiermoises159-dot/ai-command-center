import { useRef, useState, type FormEvent, type KeyboardEvent } from 'react';

import { api, ApiClientError } from '../lib/api.ts';
import { useRouter } from '../lib/router.tsx';
import { useProviders } from '../hooks/useApi.ts';
import { cx } from '../lib/format.ts';
import { t } from '../i18n/index.ts';
import { Icon } from './icons.tsx';
import { Button } from './primitives.tsx';

const EXAMPLES = t.missions.form.examples;

const MIN_LENGTH = 12;
const MAX_LENGTH = 4000;

/**
 * The command box on the Dashboard.
 *
 * Submitting calls the real `POST /api/missions`, which returns immediately
 * (HTTP 202) while the agents keep working, and then navigates to that mission's
 * detail screen so the pipeline can be watched live.
 */
export function MissionForm({ onCreated }: { onCreated?: () => void }) {
  const { navigate } = useRouter();
  const providers = useProviders();
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const [prompt, setPrompt] = useState('');
  const [classic, setClassic] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fieldError, setFieldError] = useState<string | null>(null);

  const trimmed = prompt.trim();
  const tooShort = trimmed.length > 0 && trimmed.length < MIN_LENGTH;
  const canSubmit = trimmed.length >= MIN_LENGTH && trimmed.length <= MAX_LENGTH && !submitting;

  async function submit(event?: FormEvent) {
    event?.preventDefault();
    if (!canSubmit) return;

    setSubmitting(true);
    setError(null);
    setFieldError(null);

    try {
      const response = await api.createMission({ prompt: trimmed, mode: classic ? 'classic' : 'madre' });
      setPrompt('');
      onCreated?.();
      navigate({ name: 'mission', id: response.mission.id });
    } catch (caught) {
      if (caught instanceof ApiClientError) {
        setFieldError(caught.issueFor('prompt') ?? null);
        setError(caught.issueFor('prompt') === undefined ? caught.message : null);
      } else {
        setError(t.missions.form.createFailed);
      }
    } finally {
      setSubmitting(false);
    }
  }

  // Cmd/Ctrl + Enter submits, the way people expect from a command box.
  function onKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      void submit();
    }
  }

  const activeProvider = providers.find((p) => p.availability === 'available');
  const invalid = fieldError !== null || tooShort;

  return (
    <form
      onSubmit={submit}
      className="panel relative overflow-hidden p-4 sm:p-5"
      aria-label={t.missions.form.ariaLabel}
    >
      {/* A soft signal glow behind the box, so it reads as the focal point. */}
      <div
        className="pointer-events-none absolute -top-24 left-1/2 h-48 w-[42rem] -translate-x-1/2 rounded-full bg-[var(--color-signal)]/10 blur-3xl"
        aria-hidden
      />

      <div className="relative space-y-3.5">
        <div>
          <label htmlFor="mission-prompt" className="sr-only">
            {t.missions.form.label}
          </label>
          <textarea
            ref={textareaRef}
            id="mission-prompt"
            value={prompt}
            onChange={(event) => setPrompt(event.target.value)}
            onKeyDown={onKeyDown}
            rows={4}
            maxLength={MAX_LENGTH}
            placeholder={t.missions.form.placeholder}
            aria-invalid={invalid}
            className={cx(
              'w-full resize-y rounded-xl border bg-[var(--color-field)] px-4 py-3.5 leading-relaxed text-[var(--color-ink)]',
              'placeholder:text-[var(--color-ink-faint)] focus:outline-none focus:ring-2',
              invalid
                ? 'border-rose-500/45 focus:ring-rose-500/35'
                : 'border-[var(--color-edge-bright)] focus:border-[var(--color-signal)]/55 focus:ring-[var(--color-signal)]/30',
            )}
          />
          <div className="mt-1.5 flex items-start justify-between gap-3 text-[0.72rem]">
            <span className={cx(invalid ? 'text-[var(--color-bad)]' : 'text-[var(--color-ink-faint)]')}>
              {fieldError ??
                (tooShort
                  ? t.missions.form.tooShort(MIN_LENGTH)
                  : t.missions.form.hint)}
            </span>
            <span className="tabular shrink-0 text-[var(--color-ink-faint)]">
              {trimmed.length}/{MAX_LENGTH}
            </span>
          </div>
        </div>

        {error !== null && (
          <p
            role="alert"
            className="rounded-lg border border-rose-500/30 bg-rose-500/8 px-3 py-2 text-[0.82rem] text-rose-800 dark:text-rose-200"
          >
            {error}
          </p>
        )}

        <label htmlFor="mission-classic" className="flex min-h-[44px] cursor-pointer items-center gap-2.5 text-[0.76rem] text-[var(--color-ink-dim)]">
          <input
            id="mission-classic"
            type="checkbox"
            checked={classic}
            onChange={(event) => setClassic(event.target.checked)}
            className="h-4 w-4 accent-[var(--color-signal)]"
          />
          {t.missions.form.classicOption}
        </label>

        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex flex-wrap gap-1.5">
            {EXAMPLES.map((example) => (
              <button
                key={example}
                type="button"
                onClick={() => {
                  setPrompt(example);
                  textareaRef.current?.focus();
                }}
                className="max-w-full truncate rounded-full bg-[var(--color-tint)] px-3 py-1.5 text-[0.72rem] text-[var(--color-ink-dim)] ring-1 ring-[var(--color-line)] transition hover:bg-[var(--color-tint-strong)] hover:text-[var(--color-ink)]"
              >
                {example}
              </button>
            ))}
          </div>

          <Button type="submit" disabled={!canSubmit} busy={submitting} className="w-full shrink-0 sm:w-auto sm:min-w-[11rem]">
            {!submitting && <Icon name="play" className="h-4 w-4" />}
            {submitting ? t.missions.form.submitting : t.missions.form.submit}
          </Button>
        </div>

        {activeProvider !== undefined && (
          <p className="text-[0.7rem] leading-relaxed text-[var(--color-ink-faint)]">
            {t.missions.form.activeProviderNote(activeProvider.label)}
          </p>
        )}
      </div>
    </form>
  );
}
