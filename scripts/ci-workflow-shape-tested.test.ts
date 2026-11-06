// The shape that lets a push to main reuse the green pull-request run of the same tree (plan 101,
// 33-ops-ci): one `tested` job asks `x ci tested`, every job it may skip carries exactly one `if`
// on its answer, a release commit never asks, and the demo publish accepts a skipped app gate
// only beside a green `tested`. Split from `ci-workflow-shape.test.ts` at its ceiling.

import { describe, expect, setDefaultTimeout, test } from 'bun:test';
import { expr, type Job, jobOf, readWorkflow, text } from './lib/ci-workflow-read';
import { REPO_SCAN_TIMEOUT_MS, repoRoot } from './lib/run';

setDefaultTimeout(REPO_SCAN_TIMEOUT_MS);

const ci = await readWorkflow('ci.yml');
const job = (name: string): Job => jobOf(ci, name);
const needsOf = (target: Job): readonly string[] =>
  typeof target.needs === 'string' ? [target.needs] : [...(target.needs ?? [])];
const record = (value: unknown): Readonly<Record<string, unknown>> =>
  typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {};

/**
 * Every job a green PR run of the same tree already answered. `compose-deploy` and `macos` are in
 * it: both run on a pull request too, on the same bytes, and neither asks anything of `main`.
 */
const REUSED = [
  'gate',
  'reference-app-verify',
  'fault-drills',
  'scaffold-smoke',
  'container',
  'compose-deploy',
  'packages',
  'windows',
  'macos',
] as const;

/** Never reused: `deploy-proof` keeps its own due rule, and `tested` is the question itself. */
const OWN_RULE = ['tested', 'deploy-proof', 'verify'] as const;

const REUSE_IF = "needs.tested.outputs.tested != 'true'";

describe('unit · ci.yml · a push a green PR run already tested', () => {
  test('every job is either reused through tested, or named here with its own rule', () => {
    const named: readonly string[] = [...REUSED, ...OWN_RULE];
    expect(Object.keys(ci.jobs ?? {}).filter((name) => !named.includes(name))).toEqual([]);
    expect(named.filter((name) => ci.jobs?.[name] === undefined)).toEqual([]);
  });

  // The demo publish reads a skipped app gate as reused, and that is sound only while a skip has
  // ONE cause: `tested` said true. A red, timed-out or cancelled `tested` must widen the gate, so
  // the condition opens with `!cancelled()` — a bare `needs.…` expression carries an implicit
  // `success()`, and every job below a red `tested` was skipped, not run.
  test('each reused job needs tested alone, and its one if is the answer', () => {
    for (const name of REUSED) {
      expect({ [name]: needsOf(job(name)) }).toEqual({ [name]: ['tested'] });
      expect({ [name]: job(name).if }).toEqual({ [name]: expr(`!cancelled() && ${REUSE_IF}`) });
    }
  });

  test('verify still merges when a part is red, and is skipped only by tested', () => {
    expect([...needsOf(job('verify'))].sort()).toEqual(['gate', 'tested']);
    expect(job('verify').if).toBe(expr(`!cancelled() && ${REUSE_IF}`));
  });

  test('a red or cancelled tested job runs everything: the reuse condition is evaluated past it', () => {
    // GitHub's job status functions: `success()` is implied unless the `if` names one, and
    // `!cancelled()` is the one that admits a failed `needs` and refuses a cancelled workflow.
    for (const name of [...REUSED, 'verify'] as const) {
      const condition = text(job(name).if);
      expect({ [name]: condition.startsWith(expr('!cancelled() &&').slice(0, -3)) }).toEqual({
        [name]: true,
      });
      expect({ [name]: /\b(always|success|failure)\(\)/.test(condition) }).toEqual({
        [name]: false,
      });
    }
  });

  test('deploy-proof never inherits a PR run: no needs on tested, its own if unchanged', () => {
    expect(needsOf(job('deploy-proof'))).toEqual([]);
    expect(text(job('deploy-proof').if)).not.toContain('tested');
  });

  test('tested waits on nothing, and exposes the command`s answer as its output', () => {
    const tested = job('tested');
    expect(needsOf(tested)).toEqual([]);
    expect(tested.if).toBeUndefined();
    expect(record(record(tested)['outputs'])['tested']).toBe(expr('steps.tested.outputs.tested'));
    expect(tested.permissions).toEqual({
      contents: 'read',
      actions: 'read',
      'pull-requests': 'read',
    });
    const ask = (tested.steps ?? []).find((step) => step.id === 'tested');
    expect(text(ask?.run)).toContain('bun run x -- ci tested --repo "$GITHUB_REPOSITORY" --json');
    expect(text(ask?.run)).toContain('.data.tested');
    expect(ask?.env?.['GH_TOKEN']).toBe(expr('github.token'));
  });

  // Only a push asks, and never a release commit: release.yml reads ci.yml's whole run, so the
  // commit it publishes from must be a run of everything. A release commit is RELEASE_SUBJECT's,
  // read by the very command release-tag.yml's `subject` step runs — never a prefix of it.
  test('every step of tested is a push`s, and the ask is behind RELEASE_SUBJECT', async () => {
    const steps = job('tested').steps ?? [];
    expect(steps.length).toBeGreaterThan(0);
    for (const step of steps) expect(text(step.if)).toContain("github.event_name == 'push'");
    const subject = steps.find((step) => step.id === 'subject');
    const releaseTag = await readWorkflow('release-tag.yml');
    const theirs = (jobOf(releaseTag, 'prepare').steps ?? []).find((step) => step.id === 'subject');
    expect(text(subject?.run)).toContain('RELEASE_SUBJECT');
    expect(text(subject?.run).trim()).toBe(text(theirs?.run).trim());
    expect(subject?.env?.['MESSAGE']).toBe(expr('github.event.head_commit.message'));
    const ask = steps.find((step) => step.id === 'tested');
    expect(ask?.if).toBe("github.event_name == 'push' && steps.subject.outputs.release == 'false'");
    const subjectAt = steps.indexOf(subject ?? {});
    expect(subjectAt).toBeGreaterThanOrEqual(0);
    expect(subjectAt).toBeLessThan(steps.indexOf(ask ?? {}));
  });

  // The real command, run: a scoped `chore(deps): release` is a release, so it asks nothing.
  test.each([
    ['chore: release 30.0.0 (#980)', 'true'],
    ['chore(deps): release 30.0.1 (#981)', 'true'],
    ['release: 30.0.2', 'true'],
    ['chore: release notes wording (#982)', 'false'],
    ['feat: a change (#983)', 'false'],
  ])('the subject step reads %p as release=%s', async (message, release) => {
    const run = text((job('tested').steps ?? []).find((step) => step.id === 'subject')?.run);
    const script = /bun -e "((?:[^"\\]|\\.)*)"/.exec(run)?.[1];
    expect(script).toBeDefined();
    const child = Bun.spawn([process.execPath, '-e', script ?? ''], {
      cwd: repoRoot(),
      env: { ...Bun.env, MESSAGE: `${message}\n\nbody` },
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const [out, code] = await Promise.all([new Response(child.stdout).text(), child.exited]);
    expect([code, out.trim()]).toEqual([0, `release=${release}`]);
  });

  // A missing or rotated ULTIMATE_PRIVATE_NAMES is #970's red on a push to main; a reuse would
  // skip the part that says so. The ask gets a BOOLEAN, never the secret, and answers false.
  test('an empty private-names secret answers false before anything is asked', () => {
    const ask = (job('tested').steps ?? []).find((step) => step.id === 'tested');
    expect(ask?.env?.['PRIVATE_NAMES_SET']).toBe(expr("secrets.ULTIMATE_PRIVATE_NAMES != ''"));
    const run = text(ask?.run);
    const guard = run.indexOf('if [ "$PRIVATE_NAMES_SET" != true ]; then');
    expect(guard).toBeGreaterThanOrEqual(0);
    const branch = run.slice(guard, run.indexOf('fi', guard));
    expect(branch).toContain('echo "tested=false" >> "$GITHUB_OUTPUT"');
    expect(branch).toContain('exit 0');
    expect(guard).toBeLessThan(run.indexOf('x -- ci tested'));
    const secretSteps = (job('tested').steps ?? [])
      .filter((step) => JSON.stringify(step).includes('secrets.'))
      .map((step) => step.id);
    expect(secretSteps).toEqual(['tested']);
  });
});

describe('unit · deploy-social-demo.yml · a skipped app gate is accepted only beside tested', () => {
  test('the verdict step names tested as the one job whose success explains a skip', async () => {
    const deploy = await readWorkflow('deploy-social-demo.yml');
    const verdict = (jobOf(deploy, 'build').steps ?? []).find(
      (step) => step.env?.['CHECK'] !== undefined,
    );
    const by = text(verdict?.env?.['REUSED_BY']);
    expect(by).toBe('tested');
    expect(ci.jobs?.[by]).toBeDefined();
    const run = text(verdict?.run);
    // Skipped is read only through REUSED_BY's success; nothing else turns "no verdict" green.
    expect(run).toContain('"skipped"');
    expect(run).toContain('$REUSED_BY');
    expect(run.match(/skipped/g)?.length).toBe(run.match(/"skipped"/g)?.length);
  });
});

describe('unit · ci.yml · the private-names wiring #970 added survives the reuse', () => {
  // A reused push skips `gate`, so the REQUIRED flag runs on every push that is not reused — a
  // release commit always — and on no other step: the secret reaches the boundaries part alone.
  test('the secret and its REQUIRED flag ride the boundaries part`s step, required on a push to main', () => {
    const steps = (job('gate').steps ?? []).filter(
      (step) => step.env?.['ULTIMATE_PRIVATE_NAMES'] !== undefined,
    );
    expect(steps).toHaveLength(1);
    expect(steps[0]?.env?.['ULTIMATE_PRIVATE_NAMES']).toBe(
      expr("contains(matrix.only, 'boundaries') && secrets.ULTIMATE_PRIVATE_NAMES || ''"),
    );
    expect(steps[0]?.env?.['ULTIMATE_PRIVATE_NAMES_REQUIRED']).toBe(
      expr(
        "contains(matrix.only, 'boundaries') && github.event_name == 'push' && github.ref == 'refs/heads/main' && '1' || ''",
      ),
    );
    // The secret's VALUE reaches the boundaries part alone; `tested` reads only whether it is set.
    const elsewhere = Object.entries(ci.jobs ?? {}).filter(
      ([name, target]) =>
        JSON.stringify(name === 'gate' ? { ...target, steps: [] } : target)
          .replaceAll("secrets.ULTIMATE_PRIVATE_NAMES != ''", '')
          .match(/secrets\.ULTIMATE_PRIVATE_NAMES|ULTIMATE_PRIVATE_NAMES_REQUIRED/) !== null,
    );
    expect(elsewhere).toEqual([]);
  });
});
