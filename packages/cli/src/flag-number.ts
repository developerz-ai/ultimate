// One integer-flag reader for every command that takes one. `Number.parseInt` alone accepts a
// prefix and answers `NaN` for the rest, and three commands took it bare: `x doctor --port abc`
// probed `NaN`, which `portFree` reports as free — a check that CANNOT FAIL — `x dev --port abc`
// handed `NaN` to `Bun.serve` and bound an arbitrary port, and `x test --workers 4abc` ran four.

import { UltimateError } from '@ultimat3/core';
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

/**
 * The same suggestion for a caller that binds a PAIR. `x dev --port N` occupies N and N + 1, so
 * `neighbouringPort` hands back the neighbour — which, when it is the neighbour that was taken, is
 * the very socket the refusal is about: `x dev --port 3999` died on 4000 and its `fix:` said
 * `x dev --port 4000`, and `x doctor` said it too, about the same pair (both pinned by a test
 * named "its fix is a command that ends the failure"). Two above is the nearest base whose own
 * pair touches neither.
 *
 * Downward at the top of the range, for `neighbouringPort`'s reason and one further: the answer's
 * OWN neighbour has to be a port, or `syncPortFor` refuses the suggestion with `X_PORT_INVALID`.
 * Only reachable above 65532, so the subtraction can never go below the range.
 */
export const portPairAfter = (port: number): number =>
  port + 2 < PORT_RANGE.max ? port + 2 : port - 2;

/**
 * Beside its one thrower rather than in `errors.ts`, which is near its 500-line ceiling — the
 * arrangement `db-seed.ts` and `metrics-endpoint.ts` already take. The code is
 * `X_PORT_INVALID`, this package's own: "the port asked for is not one" is what it already means,
 * and a second code for the same fact is the synonym the registry exists to prevent.
 */
class SyncPortUnavailableError extends UltimateError {
  constructor(input: { port: number }) {
    super({
      code: 'X_PORT_INVALID',
      cause: `the sync role binds PORT + 1, and PORT=${input.port} is the top of the range — it would ask for ${input.port + 1}, which is not a TCP port`,
      fix: `x dev --port ${neighbouringPort(input.port)}   # leaves ${PORT_RANGE.max} free for the sync node`,
      meta: { port: input.port },
    });
  }
}

/**
 * The port the sync node listens on. `PORT + 1`, and `0` stays `0` — the kernel picks, and adding
 * one to it would pick a specific port instead.
 *
 * REFUSED at the top of the range, never clamped. `PORT_RANGE.max` is 65535 and `portValue`
 * accepts it, so `x dev --port 65535` handed `Bun.serve` 65536 and the bare `RangeError` reached
 * the terminal as `X_CLI_UNEXPECTED` with `fix: x doctor --json`. Clamping to 65534 would be worse
 * than refusing: `PORT + 1` is the rule `docker/docker-compose.prod.yml` publishes `3001:3001`
 * from and `docker/helm` derives `PORT = .port - 1` from, so a node quietly on `PORT - 1` is a
 * socket nothing else in the deployment computes.
 */
export function syncPortFor(port: number): number {
  if (port === 0) return 0;
  if (port >= PORT_RANGE.max) throw new SyncPortUnavailableError({ port });
  return port + 1;
}
