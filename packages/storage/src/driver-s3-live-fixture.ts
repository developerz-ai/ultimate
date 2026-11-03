// What the two s3 live suites share: `TEST_S3_URL` read as a target, and the wall clock a signed
// request needs. A fixture, so it ships in no package.

import type { Clock } from '@ultimat3/core';

export interface Target {
  readonly endpoint: string;
  readonly bucket: string;
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
}

/** `http://<key>:<secret>@host:port/<bucket>`, or nothing: a half-configured URL skips, never guesses. */
export const targetOf = (raw: string | undefined): Target | undefined => {
  if (raw === undefined || raw === '') return undefined;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return undefined;
  }
  const bucket = url.pathname.replace(/^\/+|\/+$/g, '');
  if (bucket === '' || url.username === '' || url.password === '') return undefined;
  return {
    endpoint: url.origin,
    bucket,
    accessKeyId: decodeURIComponent(url.username),
    secretAccessKey: decodeURIComponent(url.password),
  };
};

/**
 * The WALL clock. The preload freezes `Date`, and a signed request dated at the frozen instant is
 * `RequestTimeTooSkewed` — the server's clock is real. `performance` is not frozen.
 */
export const wallClock: Clock = {
  now: () => new Date(performance.timeOrigin + performance.now()),
  monotonic: () => performance.now(),
};
