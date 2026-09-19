import { useState } from 'react';

import { Icon, type IconName } from '../components/icons.tsx';
import { Badge, ErrorBanner, ListSkeleton, Notice, PageHeader, Panel, Segmented, Skeleton } from '../components/primitives.tsx';
import { useHealth, useProviderInfo, useStats } from '../hooks/useApi.ts';
import { compactNumber, cx, relativeTime } from '../lib/format.ts';
import { href } from '../lib/router.tsx';
import { useTheme, type ThemePreference } from '../lib/theme.tsx';
import { TOOLS, countByStatus } from '../lib/tools-catalog.ts';

type Tab = 'providers' | 'models' | 'connections' | 'permissions' | 'appearance' | 'system';

const TABS: readonly { value: Tab; label: string }[] = [
  { value: 'providers', label: 'Providers' },
  { value: 'models', label: 'Models' },
  { value: 'connections', label: 'Connections' },
  { value: 'permissions', label: 'Permissions' },
  { value: 'appearance', label: 'Appearance' },
  { value: 'system', label: 'System status' },
];

export function SettingsPage() {
  const [tab, setTab] = useState<Tab>('providers');

  return (
    <div className="space-y-5">
      <PageHeader
        icon="settings"
        title="Settings"
        description="Which AI providers and models the crew can use, what it is connected to, and how this app looks."
      />

      <Segmented label="Settings sections" value={tab} onChange={setTab} options={TABS} />

      <div key={tab} className="acc-fade">
        {(tab === 'providers' || tab === 'models') && <ProvidersAndModels view={tab} />}
        {tab === 'connections' && <Connections />}
        {tab === 'permissions' && <Permissions />}
        {tab === 'appearance' && <Appearance />}
        {tab === 'system' && <SystemStatus />}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Providers & models (real: GET /api/providers)
// ---------------------------------------------------------------------------

function ProvidersAndModels({ view }: { view: 'providers' | 'models' }) {
  const info = useProviderInfo();

  if (info.loading) return <ListSkeleton rows={3} />;
  if (info.error !== null || info.data === null) {
    return <ErrorBanner message={info.error ?? 'Could not load providers.'} />;
  }

  const { items, defaultProviderId } = info.data;

  if (view === 'providers') {
    return (
      <div className="space-y-3">
        <Notice tone="live" title="Read from the server">
          This list comes from the API. Provider keys are held only in the server environment; this app never sees them.
        </Notice>
        <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
          {items.map((provider) => (
            <Panel key={provider.id} as="article" className="p-4">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <h2 className="text-[0.95rem] font-semibold text-[var(--color-ink)]">{provider.label}</h2>
                  <code className="font-mono text-[0.7rem] text-[var(--color-ink-faint)]">{provider.id}</code>
                </div>
                <div className="flex flex-wrap justify-end gap-1.5">
                  {provider.id === defaultProviderId && <Badge tone="signal">Default</Badge>}
                  <Badge tone={provider.availability === 'available' ? 'ok' : 'neutral'}>
                    {provider.availability === 'available' ? 'Available' : 'Planned'}
                  </Badge>
                </div>
              </div>
              {provider.note !== null && (
                <p className="mt-2.5 text-[0.8rem] leading-relaxed text-[var(--color-ink-dim)]">{provider.note}</p>
              )}
              <p className="tabular mt-2.5 text-[0.72rem] text-[var(--color-ink-faint)]">
                {provider.models.length} model{provider.models.length === 1 ? '' : 's'}
              </p>
            </Panel>
          ))}
        </div>
      </div>
    );
  }

  const models = items.flatMap((provider) => provider.models.map((model) => ({ provider, model })));

  return (
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
            {model.contextWindow === null ? 'context n/a' : `${compactNumber(model.contextWindow)} context`}
          </span>
          <Badge tone={provider.availability === 'available' ? 'ok' : 'neutral'}>
            {provider.availability === 'available' ? 'Usable' : 'Planned'}
          </Badge>
        </div>
      ))}
    </Panel>
  );
}

// ---------------------------------------------------------------------------
// Connections (read-only)
// ---------------------------------------------------------------------------

function Connections() {
  const info = useProviderInfo();
  const tools = countByStatus();

  return (
    <div className="space-y-4">
      <Notice tone="preview" title="Read-only in this version">
        Connections are configured on the server through environment variables. There is nothing to connect from this screen
        yet.
      </Notice>

      <Panel className="p-4">
        <h2 className="mb-3 text-[0.7rem] font-semibold uppercase tracking-[0.18em] text-[var(--color-ink-faint)]">
          AI providers
        </h2>
        {info.loading ? (
          <Skeleton className="h-16 w-full" />
        ) : info.data === null ? (
          <p className="text-[0.82rem] text-[var(--color-bad)]">{info.error ?? 'Could not load providers.'}</p>
        ) : (
          <ul className="divide-y divide-[var(--color-edge)]">
            {info.data.items.map((provider) => (
              <li key={provider.id} className="flex items-center justify-between gap-3 py-2.5">
                <span className="text-[0.86rem] text-[var(--color-ink)]">{provider.label}</span>
                <Badge tone={provider.availability === 'available' ? 'ok' : 'neutral'}>
                  {provider.availability === 'available' ? 'Connected' : 'Adapter not built'}
                </Badge>
              </li>
            ))}
          </ul>
        )}
      </Panel>

      <Panel className="flex flex-wrap items-center justify-between gap-3 p-4">
        <div>
          <h2 className="text-[0.95rem] font-semibold text-[var(--color-ink)]">Tools</h2>
          <p className="tabular mt-0.5 text-[0.78rem] text-[var(--color-ink-faint)]">
            {tools.available} available · {tools.mock} mock · {tools.not_connected} not connected of {TOOLS.length}
          </p>
        </div>
        <a
          href={href({ name: 'tools' })}
          className="inline-flex items-center gap-1.5 text-[0.82rem] font-medium text-[var(--color-signal)] hover:underline"
        >
          Open the tool catalog
          <Icon name="arrow-right" className="h-4 w-4" />
        </a>
      </Panel>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Permissions (read-only description of how this version behaves)
// ---------------------------------------------------------------------------

const PERMISSIONS: { icon: IconName; what: string; allowed: boolean; note: string }[] = [
  { icon: 'file-text', what: 'Read the mission you write', allowed: true, note: 'Every agent receives the mission text as its assignment.' },
  { icon: 'layers', what: 'Read the other agents’ results', allowed: true, note: 'Only QA and the Integrator, which review and merge the crew’s output.' },
  { icon: 'database', what: 'Store results', allowed: true, note: 'Results are saved with the mission so you can reopen them.' },
  { icon: 'globe', what: 'Browse the web', allowed: false, note: 'No web tool is connected.' },
  { icon: 'terminal', what: 'Run code', allowed: false, note: 'No execution sandbox exists.' },
  { icon: 'mail', what: 'Send messages or publish anything', allowed: false, note: 'No outbound connector exists, so nothing can be sent on your behalf.' },
];

function Permissions() {
  return (
    <div className="space-y-4">
      <Notice tone="preview" title="Read-only in this version">
        This describes how the app behaves today. Per-agent permissions you can edit arrive with the first real tools.
      </Notice>
      <Panel className="divide-y divide-[var(--color-edge)]">
        {PERMISSIONS.map((item) => (
          <div key={item.what} className="flex items-start gap-3 px-4 py-3">
            <span className="mt-0.5 grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-[var(--color-tint)] text-[var(--color-ink-dim)] ring-1 ring-[var(--color-line)]">
              <Icon name={item.icon} className="h-4 w-4" />
            </span>
            <div className="min-w-0 flex-1">
              <div className="flex items-center justify-between gap-3">
                <p className="text-[0.88rem] font-medium text-[var(--color-ink)]">{item.what}</p>
                <Badge tone={item.allowed ? 'ok' : 'neutral'}>{item.allowed ? 'Allowed' : 'Not possible'}</Badge>
              </div>
              <p className="mt-0.5 text-[0.78rem] leading-relaxed text-[var(--color-ink-faint)]">{item.note}</p>
            </div>
          </div>
        ))}
      </Panel>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Appearance (real: changes and persists the theme)
// ---------------------------------------------------------------------------

const THEMES: { value: ThemePreference; label: string; icon: IconName; body: string }[] = [
  { value: 'dark', label: 'Dark', icon: 'moon', body: 'The operations-console look.' },
  { value: 'light', label: 'Light', icon: 'sun', body: 'Bright, for daylight.' },
  { value: 'system', label: 'System', icon: 'monitor', body: 'Follow your device setting.' },
];

function Appearance() {
  const { preference, resolved, setPreference } = useTheme();

  return (
    <div className="space-y-4">
      <div role="radiogroup" aria-label="Theme" className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        {THEMES.map((theme) => {
          const active = preference === theme.value;
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
              <span className="text-[0.92rem] font-semibold text-[var(--color-ink)]">{theme.label}</span>
              <span className="text-[0.78rem] text-[var(--color-ink-faint)]">{theme.body}</span>
            </button>
          );
        })}
      </div>
      <p className="text-[0.78rem] text-[var(--color-ink-faint)]">
        Currently showing the <span className="font-medium text-[var(--color-ink-dim)]">{resolved}</span> theme. Your choice is
        remembered on this device.
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

  const rows: { label: string; value: string; tone?: 'ok' | 'bad' | 'warn' }[] = [
    online
      ? { label: 'API', value: `Online · ${health.data?.latencyMs ?? 0} ms`, tone: 'ok' }
      : { label: 'API', value: health.data === null && health.error === null ? 'Checking…' : 'Unreachable', tone: 'bad' },
    { label: 'Version', value: online ? `v${health.data?.health.version}` : '—' },
    {
      label: 'Default provider',
      value: online ? (health.data?.health.provider ?? 'none') : '—',
      ...(online && health.data?.health.provider === 'mock' ? { tone: 'warn' as const } : {}),
    },
    { label: 'Server time', value: online ? relativeTime(health.data?.health.time ?? null) : '—' },
    { label: 'Missions stored', value: stats.data === null ? '—' : String(stats.data.total) },
    { label: 'Currently running', value: stats.data === null ? '—' : String(stats.data.running + stats.data.pending) },
    { label: 'Build', value: import.meta.env.MODE },
    { label: 'Browser online', value: typeof navigator !== 'undefined' && navigator.onLine ? 'Yes' : 'No' },
  ];

  return (
    <div className="space-y-4">
      {health.error !== null && (
        <ErrorBanner message={`Cannot reach the API: ${health.error}`} onRetry={health.refresh} />
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
              {row.label === 'API' && (
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
