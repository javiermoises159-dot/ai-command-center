/**
 * Prompt assembly.
 *
 * Two different strings are produced for each agent, on purpose:
 *
 *  - `buildAssignment` — the short, stable description of what the agent was
 *    asked to do. Stored on the `mission_agents` row at creation time and shown
 *    in the UI, so it must be readable and must not depend on upstream output
 *    that does not exist yet.
 *
 *  - `renderPrompt` — the full text actually sent to the provider at execution
 *    time, including the output of every agent that ran before it. Real vendor
 *    adapters send this; adapters that prefer structure use `TaskContext`.
 */

import type { AgentDefinition, FailedAgent, UpstreamResult } from '@acc/domain';

export function buildAssignment(agent: AgentDefinition, missionPrompt: string): string {
  const scope =
    agent.kind === 'worker'
      ? `Work the mission from the ${agent.name} angle.`
      : agent.kind === 'qa'
        ? 'Audit every specialist output produced in this run.'
        : 'Merge every specialist output and the QA review into one deliverable.';

  return [
    `MISSION: ${missionPrompt.trim()}`,
    '',
    scope,
    '',
    `EXPECTED DELIVERABLE: ${agent.deliverable}`,
  ].join('\n');
}

export interface RenderPromptInput {
  agent: AgentDefinition;
  missionPrompt: string;
  upstream: readonly UpstreamResult[];
  failed: readonly FailedAgent[];
}

export function renderPrompt(input: RenderPromptInput): string {
  const { agent, missionPrompt, upstream, failed } = input;
  const sections: string[] = [`MISSION\n${missionPrompt.trim()}`];

  if (upstream.length > 0) {
    const label =
      agent.kind === 'integrator'
        ? 'OUTPUT FROM THE CREW (specialists, then the QA review)'
        : agent.kind === 'qa'
          ? 'SPECIALIST OUTPUT TO AUDIT'
          : 'CONTEXT FROM AGENTS THAT RAN BEFORE YOU';

    sections.push(
      `${label}\n\n${upstream
        .map((u) => `----- BEGIN ${u.name.toUpperCase()} -----\n${u.result}\n----- END ${u.name.toUpperCase()} -----`)
        .join('\n\n')}`,
    );
  }

  if (failed.length > 0) {
    sections.push(
      `AGENTS THAT FAILED IN THIS RUN\n${failed
        .map((f) => `- ${f.name}: ${f.error}`)
        .join('\n')}\n\nDo not invent their output. Account for the gap explicitly.`,
    );
  }

  sections.push(
    `YOUR TASK\n${
      agent.kind === 'worker'
        ? `Work the mission from the ${agent.name} angle.`
        : agent.kind === 'qa'
          ? 'Audit the specialist output above. Find contradictions between agents, unstated assumptions, and missing work.'
          : 'Merge everything above into one coherent brief a human can act on immediately.'
    }\n\nDELIVERABLE: ${agent.deliverable}\n\nRespond in Markdown. Be specific and concise. Do not restate the mission back.`,
  );

  return sections.join('\n\n================================\n\n');
}
