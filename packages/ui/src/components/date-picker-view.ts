// When a date input gets its calendar, and what opens it. Pure, so the progressive-enhancement
// rule is tested without a browser: the native input always renders and is always the value.

import type { PlainDate } from '@ultimat3/time';
import { isPlainDate } from '@ultimat3/time';

/** The media query a calendar popover waits for. A coarse pointer keeps the platform's picker. */
export const FINE_POINTER_QUERY = '(pointer: fine)';

/** The calendar is an extra for a fine pointer with a script; a phone's native picker wins. */
export function enhancesWithCalendar(
  matchMedia: ((query: string) => { matches: boolean }) | undefined,
): boolean {
  return matchMedia?.(FINE_POINTER_QUERY).matches === true;
}

/** F4 and Alt+ArrowDown open a date control's picker on every desktop platform. */
export function opensPicker(event: { readonly key: string; readonly altKey?: boolean }): boolean {
  return event.key === 'F4' || (event.key === 'ArrowDown' && event.altKey === true);
}

/** What the input holds, as a date: `undefined` for empty or a value the browser half-typed. */
export function inputDate(raw: string): PlainDate | undefined {
  return isPlainDate(raw) ? raw : undefined;
}

/**
 * Write a picked day into the native input the way typing would, so a form, a `Field` and any
 * `onInput`/`onChange` listener see one path whether the day came from the keyboard or the grid.
 */
export function writeInputDate(
  input: { value: string; dispatchEvent(event: Event): boolean },
  date: PlainDate,
): void {
  input.value = date;
  input.dispatchEvent(new Event('input', { bubbles: true }));
  input.dispatchEvent(new Event('change', { bubbles: true }));
}
