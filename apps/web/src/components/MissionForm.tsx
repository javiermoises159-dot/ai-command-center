import { useState, type FormEvent } from 'react';

import { api, ApiClientError } from '../lib/api.ts';
import { useRouter } from '../lib/router.tsx';
import { useProviders } from '../hooks/useApi.ts';
import { cx } from '../lib/format.ts';
import { Button, Panel } from './primitives.tsx';

const EXAMPLES = [
  'Launch an online cookie store in Italy',
  'Build a mobile app that helps people find a padel court in Turin',
  'Open a specialty coffee subscription in Berlin',
];

const MIN_LENGTH = 12;
const MAX_LENGTH = 4000;

export function MissionForm({ onCreated }: { onCreated?: () => void }) {
  const { navigate } = useRouter();
  const providers = useProviders();

  const [prompt, setPrompt] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fieldError, setFieldError] = useState<string | null>(null);

  const trimmed = prompt.trim();
  const tooShort = trimmed.length > 0 && trimmed.length < MIN_LENGTH;
  const canSubmit = trimmed.length >= MIN_LENGTH && trimmed.length <= MAX_LENGTH && !submitting;

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!canSubmit) return;

    setSubmitting(true);
    setError(null);
    setFieldError(null);

    try {
      const response = await api.createMission({ prompt: trimmed });
      setPrompt('');
      onCreated?.();
      navigate({ name: 'mission', id: response.mission.id });
    } catch (caught) {
      if (caught instanceof ApiClientError) {
        setFieldError(caught.issueFor('prompt') ?? null);
        setError(caught.issueFor('prompt') === undefined ? caught.message : null);
      } else {
        setError('Could not create the mission.');
      }
    } finally {
      setSubmitting(false);
    }
  }

  const activeProvider = providers.find((p) => p.availability === 'available');

  return (
    <Panel as="section" className="p-3.5">
      <form onSubmit={submit} className="space-y-3">
        <div>
          <label htmlFor="mission-prompt" className="mb-2 block text-sm font-medium text-[var(--color-ink)]">
            New mission
          </label>
          <textarea
            id="mission-prompt"
            value={prompt}
            onChange={(event) => setPrompt(event.target.value)}
            rows={4}
            maxLength={MAX_LENGTH}
            placeholder="Describe what you want to achieve. The crew will break it down."
            className={cx(
              'w-full resize-y rounded-xl border bg-black/25 px-3.5 py-3 leading-relaxed text-[var(--color-ink)]',
              'placeholder:text-[var(--color-ink-faint)] focus:outline-none focus:ring-2',
              fieldError !== null || tooShort
                ? 'border-rose-400/40 focus:ring-rose-400/40'
                : 'border-[var(--color-edge-bright)] focus:border-[var(--color-signal)]/50 focus:ring-[var(--color-signal)]/30',
            )}
          />
          <div className="mt-1.5 flex items-start justify-between gap-3 text-[0.7rem]">
            <span className={cx(tooShort || fieldError !== null ? 'text-rose-300' : 'text-[var(--color-ink-faint)]')}>
              {fieldError ?? (tooShort ? `At least ${MIN_LENGTH} characters.` : 'Eight agents will work this in sequence.')}
            </span>
            <span className="tabular shrink-0 text-[var(--color-ink-faint)]">
              {trimmed.length}/{MAX_LENGTH}
            </span>
          </div>
        </div>

        {error !== null && (
          <p className="rounded-lg border border-rose-400/25 bg-rose-500/8 px-3 py-2 text-[0.82rem] text-rose-200">
            {error}
          </p>
        )}

        <div className="flex flex-wrap gap-1.5">
          {EXAMPLES.map((example) => (
            <button
              key={example}
              type="button"
              onClick={() => setPrompt(example)}
              className="rounded-full bg-white/5 px-3 py-1.5 text-[0.72rem] text-[var(--color-ink-dim)] ring-1 ring-white/10 transition hover:bg-white/10 hover:text-[var(--color-ink)]"
            >
              {example}
            </button>
          ))}
        </div>

        <Button type="submit" disabled={!canSubmit} busy={submitting} className="w-full">
          {submitting ? 'Launching…' : 'Launch mission'}
        </Button>

        {activeProvider && (
          <p className="text-center text-[0.68rem] leading-relaxed text-[var(--color-ink-faint)]">
            Running on <span className="font-mono text-[var(--color-ink-dim)]">{activeProvider.label}</span>. Results
            are generated locally and carry no analytical value — connect a real provider for actual output.
          </p>
        )}
      </form>
    </Panel>
  );
}
