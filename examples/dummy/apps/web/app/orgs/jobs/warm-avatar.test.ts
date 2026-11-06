// The avatar warm-up: one job per uploaded key, in the org its input names, refusing a key outside
// that org before a byte is read — the job decodes what it is handed, so the tenant check is its.

import { blankRaster, encodeImage, isUltimateError } from '@ultimat3/core';
import {
  defineStorage,
  memoryStorageDriver,
  resetStorage,
  scopedKey,
  variantKey,
  variantRevision,
  warmVariants,
} from '@ultimat3/storage';
import { afterEach, expect, unitTest } from '@ultimat3/testing';
import { AVATAR_WIDTHS, warmAvatar } from './warm-avatar';

const ORG = '00000000-0000-4000-8000-0000000000a1';
const OTHER = '00000000-0000-4000-8000-0000000000a2';

afterEach(() => resetStorage());

unitTest('a warm-up is one job per key, run in the org the input names', () => {
  const input = { orgId: ORG, key: scopedKey(ORG, 'member', 'm1', 'avatar', 'a.png') };
  expect(warmAvatar.idempotencyKeyFor(input)).toBe(`avatars.warm:${input.key}`);
  expect(warmAvatar.tenantFor(input)).toBe(ORG);
});

unitTest(
  'every avatar width lands under the key /media reads, and none above the upload',
  async () => {
    const disk = memoryStorageDriver({ signingSecret: 'test-secret' });
    defineStorage({ disks: { memory: disk } });
    const key = scopedKey(ORG, 'member', 'm1', 'avatar', 'a.png');
    const stored = await disk.put(key, encodeImage(blankRaster(128, 128), 'png'), {
      contentType: 'image/png',
    });
    const warmed = await warmVariants({ disk, key, widths: AVATAR_WIDTHS, formats: ['webp'] });
    const revision = variantRevision(stored.etag);
    expect(warmed.written).toEqual([
      variantKey(key, { width: 48, format: 'webp', revision }),
      variantKey(key, { width: 96, format: 'webp', revision }),
    ]);
    expect(warmed.skipped).toEqual([192]);
  },
);

unitTest('a key outside the input org is refused by the job, never decoded', async () => {
  let refused: unknown;
  try {
    await warmAvatar.run({
      input: { orgId: ORG, key: scopedKey(OTHER, 'member', 'm1', 'avatar', 'a.png') },
    } as never);
  } catch (error) {
    refused = error;
  }
  expect(isUltimateError(refused) ? refused.code : refused).toBe('X_AVATAR_KEY_OUTSIDE_ORG');
});
