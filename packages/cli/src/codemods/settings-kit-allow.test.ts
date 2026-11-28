import { describe, expect, test } from 'bun:test';
import { memoryCodemodApp } from './codemod';
import { codemod, KIT_ALLOW, SETTINGS_FILE } from './settings-kit-allow';

const settings = (allow: readonly string[]): string =>
  `${JSON.stringify({ permissions: { allow }, hooks: { PostToolUse: [] } }, null, 2)}\n`;

describe('unit · settings-kit-allow codemod', () => {
  test('appends the missing entries and keeps the rest of the file', async () => {
    const target = memoryCodemodApp({ [SETTINGS_FILE]: settings(['Bash(bun test:*)']) });
    const result = await codemod.run(target);
    expect(result).toEqual({ changed: [SETTINGS_FILE], skipped: [] });
    const written = JSON.parse(target.files[SETTINGS_FILE] ?? '') as {
      permissions: { allow: string[] };
      hooks: unknown;
    };
    expect(written.permissions.allow).toEqual(['Bash(bun test:*)', ...KIT_ALLOW]);
    expect(written.hooks).toEqual({ PostToolUse: [] });
  });

  test('is idempotent', async () => {
    const target = memoryCodemodApp({ [SETTINGS_FILE]: settings(['Bash(bunx x kit:*)']) });
    await codemod.run(target);
    expect(await codemod.run(target)).toEqual({ changed: [], skipped: [] });
  });

  test('an app with no settings file is left alone', async () => {
    expect(await codemod.run(memoryCodemodApp({}))).toEqual({ changed: [], skipped: [] });
  });

  test('a file that is not the expected shape is reported, not rewritten', async () => {
    const target = memoryCodemodApp({ [SETTINGS_FILE]: '{ "permissions": {} }\n' });
    const result = await codemod.run(target);
    expect(result.changed).toEqual([]);
    expect(result.skipped[0]?.path).toBe(SETTINGS_FILE);
    expect(target.files[SETTINGS_FILE]).toBe('{ "permissions": {} }\n');
  });
});
