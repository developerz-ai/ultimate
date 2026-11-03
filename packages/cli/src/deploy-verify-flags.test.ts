// `x deploy verify`'s flags: every value the wait could not use is refused before a sample is taken.

import { afterAll, describe, expect, test } from 'bun:test';
// why: Bun has no mkdtemp or recursive remove; these fixtures are synchronous.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
// why: Bun exposes no tmpdir(), so only node:os answers the platform temp root.
import { tmpdir } from 'node:os';
// why: Bun exposes no path-join primitive.
import { join } from 'node:path';
import { isUltimateError } from '@ultimat3/core';
import { REQUIRED_BUN } from './app-root';
import { deployCommand } from './cmd-deploy';
import { deploySpec } from './cmd-deploy-spec';
import type { CommandContext } from './command';
import { readBuild, readDuration, readOptions } from './deploy-verify-flags';
import { parseArgs } from './parse';
import { SPECS } from './registry';

const madeDirs: string[] = [];
afterAll(() => {
  for (const dir of madeDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const contextFor = (argv: readonly string[]): CommandContext => ({
  args: parseArgs(['deploy', 'verify', ...argv], SPECS),
  cwd: '.',
  runner: () => expect.unreachable('reading a flag spawns nothing'),
  env: {},
  bunVersion: REQUIRED_BUN,
});

const rootWith = (manifest: unknown): string => {
  const dir = mkdtempSync(join(tmpdir(), 'x-deploy-verify-flags-'));
  madeDirs.push(dir);
  if (typeof manifest === 'string') writeFileSync(join(dir, 'x.manifest.json'), manifest);
  else if (manifest !== null) writeFileSync(join(dir, 'x.manifest.json'), JSON.stringify(manifest));
  return dir;
};

const refusalOf = async (run: () => unknown) => {
  try {
    await run();
  } catch (error) {
    if (isUltimateError(error)) return error;
    throw error;
  }
  return expect.unreachable('the value was accepted');
};

const ORIGIN = ['--url', 'https://app.example.com'];

describe('x deploy verify · flags', () => {
  test('the defaults the usage names', () => {
    expect(readOptions(contextFor(ORIGIN))).toEqual({
      origin: 'https://app.example.com',
      windowMs: 60_000,
      intervalMs: 5_000,
      timeoutMs: 600_000,
      idleOk: [],
    });
  });

  test('--idle-ok is a list', () => {
    const options = readOptions(contextFor([...ORIGIN, '--idle-ok', 'banks, mail']));
    expect(options.idleOk).toEqual(['banks', 'mail']);
  });

  test.each([
    ['no --url', []],
    ['a word', ['--url', 'production']],
    ['a scheme fetch cannot aim', ['--url', 'ftp://app.example.com']],
    ['a path: /readyz is at the origin', ['--url', 'https://app.example.com/app']],
    ['credentials', ['--url', 'https://user:pass@app.example.com']],
    ['a query', ['--url', 'https://app.example.com/?a=1']],
  ] as const)('--url: %s is refused', async (_why, argv) => {
    const error = await refusalOf(() => readOptions(contextFor(argv)));
    expect(error.code).toBe('X_CLI_BAD_FLAG');
    expect(error.cause).toContain('--url');
    // Never echoes a credential back to a CI log.
    expect(error.cause).not.toContain('pass@');
  });

  test.each([
    ['--window', ['--window', 'soon']],
    ['--interval', ['--interval', '0']],
    ['--timeout', ['--timeout', '0']],
    ['--window past --timeout', ['--window', '11m', '--timeout', '10m']],
  ] as const)('%s: a value the wait cannot use is refused', async (_why, argv) => {
    const error = await refusalOf(() => readOptions(contextFor([...ORIGIN, ...argv])));
    expect(error.code).toBe('X_CLI_BAD_FLAG');
  });

  test('--build wins, and the manifest answers without it', async () => {
    const root = rootWith({ buildId: 'from-manifest' });
    expect(await readBuild(contextFor(['--build', 'from-ci']), root)).toBe('from-ci');
    expect(await readBuild(contextFor([]), root)).toBe('from-manifest');
  });

  test.each([
    ['no x.manifest.json', null],
    ['a manifest with no buildId', { routes: {} }],
    ['a buildId that is not a string', { buildId: 7 }],
    ['an empty buildId', { buildId: '' }],
    ['a manifest that is not JSON', 'not json'],
  ] as const)('%s and no --build is refused, and the fix passes one', async (_why, manifest) => {
    const error = await refusalOf(() => readBuild(contextFor([]), rootWith(manifest)));
    expect(error.code).toBe('X_CLI_BAD_FLAG');
    expect(error.fix).toContain('--build');
  });

  test('readDuration reads the forms the usage names', () => {
    const flag = { flag: 'window', zero: true } as const;
    expect(readDuration('60s', flag)).toBe(60_000);
    expect(readDuration('10m', flag)).toBe(600_000);
    expect(readDuration('1h30m', flag)).toBe(5_400_000);
    expect(readDuration('250ms', flag)).toBe(250);
    expect(readDuration('0', flag)).toBe(0);
    expect(readDuration('0s', flag)).toBe(0);
  });

  test('readDuration reads what a job declaration reads: one duration grammar', () => {
    const flag = { flag: 'timeout', zero: false } as const;
    expect(readDuration('1d', flag)).toBe(86_400_000);
    expect(readDuration('PT2H', flag)).toBe(7_200_000);
  });

  test.each([
    ['a negative', '-5s', true],
    ['a bare number', '30', true],
    ['an unreadable manifest-like value', '1x', true],
    ['trailing junk', '5s!', true],
    ['zero where the flag needs a wait', '0s', false],
    ['bare zero where the flag needs a wait', '0', false],
  ] as const)('readDuration refuses %s as a flag error', async (_why, raw, zero) => {
    const error = await refusalOf(() => readDuration(raw, { flag: 'timeout', zero }));
    expect(error.code).toBe('X_CLI_BAD_FLAG');
    expect(error.cause).toContain('--timeout');
  });

  test('a subcommand-scoped flag is refused on the other one', () => {
    expect(() => parseArgs(['deploy', 'verify', '--image', 'a:b'], SPECS)).toThrow();
    expect(() => parseArgs(['deploy', '--url', 'https://a.example'], SPECS)).toThrow();
    expect(() => parseArgs(['deploy', '--window', '5s'], SPECS)).toThrow();
  });
});

/** An app root: `x deploy` requires one before it reads a flag. */
const appRoot = (): string => {
  const dir = rootWith({ buildId: 'b-new' });
  writeFileSync(join(dir, 'app.config.ts'), "export const config = { name: 'demo-app' };\n");
  return dir;
};

describe('x deploy still means the deploy', () => {
  test('`x deploy --image` resolves to the deploy, and runs its plan', async () => {
    const parsed = parseArgs(['deploy', '--image', 'repo/app:1', '--dry-run'], SPECS);
    expect(parsed.subcommand).toBe('up');
    const root = appRoot();
    mkdirSync(join(root, 'docker'));
    writeFileSync(join(root, 'docker', 'docker-compose.prod.yml'), 'services: {}\n');
    const result = await deployCommand.run({ ...contextFor([]), cwd: root, args: parsed });
    expect(result.ok).toBe(true);
    expect(result.data).toMatchObject({ image: 'repo/app:1', method: 'compose' });
  });

  test('the usage names no `up`: one spelling, and verify is the other form', () => {
    expect(deploySpec.usage).not.toMatch(/deploy up\b/);
    expect(deploySpec.usage).toContain('x deploy --image');
    expect(deploySpec.usage).toContain('x deploy verify --url');
  });

  test('`x deploy verify` reaches the verify command through the dispatch', async () => {
    const parsed = parseArgs(['deploy', 'verify'], SPECS);
    await expect(
      deployCommand.run({ ...contextFor([]), cwd: appRoot(), args: parsed }),
    ).rejects.toMatchObject({ code: 'X_CLI_BAD_FLAG' });
  });
});
