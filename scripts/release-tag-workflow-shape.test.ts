// The shape of `.github/workflows/release-tag.yml` that makes merging the release PR the release:
// it starts only on a green ci.yml push run on main, cuts an ANNOTATED tag before the Release, and
// hands the publish to release.yml by dispatch. Reads the REAL workflow — each assertion is one a
// quiet edit to it would otherwise break with nothing red.

import { describe, expect, setDefaultTimeout, test } from 'bun:test';
import { REPO_SCAN_TIMEOUT_MS, repoRoot } from './lib/run';

const RELEASE_TAG_WORKFLOW = '.github/workflows/release-tag.yml';

interface Step {
  readonly id?: string;
  readonly env?: Readonly<Record<string, unknown>>;
  readonly name?: string;
  readonly uses?: string;
  readonly run?: string;
  readonly if?: string;
  readonly with?: Readonly<Record<string, unknown>>;
}

interface Job {
  readonly if?: string;
  readonly needs?: string | readonly string[];
  readonly outputs?: Readonly<Record<string, unknown>>;
  readonly 'timeout-minutes'?: number;
  readonly permissions?: Readonly<Record<string, string>>;
  readonly steps?: readonly Step[];
}

interface Workflow {
  readonly on?: {
    readonly workflow_run?: {
      readonly workflows?: readonly string[];
      readonly types?: readonly string[];
      readonly branches?: readonly string[];
    };
  };
  readonly concurrency?: { readonly group?: string; readonly 'cancel-in-progress'?: boolean };
  readonly permissions?: Readonly<Record<string, string>>;
  readonly jobs?: Readonly<Record<string, Job>>;
}

setDefaultTimeout(REPO_SCAN_TIMEOUT_MS);

const text = await Bun.file(`${repoRoot()}/${RELEASE_TAG_WORKFLOW}`).text();
const workflow = Bun.YAML.parse(text) as Workflow;
const job = (name: string): Job => workflow.jobs?.[name] ?? {};
const stepsOf = (name: string): readonly Step[] => job(name).steps ?? [];
const runsOf = (name: string): string =>
  stepsOf(name)
    .map((step) => step.run ?? '')
    .join('\n');
const prepare = runsOf('prepare');
const cut = runsOf('cut');
/** Where in `shell` the first occurrence of `needle` is, -1 when absent. */
const at = (shell: string, needle: string): number => shell.indexOf(needle);

describe('unit · release-tag.yml starts only on a green push run of a release commit', () => {
  test('workflow_run of ci, completed, on main — and no other trigger', () => {
    expect(Object.keys(workflow.on ?? {})).toEqual(['workflow_run']);
    expect(workflow.on?.workflow_run?.workflows).toEqual(['ci']);
    expect(workflow.on?.workflow_run?.types).toEqual(['completed']);
    expect(workflow.on?.workflow_run?.branches).toEqual(['main']);
  });

  test('prepare requires success, a push, main, this repository and a release subject', () => {
    const guard = job('prepare').if ?? '';
    expect(guard).toContain("github.event.workflow_run.conclusion == 'success'");
    expect(guard).toContain("github.event.workflow_run.event == 'push'");
    expect(guard).toContain("github.event.workflow_run.head_branch == 'main'");
    expect(guard).toContain(
      'github.event.workflow_run.head_repository.full_name == github.repository',
    );
    expect(guard).toContain(
      "startsWith(github.event.workflow_run.head_commit.message, 'chore: release ')",
    );
  });

  // A later green commit — a Dependabot merge whose CI finished first — is not the release its
  // notes describe: the subject is held to the one rule deploy-proof-due.ts reads, before any read.
  test('the judged commit subject is checked against scripts/lib/release-subject.ts first', () => {
    const subject = stepsOf('prepare').find((step) => step.id === 'subject');
    expect(subject?.run).toContain("import('./scripts/lib/release-subject.ts')");
    expect(String(subject?.env?.['MESSAGE'])).toContain('workflow_run.head_commit.message');
    const release = stepsOf('prepare').find((step) => step.id === 'release');
    expect(release?.if).toBe("steps.subject.outputs.release == 'true'");
  });

  test('cut runs only after prepare decided to cut', () => {
    expect(job('cut').needs).toBe('prepare');
    expect(job('cut').if).toBe("needs.prepare.outputs.cut == 'true'");
  });

  test('prepare checks out the commit ci.yml judged, holding no credential', () => {
    const checkout = stepsOf('prepare').find((step) => step.uses?.startsWith('actions/checkout@'));
    expect(String(checkout?.with?.['ref'])).toMatch(
      /^\$\{\{ github\.event\.workflow_run\.head_sha \}\}$/,
    );
    expect(checkout?.with?.['persist-credentials']).toBe(false);
  });
});

describe('unit · release-tag.yml runs no repository code beside a write token', () => {
  test('exactly two jobs; read-only at the top and in prepare; cut writes contents, actions and issues', () => {
    expect(Object.keys(workflow.jobs ?? {})).toEqual(['prepare', 'cut']);
    expect(workflow.permissions).toEqual({ contents: 'read' });
    expect(job('prepare').permissions).toEqual({ contents: 'read' });
    expect(job('cut').permissions).toEqual({
      contents: 'write',
      actions: 'write',
      issues: 'write',
    });
    for (const name of ['prepare', 'cut']) expect(job(name)['timeout-minutes']).toBeGreaterThan(0);
  });

  test('cut uses no action — no checkout, no setup — and runs no bun', () => {
    expect(stepsOf('cut').length).toBeGreaterThan(0);
    expect(stepsOf('cut').filter((step) => step.uses !== undefined)).toEqual([]);
    // A recovery line it ECHOES may name a command for a human; nothing it runs is bun.
    const executed = cut
      .split('\n')
      .filter((line) => !/^\s*(?:echo|#)/.test(line))
      .join('\n');
    expect(executed).not.toMatch(/\bbun\b/);
  });

  test('one named queue, never cancelled', () => {
    expect(workflow.concurrency?.group).toBe('release-tag');
    expect(workflow.concurrency?.['cancel-in-progress']).toBe(false);
  });
});

describe('unit · release-tag.yml cuts the release the one way this repo cuts it', () => {
  test('prepare: an existing tag stops it; the stamp is checked and the notes read', () => {
    expect(at(prepare, 'git/ref/tags/v')).toBeGreaterThan(-1);
    expect(prepare).toContain('scripts/release.ts --check');
    expect(prepare).toContain('scripts/release-notes.ts --version');
    expect(String(job('prepare').outputs?.['notes'])).toContain('steps.notes.outputs.notes');
  });

  // `gh release create` on a missing tag makes a LIGHTWEIGHT one, which `--follow-tags` never
  // pushes and release-preflight refuses: a tag OBJECT first, then its ref, then the Release.
  test('cut: an annotated tag object, then its ref, then the Release with --verify-tag', () => {
    expect(cut).toContain('-f type=commit');
    expect(at(cut, 'git/tags"')).toBeGreaterThan(-1);
    expect(at(cut, 'git/tags"')).toBeLessThan(at(cut, 'git/refs"'));
    expect(at(cut, 'git/refs"')).toBeLessThan(at(cut, 'gh release create'));
    const creates = [...cut.matchAll(/gh release create[^\n]*/g)].map((match) => match[0]);
    expect(creates.length).toBeGreaterThan(0);
    for (const create of creates) expect(create).toContain('--verify-tag');
  });

  test('every tag command it prints is annotated', () => {
    for (const match of text.matchAll(/git tag\s+(\S+)/g)) expect(match[1]).toBe('-a');
  });

  // A Release made with GITHUB_TOKEN fires no `release: published`; a dispatch is the exception.
  test('release.yml is dispatched at the tag, after the Release', () => {
    expect(cut).toMatch(
      /gh workflow run release\.yml --ref "v\$\{VERSION\}" -f version="\$\{VERSION\}"/,
    );
    expect(at(cut, 'gh release create')).toBeLessThan(at(cut, 'gh workflow run release.yml'));
  });

  // The canonical close is the workflow's own step — by the job that did the tag, on the EXACT
  // title — not a PR body's `Fixes #<n>` (backstop). Tag → release → dispatch → close, so a
  // dispatch failure leaves the ask open for a human to retry. The step must filter `gh issue
  // list`'s result with `.title ==`, else `Release <v> (#N)` and `Release <other>` look like
  // twins and get closed by accident.
  test('cut closes the release-due ask on a successful tag, by exact title', () => {
    const close = stepsOf('cut').find((step) => {
      if (step.if !== "steps.tag.outputs.created == 'true'") return false;
      if (step.run === undefined) return false;
      const run = step.run;
      return /gh issue list/.test(run) && /\.title\s*==/.test(run) && /gh issue close/.test(run);
    });
    expect(close).toBeDefined();
    // The existing "no uses, no bun" assertions cover this step's shape too.
    expect(close?.uses).toBeUndefined();
    // Order: dispatch must precede close, so a dispatch failure leaves the ask open.
    expect(at(cut, 'gh workflow run release.yml')).toBeLessThan(at(cut, 'gh issue close'));
  });
});
