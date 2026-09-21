/**
 * The navigation model. Sidebar, bottom bar and the "More" sheet all render
 * from this list, so a section can never appear in one and be missing from
 * another.
 *
 * Labels and blurbs come from the text catalog, keyed by section name: the
 * order and the icons are a product decision, the wording a translation one.
 */

import type { IconName } from '../components/icons.tsx';
import { t } from '../i18n/index.ts';
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

const ORDER: readonly { name: SectionName; icon: IconName; primary: boolean }[] = [
  { name: 'dashboard', icon: 'dashboard', primary: true },
  { name: 'missions', icon: 'target', primary: true },
  { name: 'agents', icon: 'bot', primary: true },
  { name: 'knowledge', icon: 'database', primary: false },
  { name: 'research', icon: 'search', primary: false },
  { name: 'tools', icon: 'wrench', primary: false },
  { name: 'creative', icon: 'palette', primary: false },
  { name: 'content', icon: 'calendar', primary: false },
  { name: 'activity', icon: 'activity', primary: true },
  { name: 'settings', icon: 'settings', primary: false },
];

export const NAV_ITEMS: readonly NavItem[] = ORDER.map((item) => ({
  ...item,
  label: t.layout.nav.items[item.name].label,
  blurb: t.layout.nav.items[item.name].blurb,
}));
