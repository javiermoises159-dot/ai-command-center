import { useState } from 'react';

import { Icon } from '../components/icons.tsx';
import { Badge, EmptyState, IconTile, Notice, PageHeader, Panel, Segmented } from '../components/primitives.tsx';
import { cx } from '../lib/format.ts';
import {
  STATUS_LABELS,
  TOOLS,
  TOOL_CATEGORIES,
  countByStatus,
  type ToolCategory,
  type ToolEntry,
  type ToolStatus,
} from '../lib/tools-catalog.ts';

const STATUS_TONE: Record<ToolStatus, 'ok' | 'warn' | 'neutral'> = {
  available: 'ok',
  mock: 'warn',
  not_connected: 'neutral',
};

const STATUS_ACCENT: Record<ToolStatus, string> = {
  available: 'emerald',
  mock: 'amber',
  not_connected: 'cyan',
};

export function ToolsPage() {
  const [category, setCategory] = useState<ToolCategory | 'all'>('all');
  const [status, setStatus] = useState<ToolStatus | 'all'>('all');

  const counts = countByStatus();
  const visible = TOOLS.filter(
    (tool) => (category === 'all' || tool.category === category) && (status === 'all' || tool.status === status),
  );

  const categoryOptions = [
    { value: 'all' as const, label: 'All', count: TOOLS.length },
    ...TOOL_CATEGORIES.map((c) => ({ value: c, label: c, count: TOOLS.filter((t) => t.category === c).length })),
  ];
  const statusOptions = [
    { value: 'all' as const, label: 'Any status' },
    { value: 'available' as const, label: 'Available', count: counts.available },
    { value: 'mock' as const, label: 'Mock', count: counts.mock },
    { value: 'not_connected' as const, label: 'Not connected', count: counts.not_connected },
  ];

  return (
    <div className="space-y-5">
      <PageHeader
        icon="wrench"
        title="Tools"
        description="The catalog of capabilities agents will be able to use. Each card says plainly whether it works today, is simulated, or is not built yet."
      />

      <Notice tone="preview" title="No external tools are connected yet">
        This screen is a roadmap. Only the mission orchestrator is real; text generation is simulated; everything else is
        waiting to be built. Nothing here can send, publish or spend anything.
      </Notice>

      <div className="space-y-3">
        <Segmented label="Filter tools by category" value={category} onChange={setCategory} options={categoryOptions} />
        <Segmented label="Filter tools by status" value={status} onChange={setStatus} options={statusOptions} />
      </div>

      {visible.length === 0 ? (
        <EmptyState
          icon="wrench"
          title="No tools match"
          body="No tool has this combination of category and status. Try widening one of the filters."
        />
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

function ToolCard({ tool }: { tool: ToolEntry }) {
  return (
    <Panel as="article" className={cx('flex flex-col p-4', tool.status === 'not_connected' && 'opacity-90')}>
      <div className="flex items-start gap-3">
        <IconTile icon={tool.icon} accent={STATUS_ACCENT[tool.status]} />
        <div className="min-w-0 flex-1">
          <h2 className="text-[0.95rem] font-semibold text-[var(--color-ink)]">{tool.name}</h2>
          <p className="text-[0.7rem] uppercase tracking-wider text-[var(--color-ink-faint)]">{tool.category}</p>
        </div>
        <Badge tone={STATUS_TONE[tool.status]}>{STATUS_LABELS[tool.status]}</Badge>
      </div>

      <p className="mt-3 flex-1 text-[0.8rem] leading-relaxed text-[var(--color-ink-dim)]">{tool.description}</p>

      {tool.requires !== null && (
        <p className="mt-3 flex items-start gap-2 border-t border-[var(--color-edge)] pt-3 text-[0.74rem] leading-relaxed text-[var(--color-ink-faint)]">
          <Icon name="plug" className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <span>
            <span className="font-medium text-[var(--color-ink-dim)]">To connect: </span>
            {tool.requires}
          </span>
        </p>
      )}
    </Panel>
  );
}
