// The `images` port's contract as shared examples: `behavesLike(imageTransformDriverConformance, ()
// => ({ driver, src }))` — `src` resolves to `IMAGE_CONFORMANCE_SOURCE`, a 64×32 PNG. What a
// variant says it is (type, width, height) is what the box the browser reserves is built from, so
// every claim is read back off the bytes the driver answered.

import { expect, test } from 'bun:test';
import { blankRaster, encodeImage, isUltimateError, probeImage } from '@ultimat3/core';
import type { ImageTransformDriver } from '@ultimat3/seo/adapter';
import type { SharedExamples } from './shared-examples';
import { sharedExamples } from './shared-examples';

export interface ImageTransformSubject {
  readonly driver: ImageTransformDriver;
  /** A source this driver reads as `IMAGE_CONFORMANCE_SOURCE`. */
  readonly src: string;
}

export interface ImageTransformCheck {
  readonly name: string;
  run(subject: ImageTransformSubject): Promise<void>;
}

/** 64×32, so a halving and a clamp are both visible in the height. */
export const IMAGE_CONFORMANCE_SOURCE: Uint8Array = encodeImage(blankRaster(64, 32));

const codeOf = (pending: Promise<unknown>): Promise<string> =>
  pending.then(
    () => 'answered',
    (error: unknown) => (isUltimateError(error) ? error.code : `not coded: ${String(error)}`),
  );

export const IMAGE_TRANSFORM_CHECKS: readonly ImageTransformCheck[] = [
  {
    name: 'a variant is the width asked, the aspect kept, and says exactly what its bytes are',
    async run({ driver, src }) {
      expect(driver.name.length).toBeGreaterThan(0);
      const image = await driver.transform({ src, width: 32, format: 'png' });
      const probed = probeImage(image.bytes);
      expect([image.width, image.height, image.contentType]).toEqual([32, 16, 'image/png']);
      expect([probed.width, probed.height, probed.format]).toEqual([32, 16, 'png']);
    },
  },
  {
    name: 'each format asked for is the format answered, and the content type names it',
    async run({ driver, src }) {
      for (const [format, type] of [
        ['jpeg', 'image/jpeg'],
        ['webp', 'image/webp'],
      ] as const) {
        const image = await driver.transform({ src, width: 16, format });
        expect([probeImage(image.bytes).format, image.contentType]).toEqual([format, type]);
      }
    },
  },
  {
    name: 'a width past the source is clamped, and the answer reports the size it really is',
    async run({ driver, src }) {
      const image = await driver.transform({ src, width: 512 });
      const probed = probeImage(image.bytes);
      expect([image.width, image.height]).toEqual([probed.width, probed.height]);
      expect(probed.width).toBeLessThanOrEqual(64);
    },
  },
  {
    name: 'a format that names nothing is refused X_IMAGE_UNSUPPORTED, never a guess',
    async run({ driver, src }) {
      expect(await codeOf(driver.transform({ src, width: 16, format: 'bitmap-ish' }))).toBe(
        'X_IMAGE_UNSUPPORTED',
      );
    },
  },
  {
    name: 'blurPlaceholder answers a small base64 image data URI',
    async run({ driver, src }) {
      const uri = await driver.blurPlaceholder(src);
      expect(uri).toMatch(/^data:image\/[a-z]+;base64,[A-Za-z0-9+/]+=*$/);
      expect(uri.length).toBeLessThan(4_096);
    },
  },
];

export const imageTransformDriverConformance: SharedExamples<ImageTransformSubject> =
  sharedExamples('an image transform driver', (subject) => {
    for (const check of IMAGE_TRANSFORM_CHECKS) {
      test(check.name, async () => {
        await check.run(subject());
      });
    }
  });
