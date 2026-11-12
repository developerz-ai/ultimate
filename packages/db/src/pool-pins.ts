// Single responsibility: the unanswered-statement bound of ONE pinned connection — the
// `statement_timeout` in force on it, which its statements are swept against like any other's. A
// miss leaves the pin dead, never reused.
//
// The bound is the role's until a `set_config('statement_timeout', …)` or `SET [LOCAL]
// statement_timeout` it answered moves it; back to the role's at the transaction's end or a RESET,
// and back to what a SAVEPOINT saw on a ROLLBACK TO it.

import { pinStatement } from './pin-statement';
import type { SqlFragment } from './sql';

/** An open savepoint and the bound in force when it was taken: a ROLLBACK TO it restores that. */
interface Savepoint {
  readonly name: string;
  readonly boundMs: number;
}

/** What one pin is bound by now. `boundMs` 0 is no bound, as the server reads it. */
export interface PinBound {
  boundMs: number;
  /** A statement on it went unanswered: nothing more is sent on this connection. */
  dead: boolean;
  /** Open savepoints, oldest first — the server's stack, as this pin answered it. */
  readonly savepoints: Savepoint[];
}

export function pinBound(roleBoundMs: number): PinBound {
  return { boundMs: roleBoundMs, dead: false, savepoints: [] };
}

/** The sweep's deadline for the next statement on `pin`; `0` is none to judge. */
export function pinDeadlineMs(pin: PinBound, extraMs: number): number {
  return pin.boundMs === 0 ? 0 : pin.boundMs + extraMs;
}

/** `setLocal`'s text (`local-settings.ts`), the framework's one writer, held by `pool-pins.test.ts`. */
const SET_CONFIG = 'select set_config($1, $2, true)';
/** Longer than any `statement_timeout` value; a bind value is library input too. */
const TIMEOUT_VALUE_CHARS_MAX = 64;
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
  if (String(value).length > TIMEOUT_VALUE_CHARS_MAX) return undefined;
  // Quotes and padding come off by hand, so the one pattern left has no two adjacent quantifiers
  // that can both take a space.
  let text = String(value).trim();
  if (text.startsWith("'")) text = text.slice(1);
  if (text.endsWith("'")) text = text.slice(0, -1);
  const match = /^(\d+(?:\.\d+)?)\s*([a-z]*)$/i.exec(text.trim());
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
  const statement = pinStatement(fragment.text);
  return statement?.kind === 'set' ? timeoutValueMs(statement.value) : undefined;
}

/** The newest open savepoint called `name`, or -1: names may repeat, the newest one is meant. */
function savepointIndex(pin: PinBound, name: string): number {
  return pin.savepoints.findLastIndex((savepoint) => savepoint.name === name);
}

/**
 * After `fragment` ANSWERED on `pin`: a refused statement moved nothing. ROLLBACK TO keeps its
 * savepoint and drops every newer one; RELEASE drops it and every newer one, keeping what was set
 * inside it. The statement is read once, by `pinStatement`.
 */
export function noteAnswered(pin: PinBound, fragment: SqlFragment, roleBoundMs: number): void {
  if (fragment.text === SET_CONFIG) {
    const set = boundSetBy(fragment);
    if (set !== undefined) pin.boundMs = set;
    return;
  }
  const statement = pinStatement(fragment.text);
  switch (statement?.kind) {
    case 'end':
      pin.boundMs = roleBoundMs;
      pin.savepoints.length = 0;
      return;
    case 'role-bound':
      pin.boundMs = roleBoundMs;
      return;
    case 'set': {
      const set = timeoutValueMs(statement.value);
      if (set !== undefined) pin.boundMs = set;
      return;
    }
    case 'savepoint':
      pin.savepoints.push({ name: statement.name, boundMs: pin.boundMs });
      return;
    case 'rollback-to': {
      const at = savepointIndex(pin, statement.name);
      const savepoint = pin.savepoints[at];
      if (savepoint === undefined) return;
      pin.boundMs = savepoint.boundMs;
      pin.savepoints.length = at + 1;
      return;
    }
    case 'release': {
      const at = savepointIndex(pin, statement.name);
      if (at !== -1) pin.savepoints.length = at;
      return;
    }
    default:
      return;
  }
}
