// A read's input as its declared schema keeps it — what every key over `(query, input)` hashes.
// Keyed raw, an unknown key the schema strips (`?junk=N`) minted a new entry per value; the read
// cache keys on the parse inside `read.ts`, and a live window (`@ultimat3/realtime`) asks here.

import type { AnyQuery } from './query';
import { defOf, queryName } from './read';
import { parseQueryInput } from './validate';

/**
 * The parse alone: no actor, no policy, no rate limit, no `sql()`. `X_INPUT_INVALID` for an input
 * the schema refuses, exactly as the read path answers it. The caller still reads through
 * `sourceFor` / `.live()` — this decides a KEY, never an admission.
 */
export function parsedQueryInput(target: AnyQuery, raw: unknown): Promise<unknown> {
  return parseQueryInput(defOf(target).input, raw, queryName(target));
}
