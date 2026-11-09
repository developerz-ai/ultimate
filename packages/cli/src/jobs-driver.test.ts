// The seam `x jobs` and `x db backfill` both reach the queue through. Two rules, and a CLI that
// breaks either is one that talks to the wrong database or leaves the next command locked out.

import { afterAll, describe, expect, test } from 'bun:test';
// why: Bun has no mkdtemp and no recursive remove.
import { mkdtempSync, rmSync } from 'node:fs';
// why: `node:path` — Bun ships no path joiner, and the boundary assertion below reads this module's
// own source off disk rather than trusting an import graph a bundler could have rewritten.
import { join } from 'node:path';
import { ambientClock, installSecrets, isUltimateError } from '@ultimat3/core';
import type { JobDriver } from '@ultimat3/jobs';
import { memoryJobDriver } from '@ultimat3/jobs';
import { installJobDriver, resetJobDriver } from '@ultimat3/jobs/adapter';
import { REQUIRED_BUN } from './app-root';
import type { CommandContext } from './command';
import { withJobDriver } from './jobs-driver';

const contextFor = (env: CommandContext['env'] = {}): CommandContext => ({
  args: {
    command: 'jobs',
    // Present and `undefined`, not absent: `ParsedArgs.subcommand` is `string | undefined` and
    // REQUIRED, so every reader may index it — `x jobs` with no subcommand is this value.
    subcommand: undefined,
    positionals: [],
    flags: new Map(),
    json: false,
    help: false,
    passthrough: [],
  },
  cwd: '/nowhere',
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

describe('unit · withJobDriver', () => {
  test('an ambient driver is reused, so no command boots a second queue over it', async () => {
    const ambient: JobDriver = memoryJobDriver();
    installJobDriver(ambient);
    let seen: JobDriver | undefined;
    try {
      // `/nowhere` is not an app root: reaching `resolveServices` at all would throw here, which
      // is the point — inside `x dev` this command must never touch the boot path.
      const result = await withJobDriver('/nowhere', contextFor(), (driver) => {
        seen = driver;
        return Promise.resolve({ ok: true, command: 'jobs', summary: 'ok' });
      });
      expect(result.ok).toBe(true);
    } finally {
      resetJobDriver();
    }
    expect(seen).toBe(ambient);
  });

  test('a queue it booted itself is always released', async () => {
    const source = await Bun.file(join(import.meta.dir, 'jobs-driver.ts')).text();
    // Structural, because the alternative needs a real PGlite boot to observe: the moment the
    // release stops being a `finally`, a command that throws exits holding the data-directory
    // lock and the next `x` run against this app fails for a reason nobody can see from here.
    expect(source).toContain('finally');
    expect(source).toContain('await queue.stop()');
  });

  // A KMS-keyed app's `x jobs` must ask ITS secret source, on ITS clock: the boot ports are
  // `runtime.ts`'s on every path that reads it, not only `startServices`'.
  test('a booted queue honours runtime.ts: its secret source and clock, released after', async () => {
    const root = mkdtempSync(join(import.meta.dir, '..', '.boot-fixture-'));
    dirs.push(root);
    await Bun.write(
      join(root, 'apps/web/runtime.ts'),
      `import { frozenClock } from '@ultimat3/core';
export const runtime = {
  clock: frozenClock('2031-01-02T03:04:05Z'),
  secretSource: { name: 'fake-kms', masterKey: () => undefined },
};
`,
    );
    // Present, so `installSecrets()` must ask the installed source for a key — and name it.
    await Bun.write(join(root, 'secrets.enc.json'), '{}');
    let now = '';
    let refusal: unknown;
    await withJobDriver(root, contextFor({ ULTIMATE_ENV: 'development' }), async () => {
      now = ambientClock().now().toISOString();
      refusal = await installSecrets({ root, env: {} }).then(
        () => undefined,
        (error: unknown) => error,
      );
      return { ok: true, command: 'jobs', summary: 'ok' };
    });
    expect(now).toBe('2031-01-02T03:04:05.000Z');
    expect(isUltimateError(refusal) ? refusal.code : String(refusal)).toBe('X_SECRETS_KEY_MISSING');
    expect(isUltimateError(refusal) ? refusal.cause : '').toContain('fake-kms');
    expect(ambientClock().now().getUTCFullYear()).not.toBe(2031);
  }, 60_000);
});

const dirs: string[] = [];
afterAll(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
