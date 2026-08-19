// `ok` and `failed` are public API — `index.ts` re-exports both — and nothing inside this repo
// calls either, so an app building a command against them is the only caller they have. What they
// promise is that `ok` is the ONE thing they set and that `extra` may not overturn it: a result
// built by `failed()` that reports `ok: true` is a command whose exit code disagrees with its own
// summary line.

import { describe, expect, test } from 'bun:test';
import { failed, ok } from './command';
import { exitCodeFor } from './output';

describe('ok', () => {
  test('is a passing result carrying just the command and its summary', () => {
    expect(ok('verify', '17 steps passed')).toEqual({
      ok: true,
      command: 'verify',
      summary: '17 steps passed',
    });
    expect(exitCodeFor(ok('verify', '17 steps passed'))).toBe(0);
  });

  test('extra fields are merged, and every one of them survives', () => {
    const result = ok('routes', '2 routes', {
      lines: ['  /', '  /dashboard'],
      data: { routes: [] },
      findings: [],
    });
    expect(result.lines).toEqual(['  /', '  /dashboard']);
    expect(result.data).toEqual({ routes: [] });
    expect(result.ok).toBe(true);
  });
});

describe('failed', () => {
  test('is a failing result, and the exit code follows it', () => {
    expect(failed('verify', '1 of 17 steps failed')).toEqual({
      ok: false,
      command: 'verify',
      summary: '1 of 17 steps failed',
    });
    expect(exitCodeFor(failed('verify', '1 of 17 steps failed'))).toBe(1);
  });

  test('carries findings, which is the whole reason a command reports failure', () => {
    const result = failed('db', 'migration refused', {
      findings: [
        {
          code: 'X_DB_DRIFT',
          cause: 'schema differs from migrations',
          fix: 'x db gen "add publish_at"',
        },
      ],
    });
    expect(result.findings?.[0]?.code).toBe('X_DB_DRIFT');
    expect(result.ok).toBe(false);
  });

  // THE INVERTED PIN. `extra` used to be spread LAST, so a caller passing `ok` overturned the
  // verdict the helper is named for: `failed(...)` answered `ok: true` and `exitCodeFor` then
  // exited 0 on a result whose own summary says it failed. `ok` is now written after the spread in
  // both helpers, so the name of the function decides and nothing a caller passes can reach it.
  // This test was the line that said the previous behaviour was deliberate; it now says the
  // opposite, deliberately (a breaking change to a published signature's semantics).
  test('`ok` is written LAST, so a caller’s own `ok` cannot overturn the verdict', () => {
    const overturned = failed('verify', '1 of 17 steps failed', { ok: true });
    expect(overturned.ok).toBe(false);
    expect(exitCodeFor(overturned)).toBe(1);
    // The mirror, and it is the half that actually ships an incident: a command reporting success
    // while its findings say otherwise exits 0 in CI.
    const green = ok('verify', '17 steps passed', { ok: false });
    expect(green.ok).toBe(true);
    expect(exitCodeFor(green)).toBe(0);
  });

  test('every OTHER field in `extra` still wins — only `ok` is the helper’s to keep', () => {
    const result = failed('db', 'migration refused', {
      summary: 'migration refused: 2 statements',
      exitCode: 3,
      lines: ['  0001_init.sql'],
    });
    expect(result.summary).toBe('migration refused: 2 statements');
    expect(exitCodeFor(result)).toBe(3);
    expect(result.lines).toEqual(['  0001_init.sql']);
    expect(result.ok).toBe(false);
  });
});
