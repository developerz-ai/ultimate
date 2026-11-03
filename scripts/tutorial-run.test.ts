// `tutorial-run.ts` over a fixture page and a scripted shell: what runs, what is held, where the
// run stops — then the committed tutorials, read as steps (running them is the workflow's job).

import { describe, expect, setDefaultTimeout, test } from 'bun:test';
import { REPO_SCAN_TIMEOUT_MS, repoRoot } from './lib/run';
import { tutorialSteps } from './lib/tutorial-steps';
import type { Execute, StepRun } from './tutorial-run';
import { divergence, fromCheckout, runTutorials, shellExecute, TUTORIALS } from './tutorial-run';

// Reads the real tree, so it runs on the repo-scan backstop — see `REPO_SCAN_TIMEOUT_MS`.
setDefaultTimeout(REPO_SCAN_TIMEOUT_MS);

const PAGE = {
  path: 'wiki/T.md',
  text: [
    '```bash',
    'cd app',
    '```',
    '',
    '<!-- no-run: serves until stopped -->',
    '```bash',
    'bunx x dev',
    '```',
    '',
    '```bash',
    'bunx x verify',
    '```',
    '',
    '```text',
    '  ✓ unit',
    '✓ 19 of 20 steps passed in …ms',
    '```',
    '',
    '```bash',
    'bunx x routes',
    '```',
  ].join('\n'),
};

/** A shell that answers each command from a table, and records what it was asked, where. */
const scripted = (answers: Readonly<Record<string, Partial<StepRun>>>) => {
  const asked: string[] = [];
  const execute: Execute = async (command, cwd) => {
    asked.push(`${cwd}$ ${command}`);
    return { code: 0, output: '', cwd, ...answers[command] };
  };
  return { asked, execute };
};

describe('runTutorials', () => {
  test('runs every unmarked fence in order, carrying the directory, and passes a matching run', async () => {
    const shell = scripted({
      'cd app': { cwd: '/s/app' },
      'bunx x verify': { output: '  ✓ unit\n✓ 19 of 20 steps passed in 6911ms' },
    });
    const outcome = await runTutorials([PAGE], shell.execute, '/s');
    expect(outcome.findings).toEqual([]);
    expect(shell.asked).toEqual(['/s$ cd app', '/s/app$ bunx x verify', '/s/app$ bunx x routes']);
    expect(outcome.skipped).toEqual(['wiki/T.md:6 (serves until stopped)']);
  });

  test('a summary the run did not print is X_DOC_TUTORIAL_DIVERGED, and the run stops there', async () => {
    const shell = scripted({ 'bunx x verify': { output: '✗ 1 of 20 steps failed in 9ms' } });
    const outcome = await runTutorials([PAGE], shell.execute, '/s');
    expect(outcome.findings.map((one) => `${one.code} ${one.at}`)).toEqual([
      'X_DOC_TUTORIAL_DIVERGED wiki/T.md:10',
    ]);
    expect(outcome.findings[0]?.cause).toContain('✗ 1 of 20 steps failed in 9ms');
    expect(outcome.findings[0]?.fix).toStartWith('bun run scripts/tutorial-run.ts --json');
    expect(shell.asked).toHaveLength(2);
  });

  test('a failing exit diverges unless the page shows the step failing', async () => {
    const step = tutorialSteps('wiki/T.md', '```bash\nx verify\n```\n```text\n✗ budgets\n```')[0];
    if (step === undefined) return expect.unreachable('the fixture has one bash fence');
    expect(divergence(step, { code: 1, output: '✗ budgets', cwd: '/' })).toBeUndefined();
    const plain = tutorialSteps('wiki/T.md', '```bash\nx routes\n```')[0];
    if (plain === undefined) return expect.unreachable('the fixture has one bash fence');
    expect(divergence(plain, { code: 2, output: 'boom', cwd: '/' })).toContain('exited 2');
  });

  test('no bash fence anywhere is a finding, never a green run over nothing', async () => {
    const outcome = await runTutorials(
      [{ path: 'wiki/T.md', text: '# none' }],
      scripted({}).execute,
      '/',
    );
    expect(outcome.findings.map((one) => one.code)).toEqual(['X_CORPUS_UNSCANNED']);
  });
});

describe('the scaffold comes from this checkout', () => {
  test('bunx create-ultimate is the local generator, then the overrides on the app it named', () => {
    const line = fromCheckout('cd $(mktemp -d)\nbunx create-ultimate myapp --no-example', '/repo');
    expect(line).toContain('bun "/repo/packages/create-ultimate/src/bin.ts" myapp --no-example');
    expect(line).toContain(
      'app="$PWD/myapp"; cd "/repo" && bun scripts/scaffold-smoke-overrides.ts "$app"',
    );
    expect(fromCheckout('bunx x verify', '/repo')).toBe('bunx x verify');
  });

  test('the real shell carries the directory a fence leaves, and reports a failing exit', async () => {
    const execute = shellExecute(repoRoot());
    const moved = await execute('cd scripts', repoRoot());
    expect(moved.code).toBe(0);
    expect(moved.cwd).toBe(`${repoRoot()}/scripts`);
    const failed = await execute('echo before\nfalse\necho after', repoRoot());
    expect(failed.code).toBe(1);
    expect(failed.output).toBe('before');
  });
});

describe('the committed tutorials', () => {
  test('are read as steps: each page has bash fences, and every no-run mark gives its reason', async () => {
    for (const path of TUTORIALS) {
      const steps = tutorialSteps(path, await Bun.file(`${repoRoot()}/${path}`).text());
      expect(steps.length).toBeGreaterThan(0);
      for (const step of steps)
        if (step.skip !== undefined) expect(step.skip.length).toBeGreaterThan(0);
    }
  });
});

describe('.github/workflows/tutorial-run.yml', () => {
  test('runs on a push to main touching a tutorial or a generator, never on a PR, never in ci', async () => {
    const text = await Bun.file(`${repoRoot()}/.github/workflows/tutorial-run.yml`).text();
    const doc = Bun.YAML.parse(text) as {
      readonly on: {
        readonly push?: {
          readonly branches?: readonly string[];
          readonly paths?: readonly string[];
        };
        readonly pull_request?: unknown;
      };
      readonly jobs: Readonly<
        Record<string, { readonly steps: readonly { readonly run?: string }[] }>
      >;
    };
    expect(doc.on.push?.branches).toEqual(['main']);
    expect(doc.on.pull_request).toBeUndefined();
    expect(doc.on.push?.paths).toEqual(
      expect.arrayContaining([
        'wiki/Tutorial-0[1-4]*',
        'packages/cli/src/templates/**',
        'packages/cli/src/cmd-generate*',
        'packages/cli/src/verify-*',
      ]),
    );
    const runs = Object.values(doc.jobs).flatMap((job) => job.steps.map((step) => step.run ?? ''));
    expect(runs).toContain('bun run scripts/tutorial-run.ts');
    const ci = await Bun.file(`${repoRoot()}/.github/workflows/ci.yml`).text();
    expect(ci).not.toContain('tutorial-run');
  });
});
