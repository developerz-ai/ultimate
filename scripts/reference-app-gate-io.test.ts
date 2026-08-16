// The subprocess seam: what the gate SPAWNS, what it reads back out of `x verify --json`, and how
// it renders that for a CI log. Kept apart from the ratchet rules because everything here is about
// a step table arriving intact — unusable output must read as "no table", never as "nothing failed".

import { describe, expect, test } from 'bun:test';
import type { ExecResult } from '@ultimat3/cli';
import type { GateStep } from './reference-app-gate';
import { parseSteps, redSteps, reproduce, runAppGate, stepLines } from './reference-app-gate';
import { appWith, pin, step } from './reference-app-gate.fixtures';

describe('parseSteps', () => {
  const payload = JSON.stringify({
    ok: false,
    steps: [
      { name: 'lint', ok: true, durationMs: 1, skipped: false, findings: [] },
      {
        name: 'drift',
        ok: false,
        durationMs: 2,
        skipped: false,
        findings: [{ code: 'X_DB_DRIFT', cause: 'c', fix: 'x db gen "m"', docs: 'd' }],
      },
    ],
  });

  test('reads the step table and keeps each finding’s three lines', () => {
    const steps = parseSteps(`${payload}\n`);
    expect(steps?.map((s) => s.name)).toEqual(['lint', 'drift']);
    expect(steps?.[1]?.findings[0]).toEqual({
      code: 'X_DB_DRIFT',
      cause: 'c',
      fix: 'x db gen "m"',
    });
    expect(redSteps(steps ?? [])).toEqual(['drift']);
  });

  test('a stray line before the payload does not make the gate unreadable', () => {
    expect(parseSteps(`warming up\n${payload}\n`)?.length).toBe(2);
  });

  test('unusable output is undefined rather than an empty pass', () => {
    expect(parseSteps('')).toBeUndefined();
    expect(parseSteps('{ not json')).toBeUndefined();
    expect(parseSteps('{"ok":true}')).toBeUndefined();
    expect(parseSteps('{"steps":[{"name":"lint"}]}')).toBeUndefined();
    // Valid JSON that is not an object at all — no line here even starts with `{`, so this never
    // reaches the `payload.steps` read, but the contract is "no usable table", not a thrown error.
    expect(parseSteps('null')).toBeUndefined();
    expect(parseSteps('[]')).toBeUndefined();
    expect(parseSteps('true')).toBeUndefined();
  });
});

describe('rendering and spawning', () => {
  test('the reproduce line climbs exactly as far as the app is deep', () => {
    expect(reproduce(appWith({}))).toBe(
      'cd examples/dummy && bun run ../../packages/cli/src/bin.ts verify',
    );
    expect(reproduce(appWith({}, 'a/b/c'))).toContain('../../../packages/cli/src/bin.ts');
  });

  test('the step table renders pinned steps and their findings', () => {
    const steps: GateStep[] = [
      {
        name: 'drift',
        ok: false,
        skipped: false,
        findings: [{ code: 'X_DB_DRIFT', cause: 'c', fix: 'f' }],
      },
      step('roadmap', true, true),
    ];
    const lines = stepLines(steps, pin).join('\n');
    expect(lines).toContain('✗ drift');
    expect(lines).toContain('pinned');
    expect(lines).toContain('X_DB_DRIFT');
    expect(lines).toContain('- roadmap');
  });

  test('runs each app’s gate in that app, through the repo’s own CLI entry point', async () => {
    const calls: { command: readonly string[]; cwd: string }[] = [];
    const fake = async (command: readonly string[], options: { cwd: string }) => {
      calls.push({ command, cwd: options.cwd });
      return {
        command,
        code: 1,
        ok: false,
        stdout: '{"steps":[{"name":"lint","ok":true,"skipped":false,"findings":[]}]}',
        stderr: '',
        durationMs: 0,
      } satisfies ExecResult;
    };
    const steps = await runAppGate('/repo', fake, 'dummy/social-media-clone');
    expect(steps?.map((s) => s.name)).toEqual(['lint']);
    expect(calls[0]?.cwd).toBe('/repo/dummy/social-media-clone');
    expect(calls[0]?.command).toEqual([
      'bun',
      'run',
      '/repo/packages/cli/src/bin.ts',
      'verify',
      '--json',
    ]);
  });
});
