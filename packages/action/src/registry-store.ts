/**
 * The registered actions, by name — the one map, held in a leaf so `http-path.ts` can resolve a
 * NAME to its declaration (a pinned `http.path`) without importing `registry.ts`, which imports
 * `action.ts`, which imports `http-path.ts`. `registry.ts` is the only writer.
 */

import type { AnyAction } from './action';

export const seatedActions = new Map<string, AnyAction>();
