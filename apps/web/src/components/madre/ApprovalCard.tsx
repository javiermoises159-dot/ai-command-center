import { useState } from 'react';

import type { MadreApproval } from '@acc/contracts';

import { api, ApiClientError } from '../../lib/api.ts';
import { relativeTime } from '../../lib/format.ts';
import { Icon } from '../icons.tsx';
import { Badge, Button, Panel } from '../primitives.tsx';
import { t } from '../../i18n/index.ts';

/**
 * One pending decision. A permission request asks yes or no; an input request
 * asks the person to paste what the run is missing (documents, figures). Nothing
 * proceeds until this is answered, and a denial only blocks what depends on it.
 */
export function ApprovalCard({ approval, onDecided }: { approval: MadreApproval; onDecided: () => void }) {
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState<'approve' | 'deny' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const isInput = approval.kind === 'input';
  const fieldId = `approval-note-${approval.id}`;

  async function decide(decision: 'approve' | 'deny') {
    setBusy(decision);
    setError(null);
    try {
      await api.decideApproval(approval.id, decision, note.trim() === '' ? undefined : note.trim());
      onDecided();
    } catch (caught) {
      setError(caught instanceof ApiClientError ? caught.message : t.missions.approval.sendFailed);
    } finally {
      setBusy(null);
    }
  }

  return (
    <Panel as="article" className="border-amber-500/40 p-4">
      <div className="flex items-start gap-3">
        <span className="mt-0.5 grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-amber-500/12 text-amber-700 ring-1 ring-amber-500/30 dark:text-amber-300">
          <Icon name={isInput ? 'file-text' : 'shield-check'} className="h-4 w-4" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <h3 className="text-[0.9rem] font-semibold text-[var(--color-ink)]">{approval.title}</h3>
            <Badge tone="warn">{isInput ? t.missions.approval.needsInput : t.missions.labels.permissionLevel(approval.level)}</Badge>
          </div>
          <p className="mt-1 whitespace-pre-wrap text-[0.8rem] leading-relaxed text-[var(--color-ink-dim)]">{approval.detail}</p>
          <p className="mt-1 text-[0.68rem] text-[var(--color-ink-faint)]">{t.missions.approval.asked(relativeTime(approval.createdAt))}</p>
        </div>
      </div>

      {isInput && (
        <div className="mt-3">
          <label htmlFor={fieldId} className="mb-1 block text-[0.72rem] font-medium text-[var(--color-ink-dim)]">
            {t.missions.approval.pasteLabel}
          </label>
          <textarea
            id={fieldId}
            value={note}
            onChange={(event) => setNote(event.target.value)}
            rows={5}
            placeholder={t.missions.approval.pastePlaceholder}
            className="w-full resize-y rounded-xl border border-[var(--color-edge-bright)] bg-[var(--color-field)] px-3 py-2.5 text-[0.86rem] leading-relaxed text-[var(--color-ink)] placeholder:text-[var(--color-ink-faint)] focus:border-[var(--color-signal)]/55 focus:outline-none focus:ring-2 focus:ring-[var(--color-signal)]/30"
          />
        </div>
      )}

      {error !== null && (
        <p role="alert" className="mt-2 text-[0.78rem] text-[var(--color-bad)]">
          {error}
        </p>
      )}

      <div className="mt-3 flex flex-wrap gap-2">
        <Button onClick={() => void decide('approve')} busy={busy === 'approve'} disabled={busy !== null || (isInput && note.trim() === '')} className="flex-1 sm:flex-none">
          <Icon name="check" className="h-4 w-4" />
          {isInput ? t.missions.approval.sendToCrew : t.common.actions.approve}
        </Button>
        <Button variant="ghost" onClick={() => void decide('deny')} busy={busy === 'deny'} disabled={busy !== null} className="flex-1 sm:flex-none">
          <Icon name="x" className="h-4 w-4" />
          {isInput ? t.missions.approval.continueWithout : t.common.actions.deny}
        </Button>
      </div>
    </Panel>
  );
}
