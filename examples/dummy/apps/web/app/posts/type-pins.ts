/**
 * Compile-time pins, read by `tsc` and by nothing at runtime. A mutator's `local` twin is typed
 * against `@ultimat3/action`'s `LocalTable` and RUN against `@ultimat3/realtime`'s store tx: two
 * packages at one tier, which may not import each other, declaring one shape. This app imports
 * both, so it is where their agreement can be a build error — either drifting fails typecheck here.
 */

import type { LocalTable as ActionTable } from '@ultimat3/action';
import type { LocalTable as StoreTable } from '@ultimat3/realtime';

/** A row shaped like the ones this app's twins write. */
type PinnedRow = { readonly id: string; readonly likeCount: number; readonly likedByMe?: boolean };

type Mutual<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;

/** The store's table is a twin's table, and a twin's table is the store's. */
export const TWIN_TABLE_IS_STORE_TABLE: Mutual<
  ActionTable<PinnedRow>,
  StoreTable<PinnedRow>
> = true;
