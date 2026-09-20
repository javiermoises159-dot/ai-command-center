import { useState } from 'react';

import type { MadreAgentSpec } from '@acc/contracts';

import { t } from '../../i18n/index.ts';
import { useMadreAgents } from '../../hooks/useMadre.ts';
import { agentMeta } from '../../lib/agents-meta.ts';
import { titleCase } from '../../lib/madre.ts';
import { Badge, ErrorBanner, IconTile, Panel, SectionTitle, Segmented, Skeleton } from '../primitives.tsx';

type Filter = 'all' | 'active' | 'planned';

const RISK_TONE = { low: 'ok', medium: 'neutral', high: 'warn', critical: 'bad' } as const;

/**
 * The full MADRE agent registry: the eight agents that run today and the ones
 * that are only prepared. A planned agent is never offered work; the card says
 * what it would need.
 */
export function RegistryAgents() {
  const agents = useMadreAgents();
  const [filter, setFilter] = useState<Filter>('all');

  if (agents.data === null) {
    return agents.error !== null ? (
      <ErrorBanner message={agents.error} onRetry={agents.refresh} />
    ) : (
      <div className="grid grid-cols-1 gap-3 md:grid-cols-2" role="status" aria-label={t.agents.registry.loadingAria}>
        {Array.from({ length: 4 }, (_, i) => (
          <Skeleton key={i} className="h-32 w-full" />
        ))}
      </div>
    );
  }

  const all = agents.data.items;
  const visible = all.filter((a) => filter === 'all' || (filter === 'active' ? a.status === 'active' : a.status !== 'active'));

  return (
    <section className="space-y-3">
      <SectionTitle>{t.agents.registry.title}</SectionTitle>
      <Segmented
        label={t.agents.registry.filterAria}
        value={filter}
        onChange={setFilter}
        options={[
          { value: 'all', label: t.agents.registry.filters.all, count: all.length },
          { value: 'active', label: t.agents.registry.filters.active, count: all.filter((a) => a.status === 'active').length },
          { value: 'planned', label: t.agents.registry.filters.planned, count: all.filter((a) => a.status !== 'active').length },
        ]}
      />
      <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
        {visible.map((agent) => (
          <RegistryCard key={agent.id} agent={agent} />
        ))}
      </div>
    </section>
  );
}

function RegistryCard({ agent }: { agent: MadreAgentSpec }) {
  const active = agent.status === 'active';
  const permissionsNeedCare = agent.permissions.some((p) => p !== 'READ' && p !== 'WRITE');
  return (
    <Panel as="article" className="p-4">
      <div className="flex items-start gap-3">
        <IconTile icon={agentMeta(agent.id).icon} accent={agent.accent} />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <h3 className="text-[0.95rem] font-semibold text-[var(--color-ink)]">{agent.name}</h3>
            <Badge tone={active ? 'ok' : agent.status === 'disabled' ? 'bad' : 'neutral'}>{t.agents.registry.status[agent.status] ?? agent.status}</Badge>
            <Badge tone={RISK_TONE[agent.risk]}>{t.agents.registry.risk(agent.risk)}</Badge>
          </div>
          <p className="mt-1 text-[0.8rem] leading-relaxed text-[var(--color-ink-dim)]">{agent.description}</p>
        </div>
      </div>

      {!active && <p className="mt-2.5 rounded-lg bg-[var(--color-tint)] px-3 py-2 text-[0.76rem] leading-relaxed text-[var(--color-ink-dim)]">{agent.statusDetail}</p>}

      <dl className="mt-3 space-y-2 text-[0.74rem]">
        <Row label={t.agents.registry.rows.capabilities} items={agent.capabilities.map((c) => t.agents.registry.capabilities[c] ?? titleCase(c))} />
        <Row label={t.agents.registry.rows.permissions} items={agent.permissions.map((p) => t.tools.permission[p] ?? titleCase(p))} tone={permissionsNeedCare ? 'warn' : 'neutral'} />
        {agent.requiredTools.length > 0 && <Row label={t.agents.registry.rows.needsTools} items={agent.requiredTools} />}
        <Row label={t.agents.registry.rows.prefers} items={agent.preferredTiers.map((tier) => t.agents.registry.tiers[tier] ?? titleCase(tier))} />
      </dl>
    </Panel>
  );
}

function Row({ label, items, tone = 'neutral' }: { label: string; items: string[]; tone?: 'neutral' | 'warn' }) {
  if (items.length === 0) return null;
  return (
    <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
      <dt className="w-32 shrink-0 text-[var(--color-ink-faint)]">{label}</dt>
      <dd className="flex min-w-0 flex-1 flex-wrap gap-1">
        {items.map((item) => (
          <Badge key={item} tone={tone} className="normal-case tracking-normal">
            {item}
          </Badge>
        ))}
      </dd>
    </div>
  );
}
