// The catalog as an installed `x` process sees it: no test preload, so no render loader unless the
// catalog installs one. The in-process suite cannot tell — `scripts/test-setup.ts` installs it for
// every test file, which is exactly how `x errors` shipped unable to load `@ultimat3/admin`.
// `x errors list` is `error-catalog-process-list.test.ts`: a child each, run side by side.

import { describe, expect, test } from 'bun:test';
import { run, TEST_TIMEOUT_MS } from './error-catalog-process-fixture';

describe('process · x errors without the test preload', () => {
  test(
    'explains a code owned by a `.tsx` package (admin)',
    async () => {
      const { exit, out, err } = await run('errors', 'explain', 'X_ADMIN_INVALID', '--json');
      expect({ exit, ok: JSON.parse(out).ok, err }).toEqual({ exit: 0, ok: true, err: '' });
    },
    TEST_TIMEOUT_MS,
  );
});
