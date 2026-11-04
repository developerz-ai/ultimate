// The gh `release-due` runs: through `run()`'s one boundary, on its own shorter deadline, and a
// refusal is answered rather than thrown. The deadline itself — a child that never exits, stdin —
// is proved in `run.test.ts`; this file is only the wrapper over it, so `run()` is injected: a
// real `gh` child took 30.5 s on the Windows runner (ci run 40168160875) to say nothing this file
// asserts, and a machine with no `gh` could not run it at all.

import { afterAll, describe, expect, mock, test } from 'bun:test';
import type { RunOptions, RunResult } from './run';
import * as runModule from './run';

const realRun = runModule.run;
const calls: { readonly command: readonly string[]; readonly options?: RunOptions }[] = [];
/** The answer the injected `run()` gives while a test drives it; `undefined` delegates. */
let answer: RunResult | undefined;

await mock.module('./run', () => ({
  ...runModule,
  run: (command: readonly string[], options?: RunOptions): Promise<RunResult> => {
    if (answer === undefined) return realRun(command, options);
    calls.push({ command, ...(options === undefined ? {} : { options }) });
    return Promise.resolve({ ...answer, command });
  },
}));

const { GH_TIMEOUT_MS, gh } = await import('./release-due-gh');

afterAll(() => {
  // `mock.restore()` does not undo `mock.module`, and a run may share this process with other
  // files: the wrapper stays, so it is made inert — with no answer set it only delegates.
  answer = undefined;
  calls.length = 0;
  mock.restore();
});

const result = (over: Partial<RunResult>): RunResult => ({
  command: [],
  code: 0,
  ok: true,
  output: '',
  durationMs: 1,
  timedOut: false,
  ...over,
});

describe('unit · release-due-gh · gh', () => {
  test('runs gh through run(), in cwd, on its own deadline, answering its output', async () => {
    calls.length = 0;
    answer = result({ output: 'gh version 2.63.0' });
    const out = await gh(['--version'], '/repo');
    answer = undefined;
    expect(calls).toEqual([
      { command: ['gh', '--version'], options: { cwd: '/repo', timeoutMs: GH_TIMEOUT_MS } },
    ]);
    expect(out).toMatchObject({ ok: true, code: 0, output: 'gh version 2.63.0' });
    expect(out.command).toEqual(['gh', '--version']);
  });

  test('a gh that is refused is reported, never thrown', async () => {
    answer = result({ ok: false, code: 1, output: 'unknown command "no-such-subcommand-780"' });
    const out = await gh(['no-such-subcommand-780'], '/repo');
    answer = undefined;
    expect(out).toMatchObject({ ok: false, code: 1, timedOut: false });
  });

  test('its deadline is shorter than the default one', () => {
    expect(GH_TIMEOUT_MS).toBeLessThan(runModule.DEFAULT_RUN_TIMEOUT_MS);
  });
});
