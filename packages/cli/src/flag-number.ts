// One integer-flag reader for every command that takes one. `Number.parseInt` alone accepts a
// prefix and answers `NaN` for the rest, and three commands took it bare: `x doctor --port abc`
// probed `NaN`, which `portFree` reports as free — a check that CANNOT FAIL — `x dev --port abc`
// handed `NaN` to `Bun.serve` and bound an arbitrary port, and `x test --workers 4abc` ran four.

import { BadFlagError } from './errors';
import type { ParsedArgs } from './parse';
import { flagString } from './parse';

export interface IntFlag {
  readonly name: string;
  /** The command as it appears in the cause line, e.g. `doctor` for `x doctor`. */
  readonly command: string;
  readonly min: number;
  readonly max?: number;
  /** A runnable invocation carrying a good value — never a `<placeholder>`. */
  readonly example: string;
}

const bound = (flag: IntFlag): string =>
  flag.max === undefined ? `>= ${flag.min}` : `from ${flag.min} to ${flag.max}`;

/** `/^\d+$/` first: it is the only test that refuses `4abc`, `4.9`, `0x10`, `+4` and ` 4`. */
export function parseIntFlag(raw: string, flag: IntFlag): number {
  const value = /^\d+$/.test(raw) ? Number.parseInt(raw, 10) : Number.NaN;
  if (
    !Number.isInteger(value) ||
    value < flag.min ||
    (flag.max !== undefined && value > flag.max)
  ) {
    throw new BadFlagError({
      flag: flag.name,
      command: flag.command,
      reason: `expects an integer ${bound(flag)}, got "${raw}"`,
      fix: flag.example,
    });
  }
  return value;
}

/** The flag's value, or `undefined` when it was not given. Throws `X_CLI_BAD_FLAG` on a bad one. */
export function readIntFlag(args: ParsedArgs, flag: IntFlag): number | undefined {
  const raw = flagString(args, flag.name);
  return raw === undefined ? undefined : parseIntFlag(raw, flag);
}

/** The same, with a default — for a flag whose spec already declares one. */
export const intFlagOr = (args: ParsedArgs, flag: IntFlag, fallback: number): number =>
  readIntFlag(args, flag) ?? fallback;

/**
 * Every port flag answers to the same bounds `serve.ts`'s `portValue` already enforces on `PORT`,
 * 0 included — 0 is "let the kernel pick", which is how `x dev --port 0` boots a test server on a
 * free port. Two ranges for one concept is the drift this constant exists to prevent.
 */
export const PORT_RANGE = { min: 0, max: 65_535 } as const;

/**
 * A free-port suggestion the thing being fixed will actually accept. `port + 1` at the top of the
 * range names 65536, which is not a port — so a `fix:` built that way reproduces a failure instead
 * of ending one: `x doctor` emitted `x dev --port 65536`, which `x dev` refuses with
 * `X_CLI_BAD_FLAG`. The neighbour below is a port; the one above does not exist. Here rather than
 * beside either caller, because two ports-are-bounded rules is the drift `PORT_RANGE` above
 * already exists to prevent.
 */
export const neighbouringPort = (port: number): number =>
  port < PORT_RANGE.max ? port + 1 : PORT_RANGE.max - 1;
