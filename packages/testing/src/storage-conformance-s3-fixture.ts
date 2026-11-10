// What the s3-backed conformance runs share: `TEST_S3_URL` read as a disk, and the wall clock a
// signed request needs. A fixture, so it ships in no package (`!src/**/*-fixture.ts`).

import type { Clock } from '@ultimat3/core';

/** The preload freezes `Date`; a request signed at the frozen instant is `RequestTimeTooSkewed`. */
const wallClock: Clock = {
  now: () => new Date(performance.timeOrigin + performance.now()),
  monotonic: () => performance.now(),
};

/**
 * `http://<key>:<secret>@host:port/<bucket>` as `s3Driver` options, and the origin to announce
 * with core's `markListening` so the sealed `fetch` lets it through — or nothing: a
 * half-configured URL skips, never guesses. Options, not a driver: this file is in the package
 * build, which takes no dependency on `@ultimat3/storage` (`storage-conformance-shape.ts`).
 */
export function liveS3Target(raw: string | undefined) {
  if (raw === undefined || raw === '' || !URL.canParse(raw)) return undefined;
  const url = new URL(raw);
  const bucket = url.pathname.replace(/^\/+|\/+$/g, '');
  if (bucket === '' || url.username === '' || url.password === '') return undefined;
  const options = {
    bucket,
    endpoint: url.origin,
    forcePathStyle: true,
    env: {
      S3_ACCESS_KEY_ID: decodeURIComponent(url.username),
      S3_SECRET_ACCESS_KEY: decodeURIComponent(url.password),
    },
    clock: wallClock,
  };
  return { options, origin: url.origin };
}
