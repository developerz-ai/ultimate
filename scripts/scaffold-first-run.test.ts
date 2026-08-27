import { describe, expect, setDefaultTimeout, test } from 'bun:test';
import { GENERATORS } from '@ultimat3/cli';
import type { RunResult } from './lib/run';
import { REPO_SCAN_TIMEOUT_MS, repoRoot } from './lib/run';
import type { FirstRunStep, Runner } from './scaffold-first-run';
import {
  appBin,
  firstRunFindings,
  firstRunLines,
  firstRunPlan,
  generatorName,
  runFirstRun,
  stepFinding,
  verdict,
} from './scaffold-first-run';

// Reads the real tree, so it runs on the repo-scan backstop rather than Bun's 5000ms
// default — see `REPO_SCAN_TIMEOUT_MS`. A backstop, not an assertion: nothing here is meant
// to take minutes, and a test that does has hung.
setDefaultTimeout(REPO_SCAN_TIMEOUT_MS);

const result = (over: Partial<RunResult> = {}): RunResult => ({
  command: ['x', 'g', 'route', 'smoke-route'],
  code: 0,
  ok: true,
  output: '',
  durationMs: 1,
  ...over,
});

const fakeRunner = (
  seen: string[][],
  fail: (command: readonly string[]) => boolean = () => false,
): Runner => {
  return async (command, _options) => {
    seen.push([...command]);
    return fail(command)
      ? result({ command, code: 1, ok: false, output: 'X_CLI_UNEXPECTED: nope' })
      : result({ command });
  };
};

/**
 * The planned steps among `wanted`, in plan order. Deliberately not `indexOf`: it answers -1 for a
 * step the plan does not hold, and -1 is below every real index — so a pairwise ordering assertion
 * passes for a plan missing the very step it claims to order (measured: dropping `db gen initial`
 * from `firstRunPlan` left `indexOf(…) < indexOf(…)` GREEN, on the test whose whole subject it is).
 * Compared with `toEqual`, presence, order and multiplicity are one assertion.
 */
const stepsAmong = (wanted: readonly string[]): readonly string[] =>
  firstRunPlan()
    .map((step) => step.name)
    .filter((name) => wanted.includes(name));

describe('firstRunPlan', () => {
  // The defect was four of THIRTEEN generators, so a sample would likely have missed it. This is
  // what makes a fourteenth generator covered the day it lands.
  test('invokes every generator the CLI registry declares, exactly once', () => {
    const invoked = firstRunPlan()
      .filter((step) => step.args[0] === 'g')
      .map((step) => step.args[1]);
    expect([...invoked].sort()).toEqual([...GENERATORS].sort());
  });

  // A scaffold ships NO migration as of #121 — `x db gen` is the one writer of
  // `packages/db/migrations`. So the first apply runs over an empty directory, and it runs first so
  // that a scaffold which became a second writer again is red here, alone, before anything else.
  test('applies over the empty migrations directory before generating one', () => {
    expect(firstRunPlan()[0]?.name).toBe('db migrate (empty)');
    expect(stepsAmong(['db migrate (empty)', 'db gen initial'])).toEqual([
      'db migrate (empty)',
      'db gen initial',
    ]);
  });

  /**
   * The ordering the `scaffold-smoke` job depends on: `x verify`'s `drift` step is red until
   * `x db gen "initial"` has run, so a plan that generated only AFTER the generators — or not at
   * all — would hand the job a red `drift` that no allowance covers. Measured both ways: a scaffold
   * with no db command at all is 15 of 17 with `drift` red; the same scaffold after this step is
   * 16 of 17 with only `budgets` red.
   */
  test('generates the initial migration, and applies it, before any generator runs', () => {
    expect(stepsAmong(['db gen initial', 'db migrate (initial)', 'g entity'])).toEqual([
      'db gen initial',
      'db migrate (initial)',
      'g entity',
    ]);
  });

  // Eight of the thirteen generators emit an entity, and this is the only migration in CI written
  // from generator output rather than from the scaffold's own example entity.
  test('regenerates and re-applies after the generators, in that order', () => {
    expect(stepsAmong(['g entity', 'db gen generated', 'db migrate (generated)'])).toEqual([
      'g entity',
      'db gen generated',
      'db migrate (generated)',
    ]);
  });

  /**
   * The one first-run command this script does NOT get to choose. `bin/setup` — written by
   * `templates/scaffold-docs.ts` — is what a scaffolded app documents as its first run, and if B1
   * respells it (`"init"`, or a `--name` flag) this plan would keep running a command the app no
   * longer documents and keep passing. Enforced against the template's own bytes instead.
   */
  test('runs the same `x db gen` line bin/setup runs, spelled the same way', async () => {
    const template = await Bun.file(
      `${repoRoot()}/packages/cli/src/templates/scaffold-docs.ts`,
    ).text();
    const documented = template.match(/x db gen "([^"]+)"/);
    expect(documented, 'templates/scaffold-docs.ts no longer runs `x db gen "<name>"`').not.toBe(
      null,
    );
    const planned = firstRunPlan().find((step) => step.name === 'db gen initial');
    expect(planned?.args).toEqual(['db', 'gen', documented?.[1] ?? '', '--json']);
  });

  test('every step is named distinctly, so a red run says which one', () => {
    const names = firstRunPlan().map((step) => step.name);
    expect(new Set(names).size).toBe(names.length);
  });

  test('every step passes --json, so its failure is machine-readable', () => {
    for (const step of firstRunPlan()) expect(step.args).toContain('--json');
  });
});

test('generatorName flattens the colon a kind may carry and a path segment may not', () => {
  expect(generatorName('admin:page')).toBe('smoke-admin-page');
  expect(generatorName('route')).toBe('smoke-route');
});

describe('runFirstRun', () => {
  test('runs the app’s own x, never the checkout’s', async () => {
    const seen: string[][] = [];
    await runFirstRun(
      '/tmp/demoapp',
      [{ name: 'db migrate', args: ['db', 'migrate'] }],
      fakeRunner(seen),
    );
    expect(seen).toEqual([['/tmp/demoapp/node_modules/.bin/x', 'db', 'migrate']]);
  });

  // Four broken generators must come back as four findings in one run, not four CI rounds.
  test('keeps going past a failure so every broken step is reported at once', async () => {
    const seen: string[][] = [];
    const steps: readonly FirstRunStep[] = [
      { name: 'g action', args: ['g', 'action', 'a'] },
      { name: 'g query', args: ['g', 'query', 'q'] },
      { name: 'g route', args: ['g', 'route', 'r'] },
    ];
    const outcomes = await runFirstRun(
      '/tmp/demoapp',
      steps,
      fakeRunner(seen, (command) => command[2] !== 'route'),
    );
    expect(seen).toHaveLength(3);
    const findings = firstRunFindings('/tmp/demoapp', outcomes);
    expect(findings).toHaveLength(2);
    expect(findings.map((finding) => finding.cause.split(' exited')[0])).toEqual([
      'g action',
      'g query',
    ]);
  });
});

describe('verdict', () => {
  // A red `x db migrate` printed `"applied 1 migration"` as the cause of its own failure, because
  // the migrator logs before it reports and the head of the output is the log.
  test('prefers the --json verdict on the last line over the logging above it', () => {
    expect(
      verdict('{"level":"info","msg":"applied"}\n{"ok":false,"findings":["X_DB_DRIFT"]}'),
    ).toBe('{"ok":false,"findings":["X_DB_DRIFT"]}');
  });

  test('falls back to the head when a step died before printing one', () => {
    expect(verdict('SyntaxError: boom\n  at line 3')).toBe('SyntaxError: boom\n  at line 3');
  });
});

describe('stepFinding', () => {
  const finding = stepFinding(
    '/tmp/demoapp',
    { name: 'g backfill', args: ['g', 'backfill', 'smoke-backfill', '--json'] },
    result({ code: 1, ok: false, output: 'Cannot find module ../entity' }),
  );

  test('names the step, its exit code and what it printed', () => {
    expect(finding.code).toBe('X_SCAFFOLD_FIRST_RUN_FAILED');
    expect(finding.cause).toContain('g backfill');
    expect(finding.cause).toContain('exited 1');
    expect(finding.cause).toContain('Cannot find module ../entity');
  });

  // A fix line is pasted verbatim: it has to be the one command that reproduces THIS step.
  test('the fix reproduces exactly that step, and nothing else', () => {
    expect(finding.fix).toBe(
      'cd /tmp/demoapp && /tmp/demoapp/node_modules/.bin/x g backfill smoke-backfill --json',
    );
  });

  test('truncates a runaway stack so the finding stays readable', () => {
    const long = stepFinding(
      '/tmp/demoapp',
      { name: 'g route', args: ['g', 'route', 'r'] },
      result({ code: 1, ok: false, output: 'x'.repeat(5000) }),
    );
    expect(long.cause.length).toBeLessThan(700);
  });
});

test('firstRunLines prints the whole output of a failing step and none of a passing one', () => {
  const lines = firstRunLines([
    { step: { name: 'db migrate', args: ['db', 'migrate'] }, result: result({ output: 'fine' }) },
    {
      step: { name: 'g query', args: ['g', 'query', 'q'] },
      result: result({ code: 1, ok: false, output: 'line one\nline two' }),
    },
  ]);
  expect(lines.filter((line) => line.includes('fine'))).toEqual([]);
  expect(lines).toContain('      | line one');
  expect(lines).toContain('      | line two');
});

test('appBin resolves the scaffolded app’s binary, not this repo’s', () => {
  expect(appBin('/tmp/demoapp')).toBe('/tmp/demoapp/node_modules/.bin/x');
});
