// Single responsibility: objects and upload sessions past a window the APP names, swept on any
// disk. Bucket lifecycle rules stay the operator's (axiom 7); a local disk has none, and abandoned
// parts bill silently forever without one, so a sweep that works the same on every disk is
// mechanism. No timer here: `objectPurgeTarget` hands the sweep to the app's one `purge()` job.

import {
  assert,
  type Clock,
  finiteCount,
  logger,
  renderThrowable,
  systemClock,
} from '@ultimat3/core';
import type { SweepFailure, SweepResult } from './attachment';
import type { StorageDriver, StorageListEntry } from './driver';
import type { MultipartSession } from './multipart';

export interface ExpireObjectsInput {
  readonly disk: StorageDriver;
  /** Required and non-empty: a sweep of the whole disk is never a default. */
  readonly prefix: string;
  /** Age past which an object goes. Required: the window is the app's. */
  readonly olderThanMs: number;
  /** `true` spares an object the app still accounts for. */
  readonly keep?: ((object: StorageListEntry) => boolean | Promise<boolean>) | undefined;
  readonly clock?: Clock | undefined;
}

/** `SweepResult`'s two lists, plus what was spared: undated, inside the window, or kept. */
export interface ExpireResult extends SweepResult {
  readonly spared: readonly string[];
}

const screenPrefix = (caller: string, prefix: string): string => {
  assert(
    typeof prefix === 'string' && prefix !== '',
    `${caller} was handed an empty prefix, which is the whole disk`,
    `${caller}({ disk, prefix: 'exports/', olderThanMs })   # name the prefix the window applies to`,
  );
  return prefix;
};

const cutoffOf = (caller: string, olderThanMs: number, clock: Clock | undefined): number =>
  // Screened first: `now - NaN` is NaN, and every age comparison against it reads "old enough".
  (clock ?? systemClock).now().getTime() - finiteCount(caller, 'olderThanMs', olderThanMs, 0);

/**
 * Delete every object under `prefix` older than the window. An object with no reported age is
 * spared, as `sweepOrphans` spares it; a refusal — a locked object included — is recorded in
 * `failed` and the sweep goes on, never forced and never reported as deleted.
 */
export async function expireObjects(input: ExpireObjectsInput): Promise<ExpireResult> {
  const prefix = screenPrefix('expireObjects', input.prefix);
  const cutoff = cutoffOf('expireObjects', input.olderThanMs, input.clock);
  const deleted: string[] = [];
  const failed: SweepFailure[] = [];
  const spared: string[] = [];
  let cursor: string | null = null;
  do {
    const page = await input.disk.list({ prefix, cursor });
    for (const object of page.rows) {
      const modified = object.lastModified?.getTime();
      if (modified === undefined || modified > cutoff || (await input.keep?.(object)) === true) {
        spared.push(object.key);
        continue;
      }
      try {
        await input.disk.delete(object.key);
        deleted.push(object.key);
      } catch (error) {
        failed.push({ key: object.key, reason: renderThrowable(error) });
      }
    }
    cursor = page.nextCursor;
  } while (cursor !== null);
  return { deleted, failed, spared };
}

export interface AbortStaleUploadsInput {
  readonly disk: StorageDriver;
  /** Age past which an open session is abandoned. */
  readonly olderThanMs: number;
  /** Absent is every session on the disk: an open session under no prefix bills all the same. */
  readonly prefix?: string | undefined;
  /** Only sessions whose key this answers `true` for: a per-tenant kind no prefix spells. */
  readonly match?: ((key: string) => boolean) | undefined;
  readonly clock?: Clock | undefined;
}

export interface AbortResult {
  readonly aborted: readonly MultipartSession[];
  readonly failed: readonly SweepFailure[];
  /** Undated or inside the window: possibly a phone still on the train. */
  readonly spared: readonly MultipartSession[];
}

/** Abort every upload session opened before the window and never completed. */
export async function abortStaleUploads(input: AbortStaleUploadsInput): Promise<AbortResult> {
  const cutoff = cutoffOf('abortStaleUploads', input.olderThanMs, input.clock);
  const multipart = input.disk.multipart;
  if (multipart === undefined) return { aborted: [], failed: [], spared: [] };
  const aborted: MultipartSession[] = [];
  const failed: SweepFailure[] = [];
  const spared: MultipartSession[] = [];
  for (const session of await multipart.listUploads(input.prefix)) {
    if (input.match !== undefined && !input.match(session.key)) continue;
    const initiated = session.initiated?.getTime();
    if (initiated === undefined || initiated > cutoff) {
      spared.push(session);
      continue;
    }
    try {
      await multipart.abort(session.key, session.uploadId);
      aborted.push(session);
    } catch (error) {
      failed.push({ key: session.key, reason: renderThrowable(error) });
    }
  }
  return { aborted, failed, spared };
}

export interface ObjectPurgeTargetInput {
  /** The step's name in the purge job, unique within it. */
  readonly name: string;
  readonly disk: StorageDriver;
  readonly prefix: string;
  /**
   * Only keys this answers `true` for, under `prefix`: `org/<id>/imports/` is one kind of file
   * under every tenant, and no prefix names it without also naming every avatar beside it.
   */
  readonly match?: ((key: string) => boolean) | undefined;
  readonly olderThanMs: number;
}

/**
 * Structurally `@ultimat3/jobs`' `PurgeTarget`, so this package imports nothing upward and the
 * app's one `purge({ targets })` carries it. One pass expires the objects and aborts the sessions
 * under the prefix, on the JOB's clock. A refusal is logged and counted out, never retried into a
 * dead letter: a locked object stays locked on every attempt.
 */
export function objectPurgeTarget(input: ObjectPurgeTargetInput): {
  readonly name: string;
  purgeExpired(nowMs: number): Promise<number>;
} {
  const prefix = screenPrefix('objectPurgeTarget', input.prefix);
  finiteCount('objectPurgeTarget', 'olderThanMs', input.olderThanMs, 0);
  return {
    name: input.name,
    async purgeExpired(nowMs: number): Promise<number> {
      const clock: Clock = { now: () => new Date(nowMs), monotonic: () => nowMs };
      const window = { disk: input.disk, prefix, olderThanMs: input.olderThanMs, clock };
      const match = input.match;
      // Outside `match` is spared, never deleted: `keep` is `expireObjects`' own way of saying so.
      const objects = await expireObjects(
        match === undefined ? window : { ...window, keep: (object) => !match(object.key) },
      );
      const uploads = await abortStaleUploads({ ...window, match });
      const failed = [...objects.failed, ...uploads.failed];
      if (failed.length > 0) {
        logger.warn('storage.expire.refused', {
          target: input.name,
          refused: failed.length,
          first: failed[0]?.reason,
        });
      }
      return objects.deleted.length + uploads.aborted.length;
    },
  };
}
