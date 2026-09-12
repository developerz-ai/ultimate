// The workflow is the one file in the scaffold nobody can run locally to find out it is broken:
// a typo in it is a repository whose CI never ran, reported as a green PR page with no checks on
// it. So every claim it makes is asserted against the OTHER emitted files rather than against a
// literal typed twice — the Bun pin against `package.json`'s own `engines.bun`, the commands
// against the scripts `bin/` actually ships.

import { describe, expect, test } from 'bun:test';
import { YAML } from 'bun';
import { names } from '../naming';
import { docsFiles } from '../scaffold-docs';
import { repoFiles } from '../scaffold-repo';
import { CI_WORKFLOW_PATH, githubFiles } from './ci.yml';

const app = names('ledger-demo');

/** An emitted file's text. `contents` is a union because `x new` also writes a PNG. */
const emitted = (
  files: readonly { path: string; contents: string | Uint8Array }[],
  path: string,
) => {
  const found = files.find((file) => file.path === path);
  if (found === undefined) return expect.unreachable(`x new writes no ${path}`);
  return typeof found.contents === 'string'
    ? found.contents
    : expect.unreachable(`${path} is bytes, not text`);
};

const workflow = (): string => emitted(githubFiles(app), CI_WORKFLOW_PATH);

interface Workflow {
  readonly on?: Readonly<Record<string, unknown>>;
  readonly jobs?: Readonly<Record<string, { readonly steps?: readonly Step[] }>>;
}
interface Step {
  readonly uses?: string;
  readonly run?: string;
  readonly with?: Readonly<Record<string, unknown>>;
}

const parsed = (): Workflow => YAML.parse(workflow()) as Workflow;

const steps = (): readonly Step[] => parsed().jobs?.['check']?.steps ?? [];

describe('unit · the CI workflow x new writes', () => {
  // GitHub reads `.github/workflows/*.yml` and nothing else. A workflow one directory away is a
  // file with no reader and no error — the silent half of this whole feature.
  test('it lands where GitHub reads it, and x new is what writes it', () => {
    expect(CI_WORKFLOW_PATH).toBe('.github/workflows/ci.yml');
    expect(docsFiles(app).map((file) => file.path)).toContain(CI_WORKFLOW_PATH);
  });

  // Parsed, not matched: a workflow that is not YAML is accepted by every `toContain` in this file
  // and by no runner on GitHub.
  test('it is YAML, with one job whose steps are a list', () => {
    expect(Object.keys(parsed().jobs ?? {})).toEqual(['check']);
    expect(steps().length).toBeGreaterThan(0);
  });

  test('it triggers on push and on pull request, and on nothing else', () => {
    expect(Object.keys(parsed().on ?? {}).sort()).toEqual(['pull_request', 'push']);
  });

  // The contract this file exists for: the app's OWN scripts, in order, never a restatement of
  // their steps. A workflow that ran `bun install && x verify` would be green here and would be a
  // second gate free to drift from the one a human runs.
  test('it runs bin/setup and then bin/check, and restates neither', () => {
    expect(steps().flatMap((step) => (step.run === undefined ? [] : [step.run]))).toEqual([
      'bin/setup',
      'bin/check',
    ]);
  });

  // `x verify` is HALF of `bin/check`: without the build the `budgets` step has no
  // `.x/build-stats.json` to measure and reports X_BUDGET_UNMEASURED. A workflow that named the
  // half would be red on a commit with nothing wrong in it.
  test('the gate it runs is bin/check, never a bare x verify', () => {
    for (const run of steps().flatMap((step) => (step.run === undefined ? [] : [step.run])))
      expect(run.includes('x verify')).toBe(false);
  });

  // The defect the whole Bun-floor change exists for, in its CI shape: a runner older than the
  // floor installs fine and dies on the next line with X_BUN_VERSION. Read from the emitted
  // manifest rather than from the constant, so a `package.json` that drifts fails HERE.
  test('the Bun it installs is the floor the emitted package.json declares', () => {
    const manifest = JSON.parse(emitted(repoFiles(app, '1.0.0', true), 'package.json')) as {
      readonly engines?: { readonly bun?: string };
    };
    const declared = manifest.engines?.bun ?? '';
    expect(declared).toMatch(/^>=\d+\.\d+\.\d+$/);
    const pin = steps().find((step) => step.uses?.startsWith('oven-sh/setup-bun'))?.with?.[
      'bun-version'
    ];
    expect(pin).toBe(declared.replace('>=', ''));
  });

  // `latest` and a bare major are how a runtime change arrives unannounced in every run at once.
  test('the pin is an exact patch — never latest, never a range', () => {
    const pin = steps().find((step) => step.uses?.startsWith('oven-sh/setup-bun'))?.with?.[
      'bun-version'
    ];
    expect(String(pin)).toMatch(/^\d+\.\d+\.\d+$/);
  });

  // This step runs before any of the app's code does. A movable tag there is somebody else's write
  // access to every CI run of every app scaffolded by this framework.
  test('the third-party action is pinned by commit SHA, with its version in the comment', () => {
    const line = workflow()
      .split('\n')
      .find((text) => text.includes('oven-sh/setup-bun'));
    expect(line).toMatch(/oven-sh\/setup-bun@[0-9a-f]{40} # v\d+\.\d+\.\d+$/);
  });

  // A hung step holds a runner for GitHub's six-hour default with no signal at all.
  test('the job is bounded in time', () => {
    expect(workflow()).toContain('timeout-minutes:');
  });
});
