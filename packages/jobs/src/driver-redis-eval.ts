// How the Redis driver runs a Lua script: `EVALSHA` by the script's SHA-1, so a claim sends 40
// bytes instead of its whole body; `EVAL` only when the server answers `NOSCRIPT` (a restart, a
// failover, a `SCRIPT FLUSH`), which both runs the script and caches it for the next call.

import { stringField } from '@ultimat3/core';
import type { RedisSender } from './driver-redis';

/**
 * Script text → SHA-1, hashed once per script. Bounded by construction: the keys are the
 * driver's own script constants, never a caller's string.
 */
const shas = new Map<string, string>();

const shaOf = (script: string): string => {
  let sha = shas.get(script);
  if (sha === undefined) {
    sha = new Bun.CryptoHasher('sha1').update(script).digest('hex');
    shas.set(script, sha);
  }
  return sha;
};

/**
 * `script` with `keys` and `args`, by SHA. No `SCRIPT LOAD` round trip ahead of the first call:
 * the hash is computed here, and the one `NOSCRIPT` a cold server answers is the load. Any other
 * error is the script's own and passes through untouched — re-sending the body would only fail
 * the same way twice.
 */
export async function evalCached(
  client: RedisSender,
  script: string,
  tail: readonly string[],
): Promise<unknown> {
  try {
    return await client.send('EVALSHA', [shaOf(script), ...tail]);
  } catch (error) {
    if (!(stringField(error, 'message') ?? '').includes('NOSCRIPT')) throw error;
    return client.send('EVAL', [script, ...tail]);
  }
}
