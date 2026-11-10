// One transaction's search-index ops, merged per `(entity, tenant, id)`: a key's last document, and
// its removal unless a later op wrote it back — sent once the transaction COMMITS, removals first.
// Every send to one index rides one chain: an index hears this process's writes in commit order.

import { isUltimateError, logger, renderThrowable } from '@ultimat3/core';
import type { SearchDocument, SearchIndex } from './search-index';
import type { CommitScope } from './write-commit';

/** The one log event a failed mirror writes — its fields name the entity, the op and the code. */
export const SEARCH_INDEX_WRITE_FAILED = 'entity.search-index.write-failed';

export const unmirrored = (entity: string, op: string, cause: string, code?: string): void => {
  logger.warn(SEARCH_INDEX_WRITE_FAILED, {
    entity,
    op,
    ...(code === undefined ? {} : { code }),
    cause,
    fix: `reindex({ name: 'reindex-${entity}', entity, source, tenant: 'none' })   # rebuild the index, which missed this ${op}`,
  });
};

export const mirrorFailed = (entity: string, op: string, error: unknown): void =>
  unmirrored(entity, op, renderThrowable(error), isUltimateError(error) ? error.code : undefined);

/** One key's op: its document, or its removal at a tombstone version. */
export type MirrorOp = { readonly op: string; readonly document: SearchDocument } | Removal;

interface Removal {
  readonly op: string;
  readonly entity: string;
  readonly tenant: string | null;
  readonly id: string;
  readonly version: number;
}

/**
 * What one key owes at commit. A removal followed by a document keeps BOTH, in that order: the
 * document (`committed`) replaces the tombstone, and the removal is what retires the document the
 * index held — of an older incarnation, at a version the new row may not pass. A document followed
 * by a removal is the removal alone.
 */
interface KeyOps {
  removal?: Removal;
  document?: SearchDocument;
}

interface Pending {
  readonly index: SearchIndex;
  readonly ops: Map<string, KeyOps>;
  readonly unnamed: { readonly entity: string; readonly op: string; readonly count: number }[];
}

/** Each index's tail: the next send waits for the last, whatever it answered. */
const tails = new WeakMap<SearchIndex, Promise<void>>();

const send = (index: SearchIndex, entity: string, op: string, call: () => Promise<void>) => {
  const next = (tails.get(index) ?? Promise.resolve()).then(async () => {
    try {
      await call();
    } catch (error) {
      mirrorFailed(entity, op, error);
    }
  });
  tails.set(index, next);
};

const flush = ({ index, ops, unnamed }: Pending): void => {
  const documents: SearchDocument[] = [];
  const removals = new Map<
    string,
    { entity: string; tenant: string | null; version: number; op: string; ids: string[] }
  >();
  for (const { removal, document } of ops.values()) {
    if (document !== undefined) documents.push(document);
    if (removal === undefined) continue;
    const at = JSON.stringify([removal.entity, removal.tenant, removal.version]);
    const group = removals.get(at) ?? { ...removal, ids: [] };
    group.ids.push(removal.id);
    removals.set(at, group);
  }
  for (const { entity, tenant, version, op, ids } of removals.values()) {
    send(index, entity, op, () => index.remove({ entity, tenant }, ids, version));
  }
  if (documents.length > 0) {
    const [first] = documents;
    send(index, first?.entity ?? '', 'index', () => index.index(documents, { committed: true }));
  }
  for (const { entity, op, count } of unnamed) {
    unmirrored(entity, op, `${count} rows changed by a store that did not name them`);
  }
};

/** The open batch per transaction: one per scope, flushed by its commit and dropped by rollback. */
const open = new WeakMap<CommitScope, Pending>();

export interface MirrorBatch {
  put(key: string, op: MirrorOp): void;
  unnamed(entity: string, op: string, count: number): void;
}

/**
 * The batch `index` takes this write's ops into: the transaction's, registered on its commit the
 * first time — or, outside one, a batch sent as soon as it is filled (`done`).
 */
export const mirrorBatch = (
  index: SearchIndex,
  scope: CommitScope | undefined,
): MirrorBatch & { done(): void } => {
  const existing = scope === undefined ? undefined : open.get(scope);
  const pending = existing ?? { index, ops: new Map<string, KeyOps>(), unnamed: [] };
  if (scope !== undefined && existing === undefined) {
    open.set(scope, pending);
    scope.onCommit?.(() => {
      open.delete(scope);
      flush(pending);
    });
  }
  return {
    put: (key, op) => {
      if (!('document' in op)) {
        pending.ops.set(key, { removal: op });
        return;
      }
      pending.ops.set(key, { ...pending.ops.get(key), document: op.document });
    },
    unnamed: (entity, op, count) => {
      pending.unnamed.push({ entity, op, count });
    },
    done: () => {
      if (scope === undefined) flush(pending);
    },
  };
};
