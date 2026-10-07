// `x auth seal-mfa`, driven through the command with a store handed in: what it reports, that a
// second run changes nothing, and that a missing master key writes no row. The statements against
// a real server are `cmd-auth.live.test.ts`'s.

import { describe, expect, test } from 'bun:test';
// why: Bun has no mkdtemp, and Bun.write is async in this synchronous fixture helper.
import { mkdtempSync, writeFileSync } from 'node:fs';
// why: Bun exposes no tmpdir(), so only node:os answers the platform temp root.
import { tmpdir } from 'node:os';
// why: Bun exposes no path-join primitive; Bun.file and import() take one already joined.
import { join } from 'node:path';
import { type MemoryAuthAdapter, memoryAuthAdapter } from '@ultimat3/auth';
import { isSealed, isUltimateError, SECRETS_KEY_ENV } from '@ultimat3/core';
import { REQUIRED_BUN } from './app-root';
import { authCommandOver } from './cmd-auth';
import { authSpec } from './cmd-auth-spec';
import type { CommandContext } from './command';

const KEY = { [SECRETS_KEY_ENV]: Bun.env[SECRETS_KEY_ENV] };

const appRoot = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'x-auth-'));
  writeFileSync(join(dir, 'app.config.ts'), "export const config = { name: 'fixture' };\n");
  return dir;
};

const contextIn = (cwd: string, env: CommandContext['env']): CommandContext => ({
  args: {
    command: 'auth',
    subcommand: 'seal-mfa',
    positionals: [],
    flags: new Map(),
    json: true,
    help: false,
    passthrough: [],
  },
  cwd,
  runner: () =>
    Promise.resolve({
      command: ['true'],
      code: 0,
      ok: true,
      stdout: '',
      stderr: '',
      durationMs: 0,
    }),
  env,
  bunVersion: REQUIRED_BUN,
});

const seeded = async (): Promise<MemoryAuthAdapter> => {
  const adapter = memoryAuthAdapter();
  for (const [id, secret] of [
    ['u1', 'JBSWY3DPEHPK3PXP'],
    ['u2', 'GEZDGNBVGY3TQOJQ'],
    ['u3', null],
  ] as const) {
    await adapter.createUser({
      id,
      email: `${id}@corp.test`,
      passwordHash: null,
      orgId: null,
      roles: [],
      createdAt: new Date(0),
    });
    if (secret !== null) await adapter.updateUser(id, { mfaSecret: secret });
  }
  return adapter;
};

const command = (adapter: MemoryAuthAdapter, closed: { count: number }) =>
  authCommandOver(async () => ({
    adapter,
    close: async () => {
      closed.count += 1;
    },
  }));

describe('unit · x auth seal-mfa', () => {
  test('seals every plaintext secret, reports both counts, and releases the store', async () => {
    const adapter = await seeded();
    const closed = { count: 0 };
    const result = await command(adapter, closed).run(contextIn(appRoot(), KEY));

    expect(result.ok).toBe(true);
    expect(result.data).toEqual({ sealed: 2, alreadySealed: 0, skipped: 0 });
    expect(result.summary).toContain('2');
    const stored = await adapter.listUsersWithMfaSecret();
    expect(stored).toHaveLength(2);
    expect(stored.every((row) => isSealed(row.mfaSecret))).toBe(true);
    expect((await adapter.findUserById('u3'))?.mfaSecret).toBeNull();
    expect(closed.count).toBe(1);
  });

  test('a second run seals nothing and rewrites nothing', async () => {
    const adapter = await seeded();
    const closed = { count: 0 };
    await command(adapter, closed).run(contextIn(appRoot(), KEY));
    const first = await adapter.listUsersWithMfaSecret();
    const again = await command(adapter, closed).run(contextIn(appRoot(), KEY));
    expect(again.data).toEqual({ sealed: 0, alreadySealed: 2, skipped: 0 });
    expect(await adapter.listUsersWithMfaSecret()).toEqual(first);
  });

  test('no master key: X_SEAL_KEY_MISSING, no row written, the store still released', async () => {
    const adapter = await seeded();
    const before = await adapter.listUsersWithMfaSecret();
    const closed = { count: 0 };
    const thrown = await command(adapter, closed)
      .run(contextIn(appRoot(), {}))
      .catch((error: unknown) => error);
    expect(isUltimateError(thrown) ? thrown.code : 'ran').toBe('X_SEAL_KEY_MISSING');
    expect(await adapter.listUsersWithMfaSecret()).toEqual(before);
    expect(closed.count).toBe(1);
  });

  test('outside an app it is refused before any store is opened', async () => {
    const opened = { count: 0 };
    const outside = mkdtempSync(join(tmpdir(), 'x-auth-nowhere-'));
    const thrown = await authCommandOver(async () => {
      opened.count += 1;
      return { adapter: memoryAuthAdapter(), close: async () => undefined };
    })
      .run(contextIn(outside, KEY))
      .catch((error: unknown) => error);
    expect(isUltimateError(thrown) ? thrown.code : 'ran').toBe('X_NOT_IN_APP');
    expect(opened.count).toBe(0);
  });

  test('the bare command has no default: the one subcommand writes', () => {
    expect(authSpec.subcommands).toEqual(['seal-mfa']);
    expect(authSpec.defaultSubcommand).toBeUndefined();
  });
});
