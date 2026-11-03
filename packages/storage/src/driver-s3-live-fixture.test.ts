// The live suites' two shared readings, held here because a wrong one does not fail a live suite:
// it skips it. A half-configured `TEST_S3_URL` must skip rather than guess, and the clock a signed
// request is dated by must be the wall's, not the preload's frozen one.

import { describe, expect, test } from 'bun:test';
import { targetOf, wallClock } from './driver-s3-live-fixture';

describe('targetOf', () => {
  test('a whole URL is a target: userinfo is the key pair, the path the bucket', () => {
    expect(targetOf('http://id:se%2Fcret@127.0.0.1:9000/bucket-1/')).toEqual({
      endpoint: 'http://127.0.0.1:9000',
      bucket: 'bucket-1',
      accessKeyId: 'id',
      secretAccessKey: 'se/cret',
    });
  });

  test('anything less is no target, so the suite skips', () => {
    for (const raw of [
      undefined,
      '',
      'not a url',
      'http://127.0.0.1:9000/bucket',
      'http://id@127.0.0.1:9000/bucket',
      'http://id:secret@127.0.0.1:9000/',
    ]) {
      expect(targetOf(raw)).toBeUndefined();
    }
  });
});

describe('wallClock', () => {
  test('is not the frozen clock, and moves', () => {
    expect(wallClock.now().getTime()).not.toBe(Date.now());
    expect(wallClock.now().getTime()).toBeGreaterThan(Date.parse('2026-01-02T00:00:00Z'));
    const first = wallClock.monotonic();
    expect(wallClock.monotonic()).toBeGreaterThanOrEqual(first);
  });
});
