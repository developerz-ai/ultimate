// The `StorageDriver` contract as shared examples: `behavesLike(storageDriverConformance, () =>
// disk)` runs every check against a disk of your own, one test per check. Each check writes under
// a key prefix of its own, so one bucket serves every test, two runs at once, and a run that died.

import { test } from 'bun:test';
import type { SharedExamples } from './shared-examples';
import { sharedExamples } from './shared-examples';
import { STORAGE_READ_CHECKS } from './storage-conformance-read-checks';
import type { StorageCheck, StorageDriverLike, StorageSubject } from './storage-conformance-shape';
import { STORAGE_STREAM_CHECKS } from './storage-conformance-stream-checks';

export type { StorageCheck, StorageDriverLike, StorageSubject } from './storage-conformance-shape';

/** Every check, in the order a failing run reads best: writes and reads, then lists and streams. */
export const STORAGE_DRIVER_CHECKS: readonly StorageCheck[] = [
  ...STORAGE_READ_CHECKS,
  ...STORAGE_STREAM_CHECKS,
];

/** A bare disk, or `{ disk, maxPutBytes }` for a disk built with a ceiling the suite should know. */
type Subject = StorageDriverLike | StorageSubject;

const subjectOf = (given: Subject): StorageSubject => ('disk' in given ? given : { disk: given });

export const storageDriverConformance: SharedExamples<Subject | Promise<Subject>> = sharedExamples(
  'a storage driver',
  (subject) => {
    for (const check of STORAGE_DRIVER_CHECKS) {
      test(check.name, async () => {
        await check.run(subjectOf(await subject()));
      });
    }
  },
);
