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

/** The commands `bin/setup` owns, so this plan may not re-spell one. Pinned to the template. */
const SETUP_OWNS = ['db migrate', 'db seed', 'manifest'] as const;

/**
 * The planned steps among `wanted`, in plan order. Deliberately not `indexOf`: it answers -1 for a
 * step the plan does not hold, and -1 is below every real index — so a pairwise ordering assertion
 * passes for a plan missing the very step it claims to order (measured: dropping `db gen generated`
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

  /**
   * The duplication this file's own subject used to be. `bin/setup` — written by
   * `templates/scaffold-docs.ts` and now RUN by `scripts/scaffold-gate.ts` — migrates, seeds and
   * writes the manifest; this plan re-spelled the first and the third, so CI ran an approximation
   * of a script nobody executed. Derived from the template's bytes in both directions, so neither
   * a command leaving `bin/setup` nor a command coming back here is a silent change.
   */
  test('re-spells no command bin/setup already runs', async () => {
    const template = await Bun.file(
      `${repoRoot()}/packages/cli/src/templates/scaffold-docs.ts`,
    ).text();
    for (const command of SETUP_OWNS) {
      expect(template, `bin/setup no longer runs \`x ${command}\``).toContain(`bunx x ${command}`);
      const respelled = firstRunPlan().filter((step) => step.args.join(' ').startsWith(command));
      expect(
        respelled.map((step) => step.name),
        `${command} is bin/setup's line`,
      ).toEqual([]);
    }
  });

  // Eight of the thirteen generators emit an entity, and this is the only migration in CI written
  // from generator output rather than from the scaffold's own example entity. The apply is
  // `bin/setup`'s, on the `scaffold-gate` run that follows this sweep.
  test('regenerates after the generators, as the plan’s last step', () => {
    expect(stepsAmong(['g entity', 'db gen generated'])).toEqual(['g entity', 'db gen generated']);
    expect(firstRunPlan().at(-1)?.name).toBe('db gen generated');
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
