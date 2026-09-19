/**
 * The tool catalog shown on the Tools screen and summarised in Settings.
 *
 * This is a frontend-side roadmap, not something the API reports: no tool
 * integration exists on the server yet. The statuses are therefore deliberately
 * conservative and have exactly these meanings:
 *
 *  - `available`     works today, end to end.
 *  - `mock`          a simulated stand-in exists and is what runs now.
 *  - `not_connected` nothing is built; the card says what it would need.
 *
 * Only two entries are anything other than `not_connected`, and both are backed
 * by code that exists: the MockProvider that writes every agent's output, and
 * the mission orchestrator behind the REST API.
 */

import type { IconName } from '../components/icons.tsx';

export type ToolCategory = 'Research' | 'Creation' | 'Development' | 'Files' | 'Communication' | 'Automation';
export type ToolStatus = 'available' | 'mock' | 'not_connected';

export interface ToolEntry {
  id: string;
  name: string;
  category: ToolCategory;
  icon: IconName;
  status: ToolStatus;
  description: string;
  /** For `not_connected` tools: what connecting one would involve. */
  requires: string | null;
}

export const TOOL_CATEGORIES: readonly ToolCategory[] = [
  'Research',
  'Creation',
  'Development',
  'Files',
  'Communication',
  'Automation',
];

export const STATUS_LABELS: Record<ToolStatus, string> = {
  available: 'Available',
  mock: 'Mock',
  not_connected: 'Not connected',
};

export const TOOLS: readonly ToolEntry[] = [
  {
    id: 'web-search',
    name: 'Web Search',
    category: 'Research',
    icon: 'globe',
    status: 'not_connected',
    description: 'Search the live web so the Research agent can ground its findings in real sources.',
    requires: 'A search API and its key, held in the server environment.',
  },
  {
    id: 'web-fetch',
    name: 'Web Fetch',
    category: 'Research',
    icon: 'download',
    status: 'not_connected',
    description: 'Fetch and read a specific page, with content restrictions and size limits.',
    requires: 'A server-side fetcher with an allow-list and timeouts.',
  },
  {
    id: 'wikipedia',
    name: 'Wikipedia',
    category: 'Research',
    icon: 'book',
    status: 'not_connected',
    description: 'Look up background articles for quick, citable context.',
    requires: 'A read-only Wikipedia client on the server.',
  },
  {
    id: 'text-generation',
    name: 'Text Generation',
    category: 'Creation',
    icon: 'sparkles',
    status: 'mock',
    description: 'Writes every agent’s output today. The simulated provider produces structured text with no reasoning.',
    requires: null,
  },
  {
    id: 'image-generation',
    name: 'Image Generation',
    category: 'Creation',
    icon: 'image',
    status: 'not_connected',
    description: 'Generate images for the Design agent and the Creative suite.',
    requires: 'An image-generation provider adapter and API key.',
  },
  {
    id: 'video-generation',
    name: 'Video Generation',
    category: 'Creation',
    icon: 'video',
    status: 'not_connected',
    description: 'Generate short video clips from a brief.',
    requires: 'A video-generation provider adapter and API key.',
  },
  {
    id: 'voice',
    name: 'Voice',
    category: 'Creation',
    icon: 'mic',
    status: 'not_connected',
    description: 'Speech-to-text and text-to-speech for spoken missions and narrated results.',
    requires: 'A speech provider adapter and API key.',
  },
  {
    id: 'code-execution',
    name: 'Code Execution',
    category: 'Development',
    icon: 'terminal',
    status: 'not_connected',
    description: 'Run code in an isolated sandbox so the Engineering agent can test what it proposes.',
    requires: 'A sandboxed runtime with strict resource limits.',
  },
  {
    id: 'github',
    name: 'GitHub',
    category: 'Development',
    icon: 'git-branch',
    status: 'not_connected',
    description: 'Read repositories and open pull requests from a mission.',
    requires: 'A GitHub app or token with scoped permissions.',
  },
  {
    id: 'documents',
    name: 'Documents',
    category: 'Files',
    icon: 'file-text',
    status: 'not_connected',
    description: 'Export a mission result as a document, and read uploaded documents as context.',
    requires: 'File storage and a document renderer on the server.',
  },
  {
    id: 'spreadsheets',
    name: 'Spreadsheets',
    category: 'Files',
    icon: 'table',
    status: 'not_connected',
    description: 'Produce financial models as spreadsheets for the Finance agent.',
    requires: 'File storage and a spreadsheet writer on the server.',
  },
  {
    id: 'email',
    name: 'Email',
    category: 'Communication',
    icon: 'mail',
    status: 'not_connected',
    description: 'Send a finished brief to someone, or draft replies.',
    requires: 'A mail provider and explicit per-send approval.',
  },
  {
    id: 'calendar',
    name: 'Calendar',
    category: 'Communication',
    icon: 'calendar',
    status: 'not_connected',
    description: 'Turn next actions from a brief into scheduled events.',
    requires: 'A calendar account connection with scoped access.',
  },
  {
    id: 'mission-orchestrator',
    name: 'Mission Orchestrator',
    category: 'Automation',
    icon: 'zap',
    status: 'available',
    description: 'Runs the eight-agent pipeline asynchronously through the REST API. This is what powers every mission.',
    requires: null,
  },
  {
    id: 'scheduled-runs',
    name: 'Scheduled Runs',
    category: 'Automation',
    icon: 'clock',
    status: 'not_connected',
    description: 'Re-run a mission on a schedule and compare results over time.',
    requires: 'A durable job queue (the current queue is in-process and does not survive restarts).',
  },
];

export function countByStatus(tools: readonly ToolEntry[] = TOOLS): Record<ToolStatus, number> {
  const counts: Record<ToolStatus, number> = { available: 0, mock: 0, not_connected: 0 };
  for (const tool of tools) counts[tool.status] += 1;
  return counts;
}
