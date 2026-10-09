// How a `ci.yml` run supersedes another and what it leaves on its summary page — split from
// `ci-workflow-shape.test.ts` at its ceiling. Reads the REAL workflow: a rerun that cancels the
// branch's newest run, or a summary GitHub refuses to upload, is otherwise only seen on a red day.

import { describe, expect, setDefaultTimeout, test } from 'bun:test';
import { scriptCalls } from './lib/ci-parts';
import { REPO_SCAN_TIMEOUT_MS, repoRoot } from './lib/run';

setDefaultTimeout(REPO_SCAN_TIMEOUT_MS);

interface Step {
  readonly name?: string;
  readonly run?: string;
}

interface Workflow {
  readonly concurrency?: { readonly group?: string; readonly 'cancel-in-progress'?: unknown };
  readonly jobs?: Readonly<Record<string, { readonly steps?: readonly Step[] }>>;
}

const ci = Bun.YAML.parse(
  await Bun.file(`${repoRoot()}/.github/workflows/ci.yml`).text(),
) as Workflow;

/** `${{ body }}`, spelled so the source holds no `${` — a workflow expression is not a template. */
const expr = (body: string): string => ['$', '{{ ', body, ' }}'].join('');

const runsOf = (job: string): string =>
  (ci.jobs?.[job]?.steps ?? []).map((step) => step.run ?? '').join('\n');

describe('unit · ci.yml · which run supersedes which', () => {
  test('a push to main is keyed by SHA and never cancelled; a pull request supersedes itself', () => {
    expect(ci.concurrency?.group).toBe(
      `ci-${expr('github.workflow')}-${expr("github.event_name == 'pull_request' && github.ref || github.sha")}`,
    );
  });

  // `gh run rerun` of an older run joins the PR's group as its newest member: with an
  // unconditional cancel it cancelled the run of the commit at the head of the branch.
  test('only a first attempt cancels: a new push supersedes, a rerun never cancels anything', () => {
    expect(ci.concurrency?.['cancel-in-progress']).toBe(
      expr("github.event_name == 'pull_request' && github.run_attempt == 1"),
    );
  });
});

/** Every line of a job's steps that appends to the step summary, continuation lines joined. */
const summaryWrites = (job: string): readonly string[] =>
  runsOf(job)
    .replace(/\s*\\\n\s*/g, ' ')
    .split('\n')
    .filter((line) => line.includes('GITHUB_STEP_SUMMARY'));

describe('unit · ci.yml · the verdict`s summary page', () => {
  // A part's summary is bounded too: a red part's findings and output ran past the same limit.
  test('every write to a step summary is a title line or the bounded render, in both jobs', () => {
    for (const job of ['gate', 'verify']) {
      const writes = summaryWrites(job);
      expect(writes.length).toBe(2);
      expect(writes[0]).toMatch(/^\s*echo "### [^"]*" >> "\$GITHUB_STEP_SUMMARY"$/);
      expect(writes[1]).toMatch(
        /^\s*bun run scripts\/verify-summary\.ts "(?:[^"]+\.json|\$doc)" "[^"]*\{shown\}[^"]*\{total\}[^"]*" >> "\$GITHUB_STEP_SUMMARY" \|\| echo "[^"]*"$/,
      );
    }
    // The part's own document, named by attempt (spelled without a `${` the linter would read as
    // a template).
    expect(summaryWrites('gate')[1]).toContain('verify-summary.ts "$doc"');
    expect(runsOf('gate')).toContain(
      ['doc="$parts/$', '{PART}.attempt-$', '{GITHUB_RUN_ATTEMPT}.json"'].join(''),
    );
  });

  // GitHub refuses a step summary over 1024 KiB, and the whole human verdict of a red run is
  // larger: the summary was lost on exactly the runs that needed one.
  test('verify writes the bounded summary of its merge, never the whole verdict', () => {
    const run = runsOf('verify');
    const summaryLines = run.split('\n').filter((line) => line.includes('GITHUB_STEP_SUMMARY'));
    expect(summaryLines.join('\n')).not.toContain('verdict.txt');
    expect(run).toContain(['merge "$', '{docs[@]}" --json > "$RUNNER_TEMP/verdict.json"'].join(''));
    expect(scriptCalls(run, 'scripts/verify-summary.ts')).toEqual([{ flags: [] }]);
    expect(run).toMatch(
      /scripts\/verify-summary\.ts "\$RUNNER_TEMP\/verdict\.json" \\\n\s+"[^"]*\{shown\}[^"]*\{total\}[^"]*"/,
    );
    expect(run).toMatch(/>> "\$GITHUB_STEP_SUMMARY" \|\| echo /);
    expect(run.trimEnd().split('\n').at(-1)?.trim()).toBe('exit "$status"');
  });
});
