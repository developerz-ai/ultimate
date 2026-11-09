// A patch frame as text, built around a patch list encoded ONCE for every subscriber of a change.
// The frame differs per subscriber by its `sid` alone when the gate let the whole list through, so
// stringifying the list per subscriber was the fanout's cost growing with every viewer.

import type { RowPatch } from './json';
import { PROTOCOL_VERSION } from './sync-protocol';

/**
 * Byte-for-byte `encode(patchFrame(sid, patches, lsn, writes))` with `patches` already encoded:
 * the same keys in the same order, and `JSON.stringify` is compositional with no indentation.
 * Pinned against the unshared spelling by `live-fanout.test.ts`.
 */
export function encodePatchFrame(
  sid: string,
  patchesJson: string,
  lsn: string,
  writes: readonly string[],
): string {
  const head = `{"type":"patch","v":${JSON.stringify(PROTOCOL_VERSION)},"sid":${JSON.stringify(sid)}`;
  const tail = writes.length === 0 ? '' : `,"writes":${JSON.stringify(writes)}`;
  return `${head},"patches":${patchesJson},"lsn":${JSON.stringify(lsn)}${tail}}`;
}

/** The gate let every patch through untouched: the shared encoding is this subscriber's too. */
export function samePatches(allowed: readonly RowPatch[], shared: readonly RowPatch[]): boolean {
  if (allowed === shared) return true;
  if (allowed.length !== shared.length) return false;
  for (let at = 0; at < allowed.length; at += 1) if (allowed[at] !== shared[at]) return false;
  return true;
}
