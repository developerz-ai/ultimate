// `storageSubjectTarget(disk, keysOf)`: the subject's stored objects as a subject target a
// `defineSubject({ targets })` lists — structural, so `@ultimat3/jobs` imports nothing from here.
// Which keys are the person's is the app's (`keysOf`); the export lists each object, the erase
// deletes them. A key the app does not name is not found: there is no listing by owner.

import type { StorageDriver } from './driver';

/** The subject as a target is handed it: the key asked for, and the subject's row read fresh. */
export interface StorageSubjectRef {
  readonly key: string;
  readonly row: Readonly<Record<string, unknown>>;
}

export interface StorageSubjectTargetOptions {
  /** The step key and export folder. Default `storage`. Unique among one subject's targets. */
  readonly name?: string;
}

type Cell = string | number | boolean | null;

export interface StorageSubjectTarget {
  readonly name: string;
  readonly columns: readonly string[];
  exportPage(
    subject: StorageSubjectRef,
    cursor: string | null,
    size: number,
  ): Promise<{
    readonly rows: readonly Readonly<Record<string, Cell>>[];
    readonly cursor: string | null;
  }>;
  erase(subject: StorageSubjectRef, size: number): Promise<number>;
}

export const STORAGE_SUBJECT_COLUMNS = ['key', 'size', 'contentType', 'lastModified'] as const;

/**
 * `disk` is a THUNK, read per call, as an export's sink is: a subject is declared at import and
 * the app's disks exist after `defineStorage()`.
 */
export function storageSubjectTarget(
  disk: () => StorageDriver,
  /** The person's keys — a list the app builds, or lists from a prefix it owns. */
  keysOf: (subject: StorageSubjectRef) => readonly string[] | Promise<readonly string[]>,
  options: StorageSubjectTargetOptions = {},
): StorageSubjectTarget {
  return {
    name: options.name ?? 'storage',
    columns: STORAGE_SUBJECT_COLUMNS,
    async exportPage(subject, cursor, size) {
      const keys = await keysOf(subject);
      const start = cursor === null ? 0 : Number(cursor);
      const page = keys.slice(start, start + size);
      const rows: Record<string, Cell>[] = [];
      for (const key of page) {
        const found = await disk().stat(key);
        if (found === undefined) continue;
        rows.push({
          key,
          size: found.size,
          contentType: found.contentType,
          // An instant, UTC, its zone in the string — never formatted for a locale here. Absent
          // when the provider sent none, and never invented.
          lastModified: found.lastModified?.toISOString() ?? null,
        });
      }
      const next = start + page.length;
      return { rows, cursor: next < keys.length ? String(next) : null };
    },
    async erase(subject, size) {
      // Only what still exists counts, so a replayed batch answers short and the loop ends.
      let removed = 0;
      for (const key of await keysOf(subject)) {
        if (removed >= size) break;
        if (!(await disk().exists(key))) continue;
        await disk().delete(key);
        removed += 1;
      }
      return removed;
    },
  };
}
