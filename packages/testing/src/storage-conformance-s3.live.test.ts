// The storage conformance suite over the s3 disk and a real server (`TEST_S3_URL`, shaped like
// `http://<key>:<secret>@host:port/<bucket>`): the memory run proves the checks, this one proves the
// signed wire meets them. Every key a check wrote is deleted after the run.

import { afterAll, describe } from 'bun:test';
import { markListening } from '@ultimat3/core';
import { s3Driver } from '@ultimat3/storage';
import { behavesLike } from './shared-examples';
import { storageDriverConformance } from './storage-conformance';
import { liveS3Target } from './storage-conformance-s3-fixture';
import type { StorageDriverLike } from './storage-conformance-shape';
import { testName } from './test-types';

const live = liveS3Target(Bun.env['TEST_S3_URL']);

describe.skipIf(live === undefined)(testName('live', 'the s3 storage driver'), () => {
  if (live === undefined) return;
  const disk = s3Driver(live.options);
  const release = markListening(live.origin);
  const written = new Set<string>();
  // Recorded once a write lands: the suite's keys are its own, so the teardown deletes those alone.
  const landed = async <T>(key: string, write: Promise<T>): Promise<T> => {
    const object = await write;
    written.add(key);
    return object;
  };
  const recording: StorageDriverLike = {
    ...disk,
    put: (key, body, options) => landed(key, disk.put(key, body, options)),
    putStream: (key, stream, options) => landed(key, disk.putStream(key, stream, options)),
    copy: (from, to, options) => landed(to, disk.copy(from, to, options)),
  };

  afterAll(async () => {
    for (const key of written) await disk.delete(key);
    release();
  });

  behavesLike(storageDriverConformance, () => recording);
});
