// The memory disk's `signedUrlBase`: the base its signed URLs are minted under, and the one
// `acceptSignedUpload` defaults to — it follows the registered disk name unless one was given.

import { describe, expect, test } from 'bun:test';
import { frozenClock } from '@ultimat3/core';
import { memoryStorageDriver } from './driver-memory';
import { signedUrlBaseFor } from './signed-url';

const disk = (baseUrl?: string) =>
  memoryStorageDriver({
    signingSecret: 'test-secret',
    clock: frozenClock(0),
    ...(baseUrl === undefined ? {} : { baseUrl }),
  });

describe('memoryStorageDriver signedUrlBase', () => {
  test('defaults to the driver name, then follows the name a registry gives the disk', () => {
    const memory = disk();
    expect(memory.signedUrlBase).toBe(signedUrlBaseFor('memory'));
    memory.registerAs?.('avatars');
    expect(memory.signedUrlBase).toBe(signedUrlBaseFor('avatars'));
  });

  test('an explicit baseUrl is kept through registration', () => {
    const memory = disk('https://cdn.test/files');
    memory.registerAs?.('avatars');
    expect(memory.signedUrlBase).toBe('https://cdn.test/files');
  });
});
