// The image-transform suite over `@ultimat3/seo`'s built-in driver, reading the fixture PNG, and
// the proof it can fail: a driver that reports the width asked for, not the one it made.

import { describe, expect, test } from 'bun:test';
import { builtinImageDriver } from '@ultimat3/seo';
import type { ImageTransformDriver } from '@ultimat3/seo/adapter';
import type { ImageTransformSubject } from './image-transform-conformance';
import {
  IMAGE_CONFORMANCE_SOURCE,
  IMAGE_TRANSFORM_CHECKS,
  imageTransformDriverConformance,
} from './image-transform-conformance';
import { behavesLike } from './shared-examples';
import { testName } from './test-types';

const SRC = '/media/conformance.png';

const builtin = (): ImageTransformDriver =>
  builtinImageDriver({
    read: async (src) => {
      if (src !== SRC) return expect.unreachable(`the driver read ${src}, not ${SRC}`);
      return IMAGE_CONFORMANCE_SOURCE;
    },
  });

describe(testName('unit', 'the built-in image driver'), () => {
  behavesLike(imageTransformDriverConformance, () => ({ driver: builtin(), src: SRC }));
});

/** Echoes the request's width and a height derived from it — what a CDN wrapper often does. */
function trusting(): ImageTransformSubject {
  const inner = builtin();
  return {
    src: SRC,
    driver: {
      name: 'trusting',
      blurPlaceholder: (src) => inner.blurPlaceholder(src),
      async transform(request) {
        const image = await inner.transform(request);
        return { ...image, width: request.width, height: request.width / 2 };
      },
    },
  };
}

const check = (prefix: string) => {
  const found = IMAGE_TRANSFORM_CHECKS.find((each) => each.name.startsWith(prefix));
  if (found === undefined) return expect.unreachable(`no image-transform check named ${prefix}`);
  return found;
};

describe(testName('unit', 'a driver that breaks the contract fails conformance'), () => {
  test('reporting the width asked fails the clamp check, passes the resize one', async () => {
    await check('a variant is the width asked').run(trusting());
    // Settled by hand, never `expect(…).rejects`: the transform answers from the raster Worker,
    // and Bun 1.4.4's `.rejects`/`.resolves` wait never delivers a Worker message once the test
    // has already awaited one — the line above did, so the matcher hung the file (measured).
    const clamped = check('a width past the source').run(trusting());
    expect(
      await clamped.then(
        () => 'passed',
        () => 'refused',
      ),
    ).toBe('refused');
  });

  test('every check has a name of its own', () => {
    const names = IMAGE_TRANSFORM_CHECKS.map((each) => each.name);
    expect(new Set(names).size).toBe(names.length);
  });
});
