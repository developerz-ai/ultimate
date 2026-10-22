// The gh `release-due` runs: through `run()`'s one boundary, on its own shorter deadline, and a
// refusal is answered rather than thrown. The deadline itself — a child that never exits, stdin —
// is proved in `run.test.ts`; this file is only the wrapper over it.

import { describe, expect, test } from 'bun:test';
import { GH_TIMEOUT_MS, gh } from './release-due-gh';
import { DEFAULT_RUN_TIMEOUT_MS } from './run';

const cwd = import.meta.dir;

describe('unit · release-due-gh · gh', () => {
  test('runs gh through run(), answering its output and exit code', async () => {
    const out = await gh(['--version'], cwd);
    expect(out).toMatchObject({ ok: true, code: 0, timedOut: false });
    expect(out.command).toEqual(['gh', '--version']);
    // Its stdout is the binary's own banner, so a semver here is proof run() captured the child.
    expect(out.output).toMatch(/\d+\.\d+\.\d+/);
  });

  test('a gh that is refused is reported, never thrown', async () => {
    const out = await gh(['no-such-subcommand-780'], cwd);
    expect(out).toMatchObject({ ok: false, timedOut: false });
  });

  test('its deadline is shorter than the default one', () => {
    expect(GH_TIMEOUT_MS).toBeLessThan(DEFAULT_RUN_TIMEOUT_MS);
  });
});
