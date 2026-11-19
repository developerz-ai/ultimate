// The port a "port in use" fix names. On a machine running several dev servers the next pair is
// often taken as well, and a fix that fails the same way is not a fix. Not `@ultimat3/testing`'s
// `freePortPair`, which binds; this one only asks.

import { PORT_RANGE, portPairAfter } from './flag-number';

/** How far to look: past this the machine is unusual and the plain suggestion is as good. */
const PAIRS_TRIED = 64;

/**
 * The first pair after `port` with both ports free, walking the way `portPairAfter` points (down at
 * the top of the range). `x dev --port N` binds N and N + 1, so both are asked. The answer is true
 * when asked: another process can still take it.
 */
export async function freeDevPortPair(
  port: number,
  isFree: (port: number) => boolean | Promise<boolean>,
): Promise<number> {
  const first = portPairAfter(port);
  const step = first > port ? 2 : -2;
  let candidate = first;
  for (let tried = 0; tried < PAIRS_TRIED; tried += 1) {
    if (candidate < 1 || candidate + 1 >= PORT_RANGE.max) break;
    if ((await isFree(candidate)) && (await isFree(candidate + 1))) return candidate;
    candidate += step;
  }
  return first;
}
