// What `x g sign-in --password` leaves on disk, held to the app's own first run: a fresh `x new`
// scaffold, the generator run through the CLI, then the whole tree compiled by the real `tsc`, the
// auth slice checked by the app's own Biome and its generated tests run under the app's own
// preload. The OIDC shape is `generate-sign-in-oidc.contract.test.ts`: a file each, run in parallel.
// slow: one shape, end to end — x new, x g, Biome, the generated tests and tsc on the scaffold; the generated tests' import cost is most of it, so no stub stands in.

import { describe, expect, test } from 'bun:test';
import { firstRun, generated, removeGenerated } from './generate-contract-fixture';

const flags = ['--password'];

describe('contract · x g sign-in passes the app own first run', () => {
  test(`${flags.join(' ')}: compiles, lints and its generated tests pass`, async () => {
    const app = await generated(['sign-in', ...flags], 'x-sign-in-contract-');
    try {
      expect({ code: app.code, out: app.out }).toMatchObject({ code: 0 });
      const run = await firstRun(app, ['apps/web/app/auth', 'apps/web/runtime']);
      expect(run.diagnostics).toBe('');
      expect(run.lint).not.toContain('×');
      expect(run.tests.output).toMatch(/\b0 fail\b/);
      // Every generated test file ran: a filter that matched nothing would pass on zero.
      expect(run.tests.output).toMatch(/\b(1\d|[2-9]\d) pass\b/);
      expect(run.tests.code).toBe(0);
    } finally {
      await removeGenerated(app);
    }
  }, 180_000);
});
