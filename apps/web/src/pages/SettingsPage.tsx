import { useState } from 'react';

import { api, ApiClientError } from '../lib/api.ts';
import type { MadreProvider } from '@acc/contracts';

import { Icon, type IconName } from '../components/icons.tsx';
import { Badge, Button, EmptyState, ErrorBanner, ListSkeleton, Notice, PageHeader, Panel, Segmented, Skeleton } from '../components/primitives.tsx';
import { useHealth, useStats } from '../hooks/useApi.ts';
import { useMadreBudget, useMadrePermissions, useMadreProviders, useMadreTools } from '../hooks/useMadre.ts';
import { PROVIDER_STATUS_LABELS, providerTone } from '../lib/madre.ts';
import { compactNumber, cx, relativeTime } from '../lib/format.ts';
import { href } from '../lib/router.tsx';
import { useTheme, type ThemePreference } from '../lib/theme.tsx';
import { t } from '../i18n/index.ts';

type Tab = 'providers' | 'models' | 'connections' | 'permissions' | 'budget' | 'appearance' | 'system';

const TABS: readonly { value: Tab; label: string }[] = [
  { value: 'providers', label: t.settings.tabs.providers },
  { value: 'models', label: t.settings.tabs.models },
  { value: 'connections', label: t.settings.tabs.connections },
  { value: 'permissions', label: t.settings.tabs.permissions },
  { value: 'budget', label: t.settings.tabs.budget },
  { value: 'appearance', label: t.settings.tabs.appearance },
  { value: 'system', label: t.settings.tabs.system },
];

export function SettingsPage() {
  const [tab, setTab] = useState<Tab>('providers');

  return (
    <div className="space-y-5">
      <PageHeader icon="settings" title={t.settings.title} description={t.settings.description} />

      <Segmented label={t.settings.sectionsAria} value={tab} onChange={setTab} options={TABS} />

      <div key={tab} className="acc-fade">
        {(tab === 'providers' || tab === 'models') && <ProvidersAndModels view={tab} />}
        {tab === 'connections' && <Connections />}
        {tab === 'permissions' && <Permissions />}
        {tab === 'budget' && <Budget />}
        {tab === 'appearance' && <Appearance />}
        {tab === 'system' && <SystemStatus />}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Providers & models (real: GET /api/madre/providers)
// ---------------------------------------------------------------------------

const TIER_LABELS = t.settings.providers.tiers;

const HEALTH_TONE: Record<string, 'ok' | 'warn' | 'bad' | 'neutral'> = {
  ok: 'ok',
  degraded: 'warn',
  down: 'bad',
  not_connected: 'neutral',
  unknown: 'neutral',
};

function ProvidersAndModels({ view }: { view: 'providers' | 'models' }) {
  const info = useMadreProviders();
  // The probe's result replaces the polled list until the next poll refreshes it.
  const [probed, setProbed] = useState<MadreProvider[] | null>(null);
  const [probing, setProbing] = useState(false);
  const [probeError, setProbeError] = useState<string | null>(null);

  async function probe() {
    setProbing(true);
    setProbeError(null);
    try {
      setProbed((await api.madreProviderHealth()).items);
    } catch (caught) {
      setProbeError(caught instanceof ApiClientError ? caught.message : t.settings.providers.health.failed);
    } finally {
      setProbing(false);
    }
  }

  if (info.data === null) {
    return info.error !== null ? <ErrorBanner message={info.error} onRetry={info.refresh} /> : <ListSkeleton rows={3} />;
  }
  const items = probed ?? info.data.items;

  if (view === 'providers') {
    return (
      <div className="space-y-3">
        <Notice tone="live" title={t.settings.fromServer}>
          {t.settings.providers.noticeBody}
        </Notice>
        <div className="flex flex-wrap items-center gap-3">
          <Button onClick={() => void probe()} busy={probing} variant="ghost">
            {probing ? t.settings.providers.health.checking : t.settings.providers.health.check}
          </Button>
          <p className="flex-1 text-[0.74rem] leading-relaxed text-[var(--color-ink-faint)]">{t.settings.providers.health.hint}</p>
        </div>
        {probeError !== null && <ErrorBanner message={probeError} onRetry={() => void probe()} />}
        <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
          {items.map((provider) => (
            <Panel key={provider.id} as="article" className="p-4">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <h2 className="text-[0.95rem] font-semibold text-[var(--color-ink)]">{provider.label}</h2>
                  <code className="font-mono text-[0.7rem] text-[var(--color-ink-faint)]">{provider.id}</code>
                </div>
                <Badge tone={providerTone(provider.status)}>{PROVIDER_STATUS_LABELS[provider.status]}</Badge>
              </div>
              <p className="mt-2.5 text-[0.8rem] leading-relaxed text-[var(--color-ink-dim)]">{provider.statusDetail}</p>
              <p className="mt-2.5 flex flex-wrap gap-1.5">
                <Badge>{TIER_LABELS[provider.tier] ?? provider.tier}</Badge>
                <Badge tone={provider.privacy === 'on_device' ? 'ok' : 'neutral'}>
                  {t.settings.providers.privacy[provider.privacy] ?? provider.privacy}
                </Badge>
                {provider.tier === 'mock' ? <Badge tone="warn">{t.settings.providers.sourceSimulated}</Badge> : provider.executable ? <Badge tone="ok">{t.settings.providers.sourceReal}</Badge> : null}
                <Badge>{t.settings.providers.modelCount(provider.models.length)}</Badge>
                <Badge tone={HEALTH_TONE[provider.health.status] ?? 'neutral'}>
                  {t.settings.providers.health.status[provider.health.status] ?? provider.health.status}
                </Badge>
              </p>
              <p className="tabular mt-1.5 text-[0.72rem] text-[var(--color-ink-faint)]">
                {provider.health.checkedAt === null
                  ? t.settings.providers.health.neverChecked
                  : t.settings.providers.health.checkedAt(relativeTime(provider.health.checkedAt))}
                {provider.health.latencyMs !== null && ` · ${t.settings.providers.health.latency(provider.health.latencyMs)}`}
              </p>
              {!provider.executable && provider.requires !== null && (
                <p className="mt-3 flex items-start gap-2 border-t border-[var(--color-edge)] pt-3 text-[0.74rem] leading-relaxed text-[var(--color-ink-faint)]">
                  <Icon name="plug" className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                  <span>
                    <span className="font-medium text-[var(--color-ink-dim)]">{t.settings.providers.toConnect}</span>
                    {provider.requires}
                  </span>
                </p>
              )}
            </Panel>
          ))}
        </div>
      </div>
    );
  }

  const models = items.flatMap((provider) => provider.models.map((model) => ({ provider, model })));

  return (
    <div className="space-y-3">
      <Notice tone="preview" title={t.settings.models.noticeTitle}>
        {t.settings.models.noticeBody}
      </Notice>
      {models.length === 0 ? (
        <EmptyState icon="bot" title={t.settings.models.empty.title} body={t.settings.models.empty.body} />
      ) : (
        <Panel className="divide-y divide-[var(--color-edge)]">
          {models.map(({ provider, model }) => (
            <div key={`${provider.id}/${model.id}`} className="flex flex-wrap items-center gap-x-4 gap-y-1 px-4 py-3">
              <div className="min-w-0 flex-1">
                <p className="truncate text-[0.88rem] font-medium text-[var(--color-ink)]">{model.label}</p>
                <p className="font-mono text-[0.7rem] text-[var(--color-ink-faint)]">
                  {provider.id}/{model.id}
                </p>
              </div>
              <span className="tabular text-[0.72rem] text-[var(--color-ink-faint)]">
                {t.settings.models.quality(model.quality)} ·{' '}
                {model.contextWindow === null ? t.settings.models.contextNa : t.settings.models.context(compactNumber(model.contextWindow))}
              </span>
              <span className="tabular text-[0.72rem] text-[var(--color-ink-faint)]">
                {model.pricePer1kInputUsd === null || model.pricePer1kOutputUsd === null
                  ? t.settings.models.priceUnknown
                  : t.settings.models.pricePer1k(`$${model.pricePer1kInputUsd}`, `$${model.pricePer1kOutputUsd}`)}
              </span>
              <Badge tone={providerTone(provider.status)}>{TIER_LABELS[model.tier] ?? model.tier}</Badge>
            </div>
          ))}
        </Panel>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Connections (read-only)
// ---------------------------------------------------------------------------

function Connections() {
  const providers = useMadreProviders();
  const tools = useMadreTools();
  const counts = new Map<string, number>();
  for (const tool of tools.data?.items ?? []) counts.set(tool.status, (counts.get(tool.status) ?? 0) + 1);

  return (
    <div className="space-y-4">
      <Notice tone="preview" title={t.settings.connections.noticeTitle}>
        {t.settings.connections.noticeBody}
      </Notice>

      <Panel className="p-4">
        <h2 className="mb-3 text-[0.7rem] font-semibold uppercase tracking-[0.18em] text-[var(--color-ink-faint)]">
          {t.settings.connections.aiProviders}
        </h2>
        {providers.data === null ? (
          providers.error !== null ? <p className="text-[0.82rem] text-[var(--color-bad)]">{providers.error}</p> : <Skeleton className="h-16 w-full" />
        ) : (
          <ul className="divide-y divide-[var(--color-edge)]">
            {providers.data.items.map((provider) => (
              <li key={provider.id} className="flex items-center justify-between gap-3 py-2.5">
                <span className="text-[0.86rem] text-[var(--color-ink)]">{provider.label}</span>
                <Badge tone={providerTone(provider.status)}>{PROVIDER_STATUS_LABELS[provider.status]}</Badge>
              </li>
            ))}
          </ul>
        )}
      </Panel>

      <Panel className="flex flex-wrap items-center justify-between gap-3 p-4">
        <div>
          <h2 className="text-[0.95rem] font-semibold text-[var(--color-ink)]">{t.settings.connections.tools}</h2>
          <p className="tabular mt-0.5 text-[0.78rem] text-[var(--color-ink-faint)]">
            {tools.data === null
              ? '—'
              : t.settings.connections.toolsSummary(
                  (counts.get('AVAILABLE') ?? 0) + (counts.get('CONNECTED') ?? 0),
                  counts.get('MOCK') ?? 0,
                  (counts.get('NOT_CONNECTED') ?? 0) + (counts.get('PLANNED') ?? 0),
                  tools.data.items.length,
                )}
          </p>
        </div>
        <a href={href({ name: 'tools' })} className="inline-flex items-center gap-1.5 text-[0.82rem] font-medium text-[var(--color-signal)] hover:underline">
          {t.settings.connections.openRegistry}
          <Icon name="arrow-right" className="h-4 w-4" />
        </a>
      </Panel>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Permissions (real: GET /api/madre/permissions)
// ---------------------------------------------------------------------------

type PermissionLevel = keyof typeof t.settings.permissions.names;

const LEVELS: { level: PermissionLevel; icon: IconName }[] = [
  { level: 'READ', icon: 'file-text' },
  { level: 'WRITE', icon: 'database' },
  { level: 'EXECUTE', icon: 'terminal' },
  { level: 'EXTERNAL_ACTION', icon: 'globe' },
  { level: 'PUBLISH', icon: 'megaphone' },
  { level: 'DELETE', icon: 'x' },
  { level: 'FINANCIAL', icon: 'trending-up' },
];

const MODE_TONE = { AUTO: 'ok', ASK: 'warn', BLOCK: 'bad' } as const;
const MODE_LABEL = t.settings.permissions.modes;

function Permissions() {
  const modes = useMadrePermissions();
  return (
    <div className="space-y-4">
      <Notice tone="live" title={t.settings.fromServer}>
        {t.settings.permissions.noticeBody}
      </Notice>
      {modes.data === null ? (
        modes.error !== null ? <ErrorBanner message={modes.error} onRetry={modes.refresh} /> : <ListSkeleton rows={4} />
      ) : (
        <Panel className="divide-y divide-[var(--color-edge)]">
          {LEVELS.map((item) => {
            const mode = modes.data?.modes[item.level as keyof typeof modes.data.modes] as keyof typeof MODE_TONE | undefined;
            return (
              <div key={item.level} className="flex items-start gap-3 px-4 py-3">
                <span className="mt-0.5 grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-[var(--color-tint)] text-[var(--color-ink-dim)] ring-1 ring-[var(--color-line)]">
                  <Icon name={item.icon} className="h-4 w-4" />
                </span>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center justify-between gap-3">
                    <p className="text-[0.88rem] font-medium text-[var(--color-ink)]">{t.settings.permissions.names[item.level]}</p>
                    {mode !== undefined && <Badge tone={MODE_TONE[mode]}>{MODE_LABEL[mode]}</Badge>}
                  </div>
                  <p className="mt-0.5 text-[0.78rem] leading-relaxed text-[var(--color-ink-faint)]">
                    {t.settings.permissions.levels[item.level]}
                  </p>
                </div>
              </div>
            );
          })}
        </Panel>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Budget (real: GET/PATCH /api/madre/budget)
// ---------------------------------------------------------------------------

function Budget() {
  const budget = useMadreBudget();
  const [values, setValues] = useState<{ perMissionUsd: string; dailyUsd: string; monthlyUsd: string } | null>(null);
  const [onExceed, setOnExceed] = useState<'block' | 'fallback_local' | 'ask'>('block');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  if (budget.data === null) {
    return budget.error !== null ? <ErrorBanner message={budget.error} onRetry={budget.refresh} /> : <ListSkeleton rows={3} />;
  }
  const current = budget.data.budget;
  const cost = budget.data.cost;
  const shown = values ?? {
    perMissionUsd: current.perMissionUsd === null ? '' : String(current.perMissionUsd),
    dailyUsd: current.dailyUsd === null ? '' : String(current.dailyUsd),
    monthlyUsd: current.monthlyUsd === null ? '' : String(current.monthlyUsd),
  };
  const mode = values === null ? current.onExceed : onExceed;

  function parse(text: string): number | null | undefined {
    if (text.trim() === '') return null;
    const n = Number(text);
    return Number.isFinite(n) && n >= 0 ? n : undefined;
  }

  async function save() {
    const perMissionUsd = parse(shown.perMissionUsd);
    const dailyUsd = parse(shown.dailyUsd);
    const monthlyUsd = parse(shown.monthlyUsd);
    if (perMissionUsd === undefined || dailyUsd === undefined || monthlyUsd === undefined) {
      setError(t.settings.budget.invalid);
      return;
    }
    setBusy(true);
    setError(null);
    setSaved(false);
    try {
      await api.madreSetBudget({ perMissionUsd, dailyUsd, monthlyUsd, onExceed: mode });
      setValues(null);
      setSaved(true);
      budget.refresh();
    } catch (caught) {
      setError(caught instanceof ApiClientError ? caught.message : t.settings.budget.saveFailed);
    } finally {
      setBusy(false);
    }
  }

  const field = 'min-h-[44px] w-full rounded-xl border border-[var(--color-edge-bright)] bg-[var(--color-field)] px-3 py-2.5 text-[0.9rem] text-[var(--color-ink)] focus:border-[var(--color-signal)]/55 focus:outline-none focus:ring-2 focus:ring-[var(--color-signal)]/30';
  const set = (key: 'perMissionUsd' | 'dailyUsd' | 'monthlyUsd') => (event: { target: { value: string } }) => setValues({ ...shown, [key]: event.target.value });

  return (
    <div className="space-y-4">
      <Notice tone="preview" title={t.settings.budget.noticeTitle}>
        {t.settings.budget.noticeBody}
      </Notice>

      <Panel className="p-4">
        <h2 className="mb-3 text-[0.7rem] font-semibold uppercase tracking-[0.18em] text-[var(--color-ink-faint)]">{t.settings.budget.spentTitle}</h2>
        <dl className="grid grid-cols-3 gap-2 text-center">
          <div className="rounded-lg bg-[var(--color-tint)] px-2 py-2"><dd className="tabular text-base font-semibold text-[var(--color-ink)]">{cost?.calls ?? 0}</dd><dt className="text-[0.6rem] uppercase tracking-wider text-[var(--color-ink-faint)]">{t.settings.budget.calls}</dt></div>
          <div className="rounded-lg bg-[var(--color-tint)] px-2 py-2"><dd className="tabular text-base font-semibold text-[var(--color-ink)]">${(cost?.knownUsd ?? 0).toFixed(2)}</dd><dt className="text-[0.6rem] uppercase tracking-wider text-[var(--color-ink-faint)]">{t.settings.budget.knownCost}</dt></div>
          <div className="rounded-lg bg-[var(--color-tint)] px-2 py-2"><dd className="tabular text-base font-semibold text-[var(--color-ink)]">{cost?.unpricedCalls ?? 0}</dd><dt className="text-[0.6rem] uppercase tracking-wider text-[var(--color-ink-faint)]">{t.settings.budget.unpricedCalls}</dt></div>
        </dl>
      </Panel>

      <Panel className="space-y-3 p-4">
        <h2 className="text-[0.7rem] font-semibold uppercase tracking-[0.18em] text-[var(--color-ink-faint)]">{t.settings.budget.limitsTitle}</h2>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          <div>
            <label htmlFor="budget-mission" className="mb-1 block text-[0.72rem] font-medium text-[var(--color-ink-dim)]">{t.settings.budget.perMission}</label>
            <input id="budget-mission" inputMode="decimal" value={shown.perMissionUsd} onChange={set('perMissionUsd')} className={field} />
          </div>
          <div>
            <label htmlFor="budget-day" className="mb-1 block text-[0.72rem] font-medium text-[var(--color-ink-dim)]">{t.settings.budget.perDay}</label>
            <input id="budget-day" inputMode="decimal" value={shown.dailyUsd} onChange={set('dailyUsd')} className={field} />
          </div>
          <div>
            <label htmlFor="budget-month" className="mb-1 block text-[0.72rem] font-medium text-[var(--color-ink-dim)]">{t.settings.budget.perMonth}</label>
            <input id="budget-month" inputMode="decimal" value={shown.monthlyUsd} onChange={set('monthlyUsd')} className={field} />
          </div>
        </div>
        <div>
          <label htmlFor="budget-exceed" className="mb-1 block text-[0.72rem] font-medium text-[var(--color-ink-dim)]">{t.settings.budget.atLimit}</label>
          <select
            id="budget-exceed"
            value={mode}
            onChange={(event) => {
              setValues(shown);
              setOnExceed(event.target.value as 'block' | 'fallback_local' | 'ask');
            }}
            className={field}
          >
            <option value="block">{t.settings.budget.onExceed.block}</option>
            <option value="fallback_local">{t.settings.budget.onExceed.fallback_local}</option>
            <option value="ask">{t.settings.budget.onExceed.ask}</option>
          </select>
        </div>
        {error !== null && <p role="alert" className="text-[0.78rem] text-[var(--color-bad)]">{error}</p>}
        {saved && <p className="text-[0.78rem] text-[var(--color-ok)]">{t.settings.budget.saved}</p>}
        <Button onClick={() => void save()} busy={busy} disabled={values === null && mode === current.onExceed}>{t.settings.budget.save}</Button>
      </Panel>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Appearance (real: changes and persists the theme)
// ---------------------------------------------------------------------------

const THEMES: { value: ThemePreference; icon: IconName }[] = [
  { value: 'dark', icon: 'moon' },
  { value: 'light', icon: 'sun' },
  { value: 'system', icon: 'monitor' },
];

function Appearance() {
  const { preference, resolved, setPreference } = useTheme();

  return (
    <div className="space-y-4">
      <div role="radiogroup" aria-label={t.settings.appearance.themeAria} className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        {THEMES.map((theme) => {
          const active = preference === theme.value;
          const copy = t.settings.appearance.themes[theme.value];
          return (
            <button
              key={theme.value}
              type="button"
              role="radio"
              aria-checked={active}
              onClick={() => setPreference(theme.value)}
              className={cx(
                'panel flex flex-col items-start gap-2 p-4 text-left transition',
                active ? 'border-[var(--color-signal)]/60 ring-2 ring-[var(--color-signal)]/30' : 'hover:bg-[var(--color-tint)]',
              )}
            >
              <span className="flex w-full items-center justify-between">
                <span className="grid h-10 w-10 place-items-center rounded-xl bg-[var(--color-tint)] text-[var(--color-ink-dim)] ring-1 ring-[var(--color-line)]">
                  <Icon name={theme.icon} className="h-5 w-5" />
                </span>
                {active && <Icon name="check" className="h-5 w-5 text-[var(--color-signal)]" />}
              </span>
              <span className="text-[0.92rem] font-semibold text-[var(--color-ink)]">{copy.label}</span>
              <span className="text-[0.78rem] text-[var(--color-ink-faint)]">{copy.body}</span>
            </button>
          );
        })}
      </div>
      <p className="text-[0.78rem] text-[var(--color-ink-faint)]">
        {t.settings.appearance.current(t.settings.appearance.resolved[resolved] ?? resolved)}
      </p>
    </div>
  );
}

// ---------------------------------------------------------------------------
// System status (real: /api/health + /api/stats)
// ---------------------------------------------------------------------------

function SystemStatus() {
  const health = useHealth();
  const stats = useStats(false);
  const online = health.data !== null && health.error === null;
  const rowLabels = t.settings.system.rows;
  const provider = health.data?.health.provider ?? null;

  const rows: { label: string; value: string; tone?: 'ok' | 'bad' | 'warn' }[] = [
    online
      ? { label: rowLabels.api, value: t.settings.system.apiOnline(health.data?.latencyMs ?? 0), tone: 'ok' }
      : {
          label: rowLabels.api,
          value: health.data === null && health.error === null ? t.settings.system.apiChecking : t.settings.system.apiUnreachable,
          tone: 'bad',
        },
    { label: rowLabels.version, value: online ? `v${health.data?.health.version}` : '—' },
    {
      label: rowLabels.defaultProvider,
      value: online ? (provider === null ? t.settings.system.none : (t.settings.system.providerNames[provider] ?? provider)) : '—',
      ...(online && provider === 'mock' ? { tone: 'warn' as const } : {}),
    },
    { label: rowLabels.serverTime, value: online ? relativeTime(health.data?.health.time ?? null) : '—' },
    { label: rowLabels.missionsStored, value: stats.data === null ? '—' : String(stats.data.total) },
    { label: rowLabels.running, value: stats.data === null ? '—' : String(stats.data.running + stats.data.pending) },
    { label: rowLabels.build, value: t.settings.system.buildModes[import.meta.env.MODE] ?? import.meta.env.MODE },
    {
      label: rowLabels.browserOnline,
      value: typeof navigator !== 'undefined' && navigator.onLine ? t.settings.system.yes : t.settings.system.no,
    },
  ];

  return (
    <div className="space-y-4">
      {health.error !== null && (
        <ErrorBanner message={t.settings.system.unreachableBanner(health.error)} onRetry={health.refresh} />
      )}
      <Panel className="divide-y divide-[var(--color-edge)]">
        {rows.map((row) => (
          <div key={row.label} className="flex items-center justify-between gap-4 px-4 py-3 text-[0.86rem]">
            <span className="text-[var(--color-ink-faint)]">{row.label}</span>
            <span
              className={cx(
                'tabular flex items-center gap-2 font-medium',
                row.tone === 'ok' && 'text-[var(--color-ok)]',
                row.tone === 'bad' && 'text-[var(--color-bad)]',
                row.tone === 'warn' && 'text-[var(--color-warn)]',
                row.tone === undefined && 'text-[var(--color-ink)]',
              )}
            >
              {row.label === rowLabels.api && (
                <span
                  className={cx('h-2 w-2 rounded-full', row.tone === 'ok' ? 'bg-[var(--color-ok)]' : 'bg-[var(--color-bad)]')}
                  aria-hidden
                />
              )}
              {row.value}
            </span>
          </div>
        ))}
      </Panel>
    </div>
  );
}
