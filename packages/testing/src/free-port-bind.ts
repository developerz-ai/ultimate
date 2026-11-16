// One responsibility: hand a binder free ports, and when another process took one between the ask
// and the bind, ask again. A port asked of the OS and released is a promise nothing keeps: the
// probe-then-bind race lost on CI more than once (`092c7cd38`, `3ea39eebb`). The bind is the proof.

import type { PortProbe } from './free-port';
import { freePortApartFrom, freePortPair } from './free-port';

/**
 * How many binds one call makes before the last clash is the caller's answer. A clash is another
 * process winning a race it rarely wins: a second loss is already rare, a fifth is a box whose
 * ephemeral range is exhausted, and asking again would only hide that.
 */
export const PORT_BIND_ATTEMPTS = 5;

/** What a lost race says: Bun's listener (`EADDRINUSE`) and the CLI's own refusal (`X_PORT_IN_USE`). */
const CLASH_CODES: ReadonlySet<string> = new Set(['EADDRINUSE', 'X_PORT_IN_USE']);
const CLASH_TEXT = /\b(?:EADDRINUSE|X_PORT_IN_USE)\b|Is port \d+ in use\?/;

const field = (value: object, key: string): unknown => Reflect.get(value, key);

/**
 * Whether `failure` says a port was already taken: an error carrying the code, or text — a child's
 * output, an error's message or cause — naming it. A child process has no error object to hand
 * over, only what it printed, so text is read the same way.
 */
export const isPortClash = (failure: unknown): boolean => {
  if (typeof failure === 'string') return CLASH_TEXT.test(failure);
  if (typeof failure !== 'object' || failure === null) return false;
  const code = field(failure, 'code');
  if (typeof code === 'string' && CLASH_CODES.has(code)) return true;
  return ['message', 'cause'].some((key) => {
    const text = field(failure, key);
    return typeof text === 'string' && CLASH_TEXT.test(text);
  });
};

export interface BindFreePortsOptions {
  /** How many distinct ports `bind` is handed. Default 1. */
  readonly count?: number;
  /** The first port's neighbour is free too — `x dev` binds its sync node on `port + 1`. */
  readonly pair?: boolean;
  /** Whether a failure `bind` threw is a lost race. Default `isPortClash`. */
  readonly clashed?: (failure: unknown) => boolean;
  /** Ports the caller already holds or handed out (a sync node's `port + 1` too): none is handed again. */
  readonly apart?: readonly number[];
  /** Default `PORT_BIND_ATTEMPTS`. */
  readonly attempts?: number;
  /** The OS's listener, for a test of the walk itself. */
  readonly listen?: () => PortProbe;
}

/** One attempt's ports: never one an earlier attempt was handed, nor a pair's neighbour. */
const portsFor = (
  count: number,
  pair: boolean,
  tried: number[],
  listen: (() => PortProbe) | undefined,
): number[] => {
  const ports: number[] = [];
  for (let index = 0; index < count; index += 1) {
    const port =
      index === 0 && pair
        ? freePortPair(listen, undefined, tried)
        : freePortApartFrom(tried, listen);
    ports.push(port);
    tried.push(port);
    if (index === 0 && pair) tried.push(port + 1);
  }
  return ports;
};

/**
 * Run `bind` on free ports until it binds them. `bind` must BIND — listen in this process, or spawn
 * the child and wait until it listens or exits — and throw what it met: a failure `clashed` reads
 * as a lost race is answered with fresh ports, apart from every port already tried; anything else,
 * and the last clash, is rethrown as it was. The ONE way a test takes a port it cannot bind as 0.
 */
export async function bindFreePorts<T>(
  bind: (ports: readonly number[]) => T | Promise<T>,
  options: BindFreePortsOptions = {},
): Promise<T> {
  const attempts = options.attempts ?? PORT_BIND_ATTEMPTS;
  const clashed = options.clashed ?? isPortClash;
  const tried: number[] = [...(options.apart ?? [])];
  for (let attempt = 1; ; attempt += 1) {
    const ports = portsFor(options.count ?? 1, options.pair ?? false, tried, options.listen);
    try {
      return await bind(ports);
    } catch (failure) {
      if (attempt >= attempts || !clashed(failure)) throw failure;
    }
  }
}
