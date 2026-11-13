// `x token`, driven through the command with an in-memory store handed in: what `create` stores
// and prints (the plaintext once per render, never in the summary), that `list` carries no secret,
// that `revoke` is idempotent, and that every refusal lands before a store is opened.

import { afterAll, describe, expect, test } from 'bun:test';
// why: Bun has no mkdtemp, and Bun.write is async in this synchronous fixture helper.
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
// why: Bun exposes no tmpdir(), so only node:os answers the platform temp root.
import { tmpdir } from 'node:os';
// why: Bun exposes no path-join primitive.
import { join } from 'node:path';
import { memoryAuthAdapter, verifyApiKey } from '@ultimat3/auth';
import { frozenClock } from '@ultimat3/core';
import { REQUIRED_BUN } from './app-root';
import { tokenCommandOver } from './cmd-token';
import type { CommandContext } from './command';
import { exec } from './exec';
import { renderHuman, renderJson } from './output';
import { parseArgs } from './parse';
import { SPECS } from './registry';

const madeDirs: string[] = [];
afterAll(() => {
  for (const dir of madeDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const appRoot = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'x-token-'));
  madeDirs.push(dir);
  writeFileSync(join(dir, 'app.config.ts'), "export const config = { name: 'fixture' };\n");
  return dir;
};

const ctxFor = (cwd: string, argv: readonly string[]): CommandContext => ({
  args: parseArgs(argv, SPECS),
  cwd,
  runner: exec,
  env: {},
  bunVersion: REQUIRED_BUN,
});

const clock = frozenClock('2031-01-02T03:04:05Z');

/** One store for the file's tests, and a count of how often the command opened it. */
const fixture = () => {
  const adapter = memoryAuthAdapter();
  const opened = { count: 0, closed: 0 };
  const command = tokenCommandOver(async () => {
    opened.count += 1;
    return {
      store: adapter,
      close: async () => {
        opened.closed += 1;
      },
    };
  }, clock);
  return { adapter, opened, command };
};

const occurrences = (text: string, needle: string): number => text.split(needle).length - 1;

describe('unit · x token create', () => {
  test('stores a key that verifies with exactly the named scopes, and closes the store', async () => {
    const { adapter, opened, command } = fixture();
    const result = await command.run(
      ctxFor(appRoot(), ['token', 'create', '--scopes', 'post:read,post:write', '--days', '30']),
    );
    expect(result.ok).toBe(true);
    const token = (result.data as { token: string }).token;
    const verified = await verifyApiKey(adapter, token, clock);
    expect([...verified.record.scopes]).toEqual(['post:read', 'post:write']);
    expect(verified.record.expiresAt?.toISOString()).toBe('2031-02-01T03:04:05.000Z');
    expect(opened).toEqual({ count: 1, closed: 1 });
  });

  test('prints the plaintext once in each render, and never in the summary', async () => {
    const { command } = fixture();
    const result = await command.run(ctxFor(appRoot(), ['token', 'create', '--scopes', 'a:b']));
    const token = (result.data as { token: string }).token;
    expect(token.startsWith('ult_dev_')).toBe(true);
    expect(result.summary).not.toContain(token);
    expect(occurrences(renderHuman(result), token)).toBe(1);
    expect(occurrences(renderJson(result), token)).toBe(1);
  });

  test('refuses no scopes, a wildcard, a bad env label and a bad --days before opening a store', async () => {
    const { opened, command } = fixture();
    const root = appRoot();
    await expect(command.run(ctxFor(root, ['token', 'create']))).rejects.toBeUltimateError(
      'X_CLI_BAD_FLAG',
    );
    await expect(
      command.run(ctxFor(root, ['token', 'create', '--scopes', 'post:*'])),
    ).rejects.toBeUltimateError('X_CONFIG_INVALID');
    await expect(
      command.run(ctxFor(root, ['token', 'create', '--scopes', 'a:b', '--env', 'live_eu'])),
    ).rejects.toBeUltimateError('X_CONFIG_INVALID');
    await expect(
      command.run(ctxFor(root, ['token', 'create', '--scopes', 'a:b', '--days', '0'])),
    ).rejects.toBeUltimateError('X_CLI_BAD_FLAG');
    expect(opened.count).toBe(0);
  });
});

describe('unit · x token list and revoke', () => {
  test('list answers the summaries of an owner, with no hash and no secret', async () => {
    const { command } = fixture();
    const root = appRoot();
    const created = await command.run(
      ctxFor(root, ['token', 'create', '--scopes', 'a:b', '--user', 'u1']),
    );
    const token = (created.data as { token: string }).token;
    const listed = await command.run(ctxFor(root, ['token', 'list', '--owner', 'u1']));
    const keys = (listed.data as { keys: { scopes: string[] }[] }).keys;
    expect(keys.map((key) => key.scopes)).toEqual([['a:b']]);
    const rendered = `${renderHuman(listed)}\n${renderJson(listed)}`;
    expect(rendered).not.toContain(token.split('_').slice(3).join('_'));
    expect(rendered).not.toContain('keyHash');
  });

  test('list without --owner is refused with the flag that answers it', async () => {
    const { command } = fixture();
    await expect(command.run(ctxFor(appRoot(), ['token', 'list']))).rejects.toBeUltimateError(
      'X_CLI_BAD_FLAG',
    );
  });

  test('revoke ends the key, and a second revoke is the same success', async () => {
    const { adapter, command } = fixture();
    const root = appRoot();
    const created = await command.run(ctxFor(root, ['token', 'create', '--scopes', 'a:b']));
    const { token, key } = created.data as { token: string; key: { id: string } };
    const first = await command.run(ctxFor(root, ['token', 'revoke', key.id]));
    expect(first).toMatchObject({ ok: true, data: { revoked: true } });
    await expect(verifyApiKey(adapter, token, clock)).rejects.toBeUltimateError(
      'X_API_KEY_INVALID',
    );
    const again = await command.run(ctxFor(root, ['token', 'revoke', key.id]));
    expect(again).toMatchObject({ ok: true, data: { revoked: false } });
  });

  test('grant is planned: a key never widens, so the fix issues a wider one', async () => {
    const { command } = fixture();
    const failure = command.run(ctxFor(appRoot(), ['token', 'grant']));
    await expect(failure).rejects.toBeUltimateError('X_NOT_IMPLEMENTED');
  });
});
