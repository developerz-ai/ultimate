// `x config show`: the resolved config (defaults merged by core's `defineConfig`), `--section`
// held to the record's own keys, and every credential the logger would hide hidden here too.

import { afterAll, describe, expect, test } from 'bun:test';
// why: Bun has no mkdtemp, and Bun.write is async in this synchronous fixture helper.
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
// why: Bun exposes no tmpdir(), so only node:os answers the platform temp root.
import { tmpdir } from 'node:os';
// why: Bun exposes no path-join primitive.
import { join } from 'node:path';
import { REDACTED, secret } from '@ultimat3/core';
import { REQUIRED_BUN } from './app-root';
import { configCommand } from './cmd-config';
import type { CommandContext } from './command';
import { redactConfigValue } from './config-redact';
import { exec } from './exec';
import { renderHuman, renderJson } from './output';
import { parseArgs } from './parse';
import { SPECS } from './registry';

const madeDirs: string[] = [];
afterAll(() => {
  for (const dir of madeDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const appRoot = (config: string): string => {
  const dir = mkdtempSync(join(tmpdir(), 'x-config-'));
  madeDirs.push(dir);
  writeFileSync(join(dir, 'app.config.ts'), config);
  return dir;
};

const ctxFor = (cwd: string, argv: readonly string[]): CommandContext => ({
  args: parseArgs(argv, SPECS),
  cwd,
  runner: exec,
  env: {},
  bunVersion: REQUIRED_BUN,
});

describe('unit · x config show', () => {
  test('answers the resolved config, defaults included', async () => {
    const root = appRoot("export const config = { name: 'fixture' };\n");
    const result = await configCommand.run(ctxFor(root, ['config']));
    expect(result.ok).toBe(true);
    const config = (result.data as { config: Record<string, unknown> }).config;
    expect(config['name']).toBe('fixture');
    // Never written by the fixture: present only because defineConfig merged the default.
    expect(config['cache']).toBeDefined();
    expect(config['roles']).toBeDefined();
  });

  test('--section answers one key, and refuses one the record does not own', async () => {
    const root = appRoot("export const config = { name: 'fixture' };\n");
    const one = await configCommand.run(ctxFor(root, ['config', 'show', '--section', 'name']));
    expect((one.data as { config: unknown }).config).toBe('fixture');
    for (const section of ['nope', 'constructor', '__proto__']) {
      await expect(
        configCommand.run(ctxFor(root, ['config', 'show', '--section', section])),
      ).rejects.toBeUltimateError('X_CLI_BAD_FLAG');
    }
  });
});

describe('unit · what config-redact.ts hides', () => {
  test('a credential-named key, a secret() value and a URL password, at any depth', () => {
    const shown = redactConfigValue({
      mail: { apiKey: 'sk-live-123', from: 'a@b.test' },
      sealed: secret('hunter2'),
      list: [{ clientSecret: 'cs' }],
      database: { url: 'postgres://app:pw0rd@db:5432/app' },
    });
    const text = JSON.stringify(shown);
    for (const leaked of ['sk-live-123', 'hunter2', 'pw0rd', '"cs"']) {
      expect([leaked, text.includes(leaked)]).toEqual([leaked, false]);
    }
    expect(shown).toMatchObject({
      mail: { apiKey: REDACTED, from: 'a@b.test' },
      sealed: REDACTED,
      list: [{ clientSecret: REDACTED }],
      database: { url: `postgres://app:${REDACTED}@db:5432/app` },
    });
  });

  test('through the command and both renders, a password in a URL never prints', async () => {
    // `site.origin` is a string the schema takes as written, so the userinfo reaches the record.
    const root = appRoot(
      "export const config = { name: 'fixture', site: { origin: 'https://ops:pw-should-not-print@example.test' } };\n",
    );
    const result = await configCommand.run(ctxFor(root, ['config']));
    const rendered = `${renderHuman(result)}${renderJson(result)}`;
    expect(rendered).toContain('https://ops:');
    expect(rendered).not.toContain('pw-should-not-print');
  });

  test('a key named __proto__ is a field of the copy, never its prototype', () => {
    const parsed = JSON.parse('{"__proto__":{"polluted":true}}') as unknown;
    const shown = redactConfigValue(parsed) as Record<string, unknown>;
    expect(Object.getPrototypeOf(shown)).toBe(Object.prototype);
    expect(Object.hasOwn(shown, '__proto__')).toBe(true);
  });
});
