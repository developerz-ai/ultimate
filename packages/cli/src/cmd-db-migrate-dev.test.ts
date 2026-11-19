// `x db migrate` beside a live `x dev` on the embedded database, end to end: the pass is applied
// by the dev server that holds `.x/pgdata`, so the fix `x dev` itself prints (`x db gen … && x db
// migrate`) works without stopping it — and no second process opens the directory.

import { afterAll, describe, expect, test } from 'bun:test';
// why: Bun exposes no path-join primitive.
import { join } from 'node:path';
import { REQUIRED_BUN } from './app-root';
import { dbCommand } from './cmd-db';
import { BOOT_TIMEOUT_MS, bootDevFixture } from './cmd-dev-boot-fixture';
import type { CommandContext } from './command';
import { clearLock, lockPath } from './dev-lock';
import { exec } from './exec';
import { parseArgs } from './parse';
import { SPECS } from './registry';

const dev = bootDevFixture('.dev-migrate-fixture');

afterAll(() => clearLock(join(dev.root, '.x')));

describe('unit · x db migrate beside a live embedded x dev', () => {
  test(
    'the running dev server applies the pass, and its own database holds the table',
    async () => {
      const { root, server } = dev;
      await Bun.write(
        join(root, 'packages/db/migrations/0001_gadgets.sql'),
        'create table gadgets (id uuid primary key, label text not null);\n',
      );
      // What `cmd-dev.ts` writes once the server reports its address; `startDev` alone does not.
      const port = Number(new URL(server.url).port);
      const lock = { pid: process.pid, port, url: server.url, startedAt: '' };
      await Bun.write(lockPath(server.services.stateDir), JSON.stringify(lock));
      const ctx: CommandContext = {
        args: parseArgs(['db', 'migrate'], SPECS),
        cwd: root,
        runner: exec,
        env: {},
        bunVersion: REQUIRED_BUN,
      };

      const result = await dbCommand.run(ctx);

      // The hand-written file carries no snapshot, and the holder's drift report says so: the
      // post-condition crosses the door with the apply, as `runMigrations` returns both.
      expect(result.findings?.map((finding) => finding.code)).toEqual(['X_DB_DRIFT']);
      expect(result.findings?.[0]?.cause).toContain('records no schema snapshot');
      expect((result.data as { applied: string[] }).applied).toEqual(['0001_gadgets']);
      const read = (await (await dev.runSql('select count(*)::int as n from gadgets')).json()) as {
        data: { result: { rows: unknown[][] } | null };
      };
      expect(read.data.result?.rows).toEqual([[0]]);
    },
    BOOT_TIMEOUT_MS,
  );

  test('a cross-site page cannot ask for the pass', async () => {
    const response = await dev.fetchDev('/_x/db/migrate', {
      method: 'POST',
      headers: { origin: 'https://evil.example', 'sec-fetch-site': 'cross-site' },
    });
    expect(response.status).toBe(403);
  });
});
