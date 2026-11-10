// The ISR store conformance suite over the storage-backed store on a real s3 server
// (`TEST_S3_URL`, `http://<key>:<secret>@host:port/<bucket>`): what three replicas share in
// production. One key prefix per run, emptied by the teardown.

import { afterAll, describe } from 'bun:test';
import { markListening } from '@ultimat3/core';
import { storageIsrStore } from '@ultimat3/render/server';
import { s3Driver } from '@ultimat3/storage';
import { isrStoreConformance } from './isr-store-conformance';
import { behavesLike } from './shared-examples';
import { liveS3Target } from './storage-conformance-s3-fixture';
import { testName } from './test-types';

const live = liveS3Target(Bun.env['TEST_S3_URL']);

describe.skipIf(live === undefined)(testName('live', 'the storage-backed ISR store on s3'), () => {
  if (live === undefined) return;
  const disk = s3Driver(live.options);
  const release = markListening(live.origin);
  const prefix = `xlive-isr-${crypto.randomUUID()}/`;

  afterAll(async () => {
    let cursor: string | null = null;
    do {
      const page = await disk.list({ prefix, limit: 100, cursor });
      for (const row of page.rows) await disk.delete(row.key);
      cursor = page.nextCursor;
    } while (cursor !== null);
    release();
  });

  behavesLike(isrStoreConformance, () => storageIsrStore({ disk, prefix }));
});
