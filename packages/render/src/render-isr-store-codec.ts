/**
 * What a store that SERIALIZES pages needs beside the store: an `IsrEntry` read back off bytes,
 * totally — anything else is a miss, never a cast.
 */

import type { IsrEntry } from './render-isr-store';

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * The stored text as an entry for `path`, or `undefined`. A shared store holds what another
 * release, another app or a hand wrote: an object whose `path` is not the key it sits under is
 * somebody else's page, and serving it would be #171 again.
 */
export function parseIsrEntry(text: string, path: string): IsrEntry | undefined {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (!isRecord(value)) return undefined;
  const { html, hash, generatedAt, ttlMs, stale, status } = value;
  if (value['path'] !== path || typeof html !== 'string' || typeof hash !== 'string') {
    return undefined;
  }
  if (typeof generatedAt !== 'number' || typeof stale !== 'boolean') return undefined;
  if (ttlMs !== null && typeof ttlMs !== 'number') return undefined;
  if (status !== undefined && typeof status !== 'number') return undefined;
  // `ttlMs` and `status` are screened again where they are read (`entryTtlMs`, `isRenderStatus`).
  return {
    path,
    html,
    hash,
    generatedAt,
    ttlMs,
    stale,
    ...(status === undefined ? {} : { status }),
  };
}
