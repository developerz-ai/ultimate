// The exercise room's storage seam: every object a disk wrote, copied or deleted while the observed
// call was in flight, read off core's `storage.<verb>` events. A write is the call's effect as a
// row or a mail is — an upload action that only stores an object is a reach that did something.

import { subscribe } from '@ultimat3/core';
import type { ExerciseEffect } from './exercise-report';

/** The verbs that change what a disk holds, each by its event; a get, stat or list leaves it be. */
const WRITES = [
  ['put', 'storage.put'],
  ['copy', 'storage.copy'],
  ['delete', 'storage.delete'],
] as const;

/** A write's effect `op`: the verb, or `multipart.<op>` for a change to an upload session. */
export type StorageWrite =
  | (typeof WRITES)[number][0]
  | `multipart.${'create' | 'part' | 'complete' | 'abort'}`;

interface WriteEvent {
  readonly payload: { readonly disk: string; readonly error?: unknown };
}

export interface RoomStorage {
  /** The observed call's writes since `clear()`: one effect per disk and verb, counted. */
  effects(): readonly ExerciseEffect[];
  clear(): void;
  /** Releases the subscriptions; the bus's other subscribers are untouched. */
  off(): void;
}

/** Subscribe to every write verb, keeping those made while `owns()` answers true. */
export function roomStorage(owns: () => boolean): RoomStorage {
  const kept = new Map<string, { disk: string; op: StorageWrite; count: number }>();
  const keep =
    (verb: StorageWrite) =>
    (event: WriteEvent): void => {
      // A refused write changed nothing, so it is no effect: the error is the call's answer.
      if (!owns() || event.payload.error !== undefined) return;
      const { disk } = event.payload;
      const key = `${disk}\u0000${verb}`;
      const known = kept.get(key) ?? { disk, op: verb, count: 0 };
      known.count += 1;
      kept.set(key, known);
    };
  const offs = [
    ...WRITES.map(([verb, event]) => subscribe(event, keep(verb))),
    subscribe('storage.multipart', (event) => keep(`multipart.${event.payload.op}`)(event)),
  ];
  return {
    effects: () =>
      [...kept.values()].map(({ disk, op, count }) => ({ kind: 'storage', disk, op, count })),
    clear: () => kept.clear(),
    off: () => {
      for (const off of offs) off();
    },
  };
}
