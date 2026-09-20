import { useState } from 'react';

import type { MadreTool } from '@acc/contracts';

import { Icon } from '../components/icons.tsx';
import { Badge, EmptyState, ErrorBanner, ListSkeleton, Notice, PageHeader, Panel, Segmented } from '../components/primitives.tsx';
import { useMadreTools } from '../hooks/useMadre.ts';
import { TOOL_STATUS_LABELS, titleCase, toolTone } from '../lib/madre.ts';
import { t } from '../i18n/index.ts';

/** Spanish name for a category code; falls back to the raw code made readable. */
function categoryLabel(category: string): string {
  return t.tools.category[category] ?? titleCase(category);
}

type StatusFilter = 'all' | MadreTool['status'];

export function ToolsPage() {
  const tools = useMadreTools();
  const [category, setCategory] = useState<string>('all');
  const [status, setStatus] = useState<StatusFilter>('all');

  if (tools.data === null) {
    return (
      <div className="space-y-5">
        <Header />
        {tools.error !== null ? <ErrorBanner message={tools.error} onRetry={tools.refresh} /> : <ListSkeleton rows={4} />}
      </div>
    );
  }

  const all = tools.data.items;
  const categories = [...new Set(all.map((tool) => tool.category))];
  const statuses = (Object.keys(TOOL_STATUS_LABELS) as MadreTool['status'][]).filter((s) => all.some((tool) => tool.status === s));
  const visible = all.filter((tool) => (category === 'all' || tool.category === category) && (status === 'all' || tool.status === status));
  const usable = all.filter((tool) => tool.status === 'AVAILABLE' || tool.status === 'CONNECTED').length;

  return (
    <div className="space-y-5">
      <Header />

      <Notice tone="live" title={t.tools.notice.title}>
        {t.tools.notice.body(usable, all.length)}
      </Notice>

      <div className="space-y-3">
        <Segmented
          label={t.tools.filters.categoryAria}
          value={category}
          onChange={setCategory}
          options={[{ value: 'all', label: t.tools.filters.all, count: all.length }, ...categories.map((c) => ({ value: c, label: categoryLabel(c), count: all.filter((tool) => tool.category === c).length }))]}
        />
        <Segmented
          label={t.tools.filters.statusAria}
          value={status}
          onChange={setStatus}
          options={[{ value: 'all' as const, label: t.tools.filters.anyStatus }, ...statuses.map((s) => ({ value: s, label: TOOL_STATUS_LABELS[s], count: all.filter((tool) => tool.status === s).length }))]}
        />
      </div>

      {visible.length === 0 ? (
        <EmptyState icon="wrench" title={t.tools.empty.title} body={t.tools.empty.body} />
      ) : (
        <div className="acc-stagger grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {visible.map((tool) => (
            <ToolCard key={tool.id} tool={tool} />
          ))}
        </div>
      )}
    </div>
  );
}

function Header() {
  return (
    <PageHeader
      icon="wrench"
      title={t.tools.title}
      description={t.tools.description}
    />
  );
}

function ToolCard({ tool }: { tool: MadreTool }) {
  const usable = tool.status === 'AVAILABLE' || tool.status === 'CONNECTED';
  return (
    <Panel as="article" className="flex flex-col p-4">
      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1">
          <h2 className="text-[0.95rem] font-semibold text-[var(--color-ink)]">{tool.name}</h2>
          <p className="text-[0.7rem] uppercase tracking-wider text-[var(--color-ink-faint)]">
            {categoryLabel(tool.category)} · {t.tools.locality[tool.locality] ?? tool.locality}
          </p>
        </div>
        <Badge tone={toolTone(tool.status)}>{TOOL_STATUS_LABELS[tool.status]}</Badge>
      </div>

      <p className="mt-3 text-[0.8rem] leading-relaxed text-[var(--color-ink-dim)]">{tool.description}</p>
      <p className="mt-2 flex-1 text-[0.76rem] leading-relaxed text-[var(--color-ink-faint)]">{tool.statusDetail}</p>

      <div className="mt-3 flex flex-wrap gap-1.5 border-t border-[var(--color-edge)] pt-3">
        {tool.permissions.map((p) => (
          <Badge key={p} tone={p === 'READ' ? 'neutral' : 'warn'}>
            {t.tools.permission[p] ?? p.replace('_', ' ')}
          </Badge>
        ))}
        <Badge tone={tool.risk === 'low' ? 'ok' : tool.risk === 'medium' ? 'neutral' : 'warn'}>{t.tools.risk(tool.risk)}</Badge>
        <Badge>{tool.cost.model === 'unknown' ? t.tools.card.costUnknown : (t.tools.costModel[tool.cost.model] ?? tool.cost.model.replace('_', ' '))}</Badge>
      </div>

      {!usable && tool.auth.required && (
        <p className="mt-3 flex items-start gap-2 text-[0.74rem] leading-relaxed text-[var(--color-ink-faint)]">
          <Icon name="plug" className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <span>
            <span className="font-medium text-[var(--color-ink-dim)]">{t.tools.card.toConnect}</span>
            {t.tools.authKind[tool.auth.kind] ?? tool.auth.kind.replace('_', ' ')}
            {tool.auth.envVars.length > 0 && <> — {t.tools.card.setOnServer(tool.auth.envVars.join(', '))}</>}
          </span>
        </p>
      )}
    </Panel>
  );
}
