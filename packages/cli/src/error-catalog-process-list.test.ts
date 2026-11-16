// `x errors list` as an installed `x` process sees it: every package's codes, none failed to
// initialize, with no test preload to install a render loader the catalog forgot. The `explain`
// child is `error-catalog-process.test.ts`; a file each so the two cold loads run side by side.

import { describe, expect, test } from 'bun:test';
import { run, TEST_TIMEOUT_MS } from './error-catalog-process-fixture';

describe('process · x errors without the test preload', () => {
  test(
    'lists every package with nothing failed to initialize',
    async () => {
      const { exit, out } = await run('errors', 'list', '--json');
      const doc: unknown = JSON.parse(out);
      expect({ exit, doc }).toMatchObject({ exit: 0, doc: { ok: true } });
      expect(JSON.stringify(doc)).not.toContain('failed to initialize');
    },
    TEST_TIMEOUT_MS,
  );
});
