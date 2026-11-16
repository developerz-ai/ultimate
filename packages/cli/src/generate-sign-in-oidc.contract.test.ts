// What `x g sign-in --oidc` leaves on disk, held to the app's own first run — the OIDC shape with
// the authenticator swap, which the pure `generate()` fixture never sees. The password shape is
// `generate-sign-in.contract.test.ts`; split so test workers run the two side by side.

import { describe, expect, test } from 'bun:test';
import { firstRun, generated, removeGenerated } from './generate-contract-fixture';

const flags = ['--oidc', 'corp-sso'];

describe('contract · x g sign-in passes the app own first run', () => {
  test(`${flags.join(' ')}: compiles, lints and its generated tests pass`, async () => {
    const app = await generated(['sign-in', ...flags], 'x-sign-in-oidc-contract-');
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
