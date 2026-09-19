/**
 * The navigation model. Sidebar, bottom bar and the "More" sheet all render
 * from this list, so a section can never appear in one and be missing from
 * another.
 */

import type { IconName } from '../components/icons.tsx';
import type { SectionName } from './router.tsx';

export interface NavItem {
  name: SectionName;
  label: string;
  icon: IconName;
  /** One line shown under the label in the "More" sheet. */
  blurb: string;
  /** Shown in the mobile bottom bar; everything else lives behind "More". */
  primary: boolean;
}

export const NAV_ITEMS: readonly NavItem[] = [
  { name: 'dashboard', label: 'Dashboard', icon: 'dashboard', blurb: 'Launch a mission and see the system', primary: true },
  { name: 'missions', label: 'Missions', icon: 'target', blurb: 'Every mission and its runs', primary: true },
  { name: 'agents', label: 'Agents', icon: 'bot', blurb: 'The eight-agent crew', primary: true },
  { name: 'knowledge', label: 'Knowledge', icon: 'database', blurb: 'Collections, documents and sources', primary: false },
  { name: 'research', label: 'Research', icon: 'search', blurb: 'The future research engine', primary: false },
  { name: 'tools', label: 'Tools', icon: 'wrench', blurb: 'Tool catalog and connection status', primary: false },
  { name: 'creative', label: 'Creative', icon: 'palette', blurb: 'The future creative suite', primary: false },
  { name: 'activity', label: 'Activity', icon: 'activity', blurb: 'Timeline of everything that happened', primary: true },
  { name: 'settings', label: 'Settings', icon: 'settings', blurb: 'Providers, models and appearance', primary: false },
];
