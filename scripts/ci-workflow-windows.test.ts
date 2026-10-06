// The `windows` job of `.github/workflows/ci.yml`: native Windows in PowerShell, from a checkout
// with git's default autocrlf, and REQUIRED — split from `ci-workflow-shape.test.ts` (the 500-line
// ceiling), reading the same workflow through `lib/ci-workflow-read.ts`.
import { describe, expect, setDefaultTimeout, test } from 'bun:test';
import { expr, type Job, jobOf, readWorkflow, type Step, text } from './lib/ci-workflow-read';
import { REPO_SCAN_TIMEOUT_MS, repoRoot } from './lib/run';

setDefaultTimeout(REPO_SCAN_TIMEOUT_MS);

const ci = await readWorkflow('ci.yml');
const job = (name: string): Job => jobOf(ci, name);

describe('unit · ci.yml · the windows job runs in PowerShell, from a default-autocrlf checkout', () => {
  // Plan 101 sweep 8 (W6): native Windows is a supported platform, and this job is the only thing
  // that says so. Every step runs in pwsh so a bash dependency coming back is a red step, not a
  // Git Bash that quietly ran it. Each unit path is `./`-prefixed: bare, `bun test` reads it as a
  // substring filter, and `packages/core` also selects `examples/dummy/packages/core`.
  const UNIT_SUBSET = [
    './packages/core',
    './packages/db/src/migrate.test.ts',
    './packages/db/src/migration-ledger.test.ts',
    './packages/policy',
    './packages/render',
    './scripts/lib',
    './packages/cli/src/app-load.test.ts',
    './packages/cli/src/drift.test.ts',
    './packages/cli/src/app-boundaries.test.ts',
    './packages/cli/src/path-segments.test.ts',
    './packages/cli/src/templates/scaffold-gitattributes.test.ts',
    './packages/testing/src/cdp-launch.test.ts',
  ];
  const windows = job('windows');
  const steps = windows.steps ?? [];
  const at = (needle: string): number => steps.findIndex((step) => text(step.run).includes(needle));
  const testArgs = steps.flatMap((step) =>
    [...text(step.run).matchAll(/^bun test --isolate (.+)$/gm)].flatMap((m) =>
      (m[1] ?? '').split(' '),
    ),
  );

  test('pwsh on every step, inside the 25-minute budget, with no needs', () => {
    expect(windows.defaults?.run?.shell).toBe('pwsh');
    expect(steps.filter((step) => step.shell !== undefined && step.shell !== 'pwsh')).toEqual([]);
    expect(windows['timeout-minutes']).toBeGreaterThan(0);
    expect(windows['timeout-minutes']).toBeLessThanOrEqual(25);
  });

  test('the checkout keeps the runner`s autocrlf, and every action is the composite or a SHA', () => {
    const checkout = steps.find((step) => text(step.uses).startsWith('actions/checkout@'));
    expect(Object.keys(checkout?.with ?? {})).toEqual(['persist-credentials']);
    expect(steps.filter((step) => /autocrlf|core\.eol/.test(text(step.run)))).toEqual([]);
    for (const step of steps.filter((s) => s.uses !== undefined)) {
      expect(
        step.uses === './.github/actions/setup' || /@[0-9a-f]{40}$/.test(text(step.uses)),
      ).toBe(true);
    }
  });

  test('the setup composite installs frozen, in pwsh on Windows and bash elsewhere', async () => {
    const composite = Bun.YAML.parse(
      await Bun.file(`${repoRoot()}/.github/actions/setup/action.yml`).text(),
    ) as { readonly runs?: { readonly steps?: readonly Step[] } };
    const runs = (composite.runs?.steps ?? []).filter((step) => step.run !== undefined);
    const onWindows = runs.filter((step) => text(step.if) !== "runner.os != 'Windows'");
    expect(onWindows.map((step) => step.shell)).toEqual(['pwsh']);
    expect(onWindows.map((step) => text(step.if))).toEqual(["runner.os == 'Windows'"]);
    expect([...new Set(runs.map((step) => text(step.run).trim()))]).toEqual([
      'bun install --frozen-lockfile',
    ]);
    expect(
      steps.some((step) => step.uses === './.github/actions/setup' && step.id === 'setup'),
    ).toBe(true);
  });

  test('lint, typecheck and every unit path report on their own, whatever ran red before them', () => {
    const own = expr("!cancelled() && steps.setup.outcome == 'success'");
    for (const needle of ['bun run lint', 'bun run typecheck', 'bun test --isolate']) {
      const matching = steps.filter((step) => text(step.run).includes(needle));
      expect({ [needle]: matching.length > 0 }).toEqual({ [needle]: true });
      for (const step of matching) expect(step.if).toBe(own);
    }
    expect(UNIT_SUBSET.filter((path) => !testArgs.includes(path))).toEqual([]);
    expect(testArgs.filter((path) => !path.startsWith('./'))).toEqual([]);
  });

  test('every unit path is a real file or directory', async () => {
    expect(testArgs.length).toBeGreaterThanOrEqual(UNIT_SUBSET.length);
    const missing: string[] = [];
    for (const path of testArgs) {
      // `stat` answers for a directory too, where `exists()` is false.
      const found = await Bun.file(`${repoRoot()}/${path.slice(2)}`)
        .stat()
        .catch(() => undefined);
      if (found === undefined) missing.push(path);
    }
    expect(missing).toEqual([]);
  });

  test('the scaffold smoke runs in order: new, overrides, setup, check, binary, /healthz', () => {
    const order = [
      'x -- new',
      'scripts/scaffold-smoke-overrides.ts',
      'bun run setup',
      'bun run check --json',
      'build --target binary',
      '/healthz',
    ].map(at);
    expect(order.every((index) => index >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
  });

  // B18: the binary answers /healthz on Windows, so the job is a verdict like every other one. A
  // `continue-on-error` — on the job or on a step — is a red the run's conclusion never hears, and
  // release.yml publishes on that conclusion.
  test('the job and every step in it are required: no continue-on-error anywhere', () => {
    expect(windows['continue-on-error']).toBeUndefined();
    expect(steps.filter((step) => step['continue-on-error'] !== undefined)).toEqual([]);
  });
});
