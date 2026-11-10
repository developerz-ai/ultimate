// When a write's consequences may be told: at COMMIT. One rule for the row observer and the search
// mirror, so a change neither reports nor indexes before a rollback could still erase it.

import { currentTx } from '@ultimat3/db';
import { memoryJournal } from './memory-journal';
import type { RepoOptions } from './repo';

/** What a commit effect is registered on. */
export interface CommitScope {
  onCommit?(effect: () => void): void;
}

/**
 * The transaction a write joins — the caller's `options.tx`, the ambient `withTransaction` a
 * Postgres repository joins, or the ambient memory one — or `undefined` outside one, where the
 * write is already durable.
 */
export const commitScope = (options: RepoOptions | undefined): CommitScope | undefined => {
  const tx: CommitScope | undefined = options?.tx ?? currentTx() ?? memoryJournal();
  return tx?.onCommit === undefined ? undefined : tx;
};

/** Run `effect` when the write's transaction commits, never on rollback; outside one, at once. */
export const afterCommit = (options: RepoOptions | undefined, effect: () => void): void => {
  const tx = commitScope(options);
  if (tx === undefined) effect();
  else tx.onCommit?.(effect);
};
