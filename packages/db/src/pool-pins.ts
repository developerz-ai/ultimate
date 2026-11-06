// Single responsibility: the unanswered-statement bound of ONE pinned connection. A pin's statements
// are swept like any other, against the `statement_timeout` in force on that connection: the role's,
// until a `set_config('statement_timeout', …)` or `SET [LOCAL] statement_timeout` it answered moves
// it, and back to the role's at the transaction's end. A miss leaves the pin dead, never reused.

import type { SqlFragment } from './sql';

/** What one pin is bound by now. `boundMs` 0 is no bound, as the server reads it. */
export interface PinBound {
  boundMs: number;
  /** A statement on it went unanswered: nothing more is sent on this connection. */
  dead: boolean;
}

export function pinBound(roleBoundMs: number): PinBound {
  return { boundMs: roleBoundMs, dead: false };
}

/** The sweep's deadline for the next statement on `pin`; `0` is none to judge. */
export function pinDeadlineMs(pin: PinBound, extraMs: number): number {
  return pin.boundMs === 0 ? 0 : pin.boundMs + extraMs;
}

/** `setLocal`'s text (`local-settings.ts`), the framework's one writer, held by `pool-pins.test.ts`. */
const SET_CONFIG = 'select set_config($1, $2, true)';
const SET_TEXT = /^\s*set\s+(?:local\s+|session\s+)?statement_timeout\s*(?:=|to)\s*(.+?)\s*;?\s*$/i;
const SET_CONFIG_TEXT =
  /^\s*select\s+set_config\s*\(\s*'statement_timeout'\s*,\s*'([^']*)'\s*,\s*(?:true|false)\s*\)\s*;?\s*$/i;
const ENDS_TRANSACTION = /^\s*(?:commit|rollback|end|abort)(?:\s+(?:work|transaction))?\s*;?\s*$/i;
const UNITS: ReadonlyMap<string, number> = new Map([
  ['us', 0.001],
  ['ms', 1],
  ['s', 1_000],
  ['min', 60_000],
  ['h', 3_600_000],
  ['d', 86_400_000],
]);

/** A `statement_timeout` value in Postgres' own grammar, as ms: a bare number is ms. */
export function timeoutValueMs(value: unknown): number | undefined {
  if (typeof value !== 'string' && typeof value !== 'number') return undefined;
  const match = /^\s*'?\s*(\d+(?:\.\d+)?)\s*([a-z]*)\s*'?\s*$/i.exec(String(value));
  if (match === null) return undefined;
  const scale = UNITS.get((match[2] ?? '').toLowerCase() || 'ms');
  if (scale === undefined) return undefined;
  return Math.round(Number(match[1]) * scale);
}

/** The bound `fragment` sets, or `undefined` when it sets none (or one this cannot read). */
export function boundSetBy(fragment: SqlFragment): number | undefined {
  if (fragment.text === SET_CONFIG) {
    return fragment.values[0] === 'statement_timeout'
      ? timeoutValueMs(fragment.values[1])
      : undefined;
  }
  const text = SET_TEXT.exec(fragment.text) ?? SET_CONFIG_TEXT.exec(fragment.text);
  return text === null ? undefined : timeoutValueMs(text[1]);
}

/** After `fragment` ANSWERED on `pin`: a refused statement moved nothing. */
export function noteAnswered(pin: PinBound, fragment: SqlFragment, roleBoundMs: number): void {
  if (ENDS_TRANSACTION.test(fragment.text)) {
    pin.boundMs = roleBoundMs;
    return;
  }
  const set = boundSetBy(fragment);
  if (set !== undefined) pin.boundMs = set;
}
