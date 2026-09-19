/**
 * The pipeline view: eight agents as a vertical track, each expandable to its
 * own result. This is the screen the product is really about, so it is the one
 * tuned hardest for a phone — full-width rows, large touch targets, and state
 * legible without reading any text.
 */

import { useEffect, useState } from 'react';

import { Markdown } from '../lib/markdown.tsx';
import { accentClass, cx, duration } from '../lib/format.ts';
import type { AgentDefinition, AgentExecution, RunDetail } from '../lib/api.ts';
import { StatusChip, StatusDot } from './primitives.tsx';

export function AgentPipeline({
  run,
  catalog,
}: {
  run: RunDetail;
  catalog: AgentDefinition[];
}) {
  const [openId, setOpenId] = useState<string | null>(null);

  // Follow the active agent automatically while the run is live, but stop
  // hijacking the view once the user opens something themselves.
  const [userPinned, setUserPinned] = useState(false);
  const runningAgentId = run.agents.find((a) => a.status === 'running')?.id ?? null;

  useEffect(() => {
    // Keyed on the id only: including the agent object would re-run this on
    // every poll, since each response deserialises to fresh objects.
    if (!userPinned && runningAgentId !== null) setOpenId(runningAgentId);
  }, [runningAgentId, userPinned]);

  return (
    <ol className="relative space-y-2">
      {run.agents.map((agent, index) => (
        <AgentRow
          key={agent.id}
          agent={agent}
          definition={catalog.find((d) => d.id === agent.agentId)}
          isLast={index === run.agents.length - 1}
          open={openId === agent.id}
          onToggle={() => {
            setUserPinned(true);
            setOpenId((current) => (current === agent.id ? null : agent.id));
          }}
        />
      ))}
    </ol>
  );
}

function AgentRow({
  agent,
  definition,
  isLast,
  open,
  onToggle,
}: {
  agent: AgentExecution;
  definition: AgentDefinition | undefined;
  isLast: boolean;
  open: boolean;
  onToggle: () => void;
}) {
  const hasBody = agent.result !== null || agent.error !== null;
  const accent = accentClass(definition?.accent ?? 'cyan');

  return (
    <li className="relative">
      {/* Connector between agents. */}
      {!isLast && (
        <span
          className={cx(
            'absolute left-[1.0625rem] top-11 bottom-[-0.5rem] w-px',
            agent.status === 'completed' ? 'bg-[var(--color-ok)]/35' : 'bg-[var(--color-edge-bright)]',
          )}
          aria-hidden
        />
      )}

      <div
        className={cx(
          'panel relative overflow-hidden transition-colors',
          agent.status === 'running' && 'acc-sweep border-cyan-400/35',
          agent.status === 'failed' && 'border-rose-400/30',
          agent.status === 'skipped' && 'opacity-55',
        )}
      >
        <button
          type="button"
          onClick={onToggle}
          disabled={!hasBody}
          aria-expanded={open}
          className={cx(
            'relative flex w-full items-center gap-3 px-3 py-3 text-left',
            hasBody ? 'cursor-pointer' : 'cursor-default',
          )}
        >
          <span
            className={cx(
              'grid h-[2.125rem] w-[2.125rem] shrink-0 place-items-center rounded-lg text-[0.7rem] font-semibold ring-1',
              accent,
            )}
          >
            {agent.orderIndex + 1}
          </span>

          <span className="min-w-0 flex-1">
            <span className="flex items-center gap-2">
              <span className="truncate text-sm font-medium text-[var(--color-ink)]">{agent.name}</span>
              <StatusDot status={agent.status} size="sm" />
            </span>
            <span className="mt-0.5 block truncate text-[0.72rem] text-[var(--color-ink-faint)]">
              {agent.status === 'failed' && agent.error !== null
                ? agent.error
                : (definition?.role ?? 'Specialist agent')}
            </span>
          </span>

          <span className="flex shrink-0 items-center gap-2">
            {agent.durationMs !== null && (
              <span className="tabular hidden text-[0.68rem] text-[var(--color-ink-faint)] sm:inline">
                {duration(agent.durationMs)}
              </span>
            )}
            {hasBody && (
              <span
                className={cx(
                  'text-[var(--color-ink-faint)] transition-transform',
                  open && 'rotate-90',
                )}
                aria-hidden
              >
                ›
              </span>
            )}
          </span>
        </button>

        {open && hasBody && (
          <div className="acc-rise border-t border-[var(--color-edge)] px-3 py-3">
            {agent.error !== null ? (
              <div className="rounded-lg border border-rose-400/25 bg-rose-500/8 px-3 py-2.5 text-[0.85rem] text-rose-200">
                <p className="mb-1 text-[0.65rem] font-semibold uppercase tracking-wider text-rose-300/80">
                  Failure
                </p>
                {agent.error}
              </div>
            ) : (
              <>
                <Markdown source={agent.result ?? ''} />
                {agent.usage && (
                  <dl className="tabular mt-4 flex flex-wrap gap-x-4 gap-y-1 border-t border-[var(--color-edge)] pt-3 text-[0.65rem] text-[var(--color-ink-faint)]">
                    <div className="flex gap-1">
                      <dt>provider</dt>
                      <dd className="font-mono text-[var(--color-ink-dim)]">{agent.usage.provider}</dd>
                    </div>
                    <div className="flex gap-1">
                      <dt>model</dt>
                      <dd className="font-mono text-[var(--color-ink-dim)]">{agent.usage.model}</dd>
                    </div>
                    <div className="flex gap-1">
                      <dt>tokens</dt>
                      <dd className="font-mono text-[var(--color-ink-dim)]">{agent.usage.totalTokens}</dd>
                    </div>
                    <div className="flex gap-1">
                      <dt>latency</dt>
                      <dd className="font-mono text-[var(--color-ink-dim)]">{agent.usage.latencyMs}ms</dd>
                    </div>
                  </dl>
                )}
              </>
            )}

            <details className="mt-3 group">
              <summary className="cursor-pointer list-none text-[0.68rem] uppercase tracking-wider text-[var(--color-ink-faint)] hover:text-[var(--color-ink-dim)]">
                <span className="group-open:hidden">Show assignment</span>
                <span className="hidden group-open:inline">Hide assignment</span>
              </summary>
              <pre className="mt-2 max-h-52 overflow-auto whitespace-pre-wrap rounded-lg border border-[var(--color-edge)] bg-black/30 p-2.5 font-mono text-[0.68rem] leading-relaxed text-[var(--color-ink-faint)]">
                {agent.task}
              </pre>
            </details>
          </div>
        )}
      </div>
    </li>
  );
}

export function PipelineLegend() {
  return (
    <div className="flex flex-wrap gap-2">
      {(['pending', 'running', 'completed', 'failed', 'skipped'] as const).map((status) => (
        <StatusChip key={status} status={status} />
      ))}
    </div>
  );
}
