// What `x g invite` leaves on disk, held to the app's own first run: a fresh `x new` scaffold, the
// generator run through the CLI, then the whole tree compiled by the real `tsc`, the auth slice
// checked by the app's own Biome and its generated tests run under the app's own preload — the
// grant, the API listing and the exercise entries included, which the pure fixture never sees.

import { describe, expect, test } from 'bun:test';
import { firstRun, generated, removeGenerated } from './generate-contract-fixture';
import type { GeneratedFile } from './templates';

const text = (files: readonly GeneratedFile[], path: string): string =>
  new TextDecoder().decode(
    (files.find((file) => file.path === path)?.contents as Uint8Array | undefined) ??
      new Uint8Array(),
  );

describe('contract · x g invite passes the app own first run', () => {
  test('compiles, lints, grants its permission and its generated tests pass', async () => {
    const app = await generated(['invite'], 'x-invite-contract-');
    try {
      expect({ code: app.code, out: app.out }).toMatchObject({ code: 0 });
      // The follow-ups: the permission reaches a role, every action is turned off in the pass.
      expect(text(app.files, 'apps/web/shared/roles.ts')).toContain("'member:invite'");
      // The invite mails: the root manifest declares it (`x new` writes it; an older app gains it).
      expect(text(app.files, 'package.json')).toContain('"@ultimat3/mail"');
      const exercise = text(app.files, 'apps/web/exercise.ts');
      for (const action of ['inviteMember', 'acceptInvite', 'revokeInvite']) {
        expect(exercise).toContain(`${action}: { off:`);
      }

      const run = await firstRun(app, ['apps/web/app/auth']);
      expect(run.diagnostics).toBe('');
      expect(run.lint).not.toContain('×');
      expect(run.tests.output).toMatch(/\b0 fail\b/);
      // Every generated test file ran: a filter that matched nothing would pass on zero.
      expect(run.tests.output).toMatch(/\b(1\d|[2-9]\d) pass\b/);
      expect(run.tests.code).toBe(0);
    } finally {
      await removeGenerated(app);
    }
  }, 240_000);
});
