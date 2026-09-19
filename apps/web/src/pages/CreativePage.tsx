import { useMemo } from 'react';

import { Icon, type IconName } from '../components/icons.tsx';
import { Badge, EmptyState, ListSkeleton, Notice, PageHeader, Panel, SectionTitle } from '../components/primitives.tsx';
import { useRecentMissions } from '../hooks/useRecentMissions.ts';
import { absoluteTime, cleanPrompt, cx, excerpt } from '../lib/format.ts';
import { href } from '../lib/router.tsx';

const CREATE: { icon: IconName; name: string; body: string }[] = [
  { icon: 'pen', name: 'New Design', body: 'Start from a blank page or a brief and lay out a screen, poster or brand sheet.' },
  { icon: 'image', name: 'Image', body: 'Generate and edit images from a prompt.' },
  { icon: 'video', name: 'Video', body: 'Turn a brief into a short clip and trim it.' },
  { icon: 'layout', name: 'Canvas', body: 'A free-form board to arrange images, text and references together.' },
];

interface TemplatePreview {
  name: string;
  kind: string;
  /** Tailwind gradient classes for the swatch. */
  swatch: string;
  layout: 'hero' | 'split' | 'grid' | 'stack';
}

const TEMPLATES: TemplatePreview[] = [
  { name: 'Launch announcement', kind: 'Social post', swatch: 'from-cyan-500/30 to-violet-500/30', layout: 'hero' },
  { name: 'Product card', kind: 'Marketplace', swatch: 'from-amber-500/30 to-rose-500/30', layout: 'split' },
  { name: 'Brand sheet', kind: 'Identity', swatch: 'from-emerald-500/30 to-cyan-500/30', layout: 'grid' },
  { name: 'Pitch slide', kind: 'Presentation', swatch: 'from-violet-500/30 to-fuchsia-500/30', layout: 'stack' },
];

export function CreativePage() {
  const recent = useRecentMissions(20);

  // Real data: the Design agent's finished result from each mission's latest run.
  const briefs = useMemo(
    () =>
      recent.missions.flatMap((mission) => {
        const design = mission.runs[0]?.agents.find((a) => a.agentId === 'design' && a.status === 'completed');
        return design?.result != null
          ? [
              {
                key: design.id,
                missionId: mission.id,
                title: mission.title,
                summary: excerpt(design.result, 180),
                at: design.completedAt ?? mission.updatedAt,
              },
            ]
          : [];
      }),
    [recent.missions],
  );

  return (
    <div className="space-y-6">
      <PageHeader
        icon="palette"
        title="Creative"
        description="The future creative suite: design, images, video and a shared canvas, all starting from what your missions have already decided."
      />

      <Notice tone="preview" title="The editors are not built yet">
        Nothing below can create or edit an asset today. The one working part is “Recent projects”, which lists the design
        briefs your Design agent has already written.
      </Notice>

      {/* ---------------------------------------------------------------- Create */}
      <section>
        <SectionTitle>Create</SectionTitle>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
          {CREATE.map((item) => (
            <Panel key={item.name} as="article" className="p-4">
              <div className="flex items-start justify-between gap-2">
                <span className="grid h-11 w-11 place-items-center rounded-xl bg-[var(--color-tint)] text-[var(--color-ink-dim)] ring-1 ring-[var(--color-line)]">
                  <Icon name={item.icon} className="h-5 w-5" />
                </span>
                <Badge>Planned</Badge>
              </div>
              <h3 className="mt-3 text-[0.95rem] font-semibold text-[var(--color-ink)]">{item.name}</h3>
              <p className="mt-1 text-[0.78rem] leading-relaxed text-[var(--color-ink-faint)]">{item.body}</p>
            </Panel>
          ))}
        </div>
      </section>

      {/* ------------------------------------------------------------- Templates */}
      <section>
        <SectionTitle action={<Badge tone="signal">Preview</Badge>}>Templates</SectionTitle>
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          {TEMPLATES.map((template) => (
            <Panel key={template.name} as="article" className="overflow-hidden">
              <div className={cx('relative aspect-[4/3] bg-gradient-to-br p-3', template.swatch)} aria-hidden>
                <Wireframe layout={template.layout} />
              </div>
              <div className="px-3.5 py-3">
                <h3 className="truncate text-[0.86rem] font-medium text-[var(--color-ink)]">{template.name}</h3>
                <p className="text-[0.7rem] uppercase tracking-wider text-[var(--color-ink-faint)]">{template.kind}</p>
              </div>
            </Panel>
          ))}
        </div>
      </section>

      {/* -------------------------------------------------------- Recent projects */}
      <section>
        <SectionTitle action={<Badge tone="ok">Live data</Badge>}>Recent projects</SectionTitle>
        {recent.loading && recent.missions.length === 0 ? (
          <ListSkeleton rows={2} />
        ) : briefs.length === 0 ? (
          <EmptyState
            icon="pen"
            title="No design briefs yet"
            body="When a mission completes, the Design agent's brief (user journey, interface principles, visual direction) appears here as a starting point."
          />
        ) : (
          <ul className="grid grid-cols-1 gap-2 lg:grid-cols-2">
            {briefs.map((brief) => (
              <li key={brief.key}>
                <a
                  href={href({ name: 'mission', id: brief.missionId })}
                  className="panel flex h-full items-start gap-3 px-4 py-3 transition hover:border-[var(--color-edge-bright)] hover:bg-[var(--color-surface-2)]/60"
                >
                  <span className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-fuchsia-600/10 text-fuchsia-700 ring-1 ring-fuchsia-600/25 dark:bg-fuchsia-400/10 dark:text-fuchsia-300 dark:ring-fuchsia-400/25">
                    <Icon name="pen" className="h-5 w-5" />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[0.88rem] font-medium text-[var(--color-ink)]">
                      {cleanPrompt(brief.title)}
                    </span>
                    <span className="mt-0.5 line-clamp-2 text-[0.76rem] text-[var(--color-ink-dim)]">{brief.summary}</span>
                    <span className="mt-1 block text-[0.68rem] text-[var(--color-ink-faint)]">
                      Design brief · {absoluteTime(brief.at)}
                    </span>
                  </span>
                </a>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

/** A tiny abstract layout drawn with boxes, so each template swatch reads as a page. */
function Wireframe({ layout }: { layout: TemplatePreview['layout'] }) {
  const block = 'rounded bg-white/55 dark:bg-white/25';
  switch (layout) {
    case 'hero':
      return (
        <div className="flex h-full flex-col justify-end gap-1.5">
          <div className={cx(block, 'h-3 w-2/3')} />
          <div className={cx(block, 'h-2 w-1/2 opacity-70')} />
        </div>
      );
    case 'split':
      return (
        <div className="grid h-full grid-cols-2 gap-2">
          <div className={cx(block, 'h-full')} />
          <div className="flex flex-col justify-center gap-1.5">
            <div className={cx(block, 'h-2.5 w-full')} />
            <div className={cx(block, 'h-2 w-2/3 opacity-70')} />
          </div>
        </div>
      );
    case 'grid':
      return (
        <div className="grid h-full grid-cols-3 gap-1.5">
          {Array.from({ length: 6 }, (_, i) => (
            <div key={i} className={cx(block, i % 2 === 0 && 'opacity-70')} />
          ))}
        </div>
      );
    case 'stack':
      return (
        <div className="flex h-full flex-col justify-center gap-1.5">
          <div className={cx(block, 'h-3 w-1/2')} />
          <div className={cx(block, 'h-2 w-full opacity-70')} />
          <div className={cx(block, 'h-2 w-5/6 opacity-70')} />
        </div>
      );
  }
}
