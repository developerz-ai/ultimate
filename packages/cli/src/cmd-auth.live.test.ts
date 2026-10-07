// `x auth seal-mfa` as shipped — the real opener, the real `PostgresAuthAdapter`, a real server: rows
// a previous release left in the clear are sealed in place, and a second run changes nothing.
//
// Skips unless `TEST_DATABASE_URL` is set — never `DATABASE_URL`: this file creates and drops a
// database of its own, because the boot applies the framework's DDL to whatever it opens.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
// why: Bun has no mkdtemp and no recursive remove.
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
// why: Bun exposes no tmpdir(), so only node:os answers the platform temp root.
import { tmpdir } from 'node:os';
// why: Bun exposes no path-join primitive; Bun.file and import() take one already joined.
import { join } from 'node:path';
import { isSealed, SECRETS_KEY_ENV } from '@ultimat3/core';
import { resetJobs, resetTasks } from '@ultimat3/jobs';
import { REQUIRED_BUN } from './app-root';
import { authCommand } from './cmd-auth';
import type { CommandContext } from './command';

const url = Bun.env['TEST_DATABASE_URL'];
const describeLive = url === undefined ? describe.skip : describe;
const BOOT_TIMEOUT_MS = 60_000;
const PROBE_DB = 'x_auth_seal_probe';

const probeUrl = (): string => {
  const parsed = new URL(url ?? '');
  parsed.pathname = `/${PROBE_DB}`;
  return parsed.href;
};

const on = async <R>(target: string, statement: string): Promise<readonly R[]> => {
  const sql = new Bun.SQL(target, { max: 1 });
  try {
    return (await sql.unsafe(statement, [])) as readonly R[];
  } finally {
    await sql.end();
  }
};

let root: string;

const context = (): CommandContext => ({
  args: {
    command: 'auth',
    subcommand: 'seal-mfa',
    positionals: [],
    flags: new Map(),
    json: true,
    help: false,
    passthrough: [],
  },
  cwd: root,
  runner: () =>
    Promise.resolve({
      command: ['true'],
      code: 0,
      ok: true,
      stdout: '',
      stderr: '',
      durationMs: 0,
    }),
  env: {
    ULTIMATE_ENV: 'development',
    DATABASE_URL: probeUrl(),
    [SECRETS_KEY_ENV]: Bun.env[SECRETS_KEY_ENV],
  },
  bunVersion: REQUIRED_BUN,
});

const secrets = async (): Promise<readonly string[]> =>
  (
    await on<{ readonly mfa_secret: string }>(
      probeUrl(),
      'select mfa_secret from x_users where mfa_secret is not null order by id',
    )
  ).map((row) => row.mfa_secret);

// At file scope, never inside `describeLive`: Bun runs no hook in a skipped block, so a reset
// parked there never fires when the suite is skipped (`bun run skip-if-cleanup`).
afterAll(() => {
  resetJobs();
  resetTasks();
});

describeLive('live · postgres · x auth seal-mfa', () => {
  beforeAll(async () => {
    root = mkdtempSync(join(tmpdir(), 'x-auth-live-'));
    writeFileSync(join(root, 'app.config.ts'), "export const config = { name: 'fixture' };\n");
    await on(url ?? '', `drop database if exists ${PROBE_DB} with (force)`);
    await on(url ?? '', `create database ${PROBE_DB}`);
  });

  afterAll(async () => {
    rmSync(root, { recursive: true, force: true });
    await on(url ?? '', `drop database if exists ${PROBE_DB} with (force)`);
  });

  test(
    'a fresh database has nothing to seal — the command creates the tables it reads',
    async () => {
      const result = await authCommand.run(context());
      expect(result.data).toEqual({ sealed: 0, alreadySealed: 0, skipped: 0 });
    },
    BOOT_TIMEOUT_MS,
  );

  test(
    'plaintext rows are sealed in place, and a second run is a no-op',
    async () => {
      for (const [id, secret] of [
        [1, "'JBSWY3DPEHPK3PXP'"],
        [2, "'GEZDGNBVGY3TQOJQ'"],
        [3, 'null'],
      ] as const) {
        await on(
          probeUrl(),
          `insert into x_users (id, email, mfa_secret) values ('00000000-0000-7000-8000-00000000060${id}', 'u${id}@corp.test', ${secret})`,
        );
      }

      const first = await authCommand.run(context());
      expect(first.ok).toBe(true);
      expect(first.data).toEqual({ sealed: 2, alreadySealed: 0, skipped: 0 });
      const sealed = await secrets();
      expect(sealed).toHaveLength(2);
      expect(sealed.every((value) => isSealed(value))).toBe(true);
      expect(sealed.join()).not.toContain('JBSWY3DPEHPK3PXP');

      const second = await authCommand.run(context());
      expect(second.data).toEqual({ sealed: 0, alreadySealed: 2, skipped: 0 });
      expect(await secrets()).toEqual(sealed);
    },
    BOOT_TIMEOUT_MS,
  );
});
