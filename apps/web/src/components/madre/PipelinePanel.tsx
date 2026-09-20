import type { MadrePipelineReport } from '@acc/contracts';

import { useMadreOverview } from '../../hooks/useMadre.ts';
import { Badge, ErrorBanner, Panel, Skeleton } from '../primitives.tsx';
import { t } from '../../i18n/index.ts';

const TONE = { ready: 'ok', partial: 'warn', blocked: 'neutral' } as const;
const LABEL = t.creative.pipeline.status;

/**
 * Readiness of the content and media pipelines, computed by the server from the
 * live agent and tool registries. A stage is "Can run" only when an active agent
 * and every tool it needs are really there.
 */
export function PipelinePanel() {
  const overview = useMadreOverview(false);

  if (overview.data === null) {
    return overview.error !== null ? <ErrorBanner message={overview.error} onRetry={overview.refresh} /> : <Skeleton className="h-40 w-full" />;
  }
  const { content, media } = overview.data.pipelines;

  return (
    <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
      <Pipeline title={t.creative.pipeline.contentTitle} report={content} />
      <Pipeline title={t.creative.pipeline.mediaTitle} report={media} />
    </div>
  );
}

function Pipeline({ title, report }: { title: string; report: MadrePipelineReport }) {
  return (
    <Panel as="article" className="p-4">
      <h3 className="text-[0.92rem] font-semibold text-[var(--color-ink)]">{title}</h3>
      <p className="mt-1 text-[0.76rem] text-[var(--color-ink-faint)]">{report.summary}</p>
      <ol className="mt-3 divide-y divide-[var(--color-edge)]">
        {report.stages.map((stage) => (
          <li key={stage.id} className="py-2.5">
            <div className="flex items-center justify-between gap-2">
              <span className="text-[0.84rem] font-medium text-[var(--color-ink)]">{stage.title}</span>
              <span className="flex gap-1.5">
                {stage.needsApproval && <Badge tone="warn">{t.creative.pipeline.asksFirst}</Badge>}
                <Badge tone={TONE[stage.status]}>{LABEL[stage.status]}</Badge>
              </span>
            </div>
            <p className="mt-0.5 text-[0.74rem] leading-relaxed text-[var(--color-ink-faint)]">{stage.note}</p>
          </li>
        ))}
      </ol>
    </Panel>
  );
}
