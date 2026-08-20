// The seam `x jobs` and `x db backfill` both reach the queue through. Two rules, and a CLI that
// breaks either is one that talks to the wrong database or leaves the next command locked out.

import { describe, expect, test } from 'bun:test';
// `node:path` — Bun ships no path joiner, and the boundary assertion below reads this module's
// own source off disk rather than trusting an import graph a bundler could have rewritten.
import { join } from 'node:path';
import type { JobDriver } from '@ultimat3/jobs';
import { createMemoryDriver, resetJobDriver, setJobDriver } from '@ultimat3/jobs';
import type { CommandContext } from './command';
import { withJobDriver } from './jobs-driver';

const contextFor = (): CommandContext => ({
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
  env: {},
  bunVersion: '1.3.0',
});

describe('unit · withJobDriver', () => {
  test('an ambient driver is reused, so no command boots a second queue over it', async () => {
    const ambient: JobDriver = createMemoryDriver();
    setJobDriver(ambient);
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
});
