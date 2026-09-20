/**
 * Interface texts.
 *
 * Every string a person can read in the app lives under `es/`, grouped by
 * screen. Components import `t` and read `t.<namespace>.<key>`; parameterised or
 * plural texts are small functions, so word order and plurals stay with the
 * translator and no string is ever assembled in a component.
 *
 * To add another language: create a folder next to `es/` whose default export
 * has the same shape (`Messages` makes the compiler enforce that), then choose
 * it in `resolveLocale`. There is deliberately no i18n dependency yet; `t` is a
 * plain object, so a runtime switch only needs it to come from React context.
 */

import { es } from './es/index.ts';

export type Messages = typeof es;

/** BCP 47 tag used for `Intl` (dates, numbers, plurals). */
export const LOCALE = 'es-ES';

export const t: Messages = es;

/** "1 agente" / "3 agentes": picks the singular or plural form for `n`. */
export function plural(n: number, one: string, many: string): string {
  return n === 1 ? one : many;
}
