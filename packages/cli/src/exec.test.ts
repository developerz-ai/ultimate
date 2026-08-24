// The one subprocess boundary, from both ends: a program that runs, and a program that is not
// there. The second is the case `x deploy` hits on a machine without `docker`, and it reached the
// user as `Error: Executable not found in $PATH` — no code, no fix, from the boundary whose own
// header says the "command not found" failure mode is identical everywhere.

import { describe, expect, test } from 'bun:test';
import { exec } from './exec';

/** Thrown values are read as data: `expect(fn).toThrow(Class)` passes in Bun 1.4.0 on a RETURN. */
const thrownBy = async (run: () => Promise<unknown>): Promise<Record<string, unknown>> => {
  try {
    await run();
  } catch (error) {
    return error as unknown as Record<string, unknown>;
  }
  return {};
};

describe('unit · the CLI subprocess boundary', () => {
  test('a program that exists runs, and its output comes back', async () => {
    const result = await exec(['bun', '--version'], { cwd: import.meta.dir });
    expect(result.ok).toBe(true);
    expect(result.code).toBe(0);
    expect(result.stdout.trim().length).toBeGreaterThan(0);
  });

  test('a program that is not on PATH is a coded refusal naming the program', async () => {
    const thrown = await thrownBy(() =>
      exec(['definitely-not-a-real-binary-xyz', '--help'], { cwd: import.meta.dir }),
    );
    expect(thrown['code']).toBe('X_CLI_UNEXPECTED');
    expect(String(thrown['cause'])).toContain('definitely-not-a-real-binary-xyz');
    // The dead end this replaces: `dispatch.ts` rendered the bare Error as X_CLI_UNEXPECTED with
    // `fix: x doctor --json`, and `runDoctor` checks nothing about an absent binary.
    expect(String(thrown['fix'])).toContain('definitely-not-a-real-binary-xyz');
    expect(String(thrown['fix'])).not.toBe('x doctor --json');
  });

  // Axiom 4 inverted a second way: the program name was interpolated into the fix line twice,
  // unquoted, so a name holding a space pasted back as two arguments and `command -v` answered
  // about the first word. `quoteArg` is the CLI's one POSIX quoter and both references take it.
  test('a program name with a space still produces a runnable fix', async () => {
    const name = 'definitely not a real binary xyz';
    const thrown = await thrownBy(() => exec([name, '--help'], { cwd: import.meta.dir }));
    expect(thrown['code']).toBe('X_CLI_UNEXPECTED');
    expect(String(thrown['fix'])).toContain(`command -v '${name}'`);
    expect(String(thrown['fix'])).toContain(`install '${name}'`);
  });

  test('an empty command is a caller bug, coded like every other CLI failure', async () => {
    const thrown = await thrownBy(() => exec([], { cwd: import.meta.dir }));
    expect(thrown['code']).toBe('X_CLI_UNEXPECTED');
    expect(String(thrown['cause'])).toContain('empty command');
  });
});
