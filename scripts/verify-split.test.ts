// The tree-scoped scan and the run-scoped scans: two answers, two halves.
//
// The split itself is recorded in `scripts/verify.test.ts`'s header, with the CI failure that
// proved it: the `packages (1/2)` job asked the TREE a question only the RUN could answer, and
// the tree's answer moved with the process that asked. These are the assertions that pin the
// repair — each one goes red if its half is undone, and none of them can pass because the check
// simply did not run.
//
// They live here, beside the gate's other tests rather than inside them, because they are one
// responsibility: the boundary between what a TREE can answer and what only a RUN can.

import { describe, expect, test } from 'bun:test';
// why: Bun has no mkdtemp and no recursive remove.
import { mkdtemp, rm } from 'node:fs/promises';
// why: Bun exposes no tmpdir(), so only node:os answers the platform temp root.
import { tmpdir } from 'node:os';
// why: Bun exposes no path-join primitive; Bun.file and import() take one already joined.
import { join } from 'node:path';
import { REPO_SCAN_TIMEOUT_MS, repoRoot } from './lib/run';
import { todayUtc } from './lib/stability-findings';
import { breaksOnMain, privateNames, tierBoundaries } from './verify';

describe('unit · the tree-scoped scan and the run-scoped scans', () => {
  // The repair, pinned. `tierBoundaries` is the TREE's answer; `privateNames` and `breaksOnMain`
  // are the RUN's answers, and the rules were one function until the `packages (1/2)` job proved
  // the difference (this file's header). Each assertion goes red if its half is undone.

  /**
   * A push to main on Actions, secret UNSET — the `packages` job's environment. This is the
   * environment the failing run had (ci push run 41714452760, job `packages (1/2)`): the runner
   * sets all three, and the job is handed no secret because `.github/workflows/ci.yml` gives the
   * secret only to the part that runs `boundaries`.
   */
  const PACKAGES_JOB_PUSH = {
    GITHUB_ACTIONS: 'true',
    GITHUB_EVENT_NAME: 'push',
    GITHUB_REF: 'refs/heads/main',
  } as const;
  /**
   * The same push as the part that OWNS the secret, which is the only run the guard may demand it
   * of: `.github/workflows/ci.yml` sets `ULTIMATE_PRIVATE_NAMES_REQUIRED=1` on the `boundaries`
   * part on a push to `main` and nowhere else, and hands that part the secret itself.
   *
   * The flag is what makes an empty secret RED (`X_PRIVATE_NAMES_UNSET`) — the guard's own
   * contract, pinned by `scripts/private-names.test.ts`: a push to main WITHOUT the flag skips,
   * because a unit job on the same push runs this guard with no secret and must not be red for
   * it. So the environment that proves the rule is not weakened is this one, not
   * `PACKAGES_JOB_PUSH` — and the split is what keeps the two apart.
   */
  const CI_PUSH = {
    ...PACKAGES_JOB_PUSH,
    ULTIMATE_PRIVATE_NAMES_REQUIRED: '1',
  } as const;
  /**
   * The same push, with the branch named the way `targetBranch` reads it: `GITHUB_REF_NAME` on a
   * push, `GITHUB_BASE_REF` on a pull request. `CI_PUSH` alone names the branch as `GITHUB_REF`
   * (`refs/heads/main`), which the branch rule does NOT read — so an env that sets only that would
   * leave the no-break-on-main rule silent and the tree scan's answer unmoved, and the behavioural
   * check below would pass against the very defect it exists to catch.
   */
  const PUSH_TO_MAIN = {
    GITHUB_EVENT_NAME: 'push',
    GITHUB_REF_NAME: 'main',
  } as const;
  /** `scripts/verify.ts`'s own source — the wiring is structural, so the wiring is read. */
  const source = (): Promise<string> => Bun.file(join(repoRoot(), 'scripts', 'verify.ts')).text();

  /**
   * A tree with a `BREAKING —` entry under `[Unreleased]` and a v30.0.0 dated inside the window
   * that is still closed — the shape the no-break-on-main rule fires on. The date is TODAY's, so
   * the fixture cannot age into a window that has opened: the rule reads the clock, and a fixture
   * with a fixed date stops firing ninety days after it was written.
   *
   * It carries one source file because the corpus refuses a scope that read nothing
   * (`X_CORPUS_UNSCANNED`) — a guard over an empty tree would report a clean tree it never read.
   */
  const breakingTree = async (): Promise<string> => {
    const dir = await mkdtemp(join(tmpdir(), 'ultimate-verify-break-'));
    await Bun.write(join(dir, 'packages/core/src/ok.ts'), 'export const ok = 1;\n');
    await Bun.write(
      join(dir, 'CHANGELOG.md'),
      [
        '# Changelog',
        '',
        '## [Unreleased]',
        '',
        '### Changed',
        '',
        '- **BREAKING — (#1) a thing goes.** detail',
        '',
        `## 30.0.0 - ${todayUtc()}`,
        '',
        '### Highlights',
        '',
        '- one',
        '',
      ].join('\n'),
    );
    return dir;
  };

  test('the tree-scoped scan reads no environment at all', async () => {
    // STRUCTURAL, so it is a guard and not a snapshot: the tree's answer must not vary with the
    // process that asks — the only way to be sure is to read no environment at all.
    const text = await source();
    const start = text.indexOf('export const tierBoundaries');
    const runRule = text.indexOf('export const privateNames');
    expect(start).toBeGreaterThan(0);
    expect(runRule).toBeGreaterThan(start);
    // The BODY, not the prose around it: the doc comment above `privateNames` names
    // `process.env` on purpose, and a guard that counted prose would guard the prose.
    expect(text.slice(start, text.lastIndexOf('};', runRule) + 2)).not.toContain('process.env');
    // And the run-scoped rule DOES read one — so a refactor that empties it cannot pass by
    // making both halves env-free.
    const runBody = text.slice(runRule, text.indexOf('export const manifestFailureCause'));
    expect(runBody).toContain('process.env');
  });

  test('the tree-scoped scan reads no environment THROUGH a rule it calls', async () => {
    // The STRUCTURAL check above reads `tierBoundaries`'s own text, and a rule it CALLS can read
    // the environment without that text saying so — which is how the no-break-on-main rule reached
    // `Bun.env` through `stabilityFindings` (whose `options.env ?? Bun.env` fallback fired when
    // the caller passed none). So the tree half is asked with an EXPLICIT environment, and the
    // scan's answer must not move when the environment does.
    const text = await source();
    const start = text.indexOf('export const tierBoundaries');
    const body = text.slice(start, text.indexOf('export const privateNames'));
    // The call names its environment: an explicit `env`, never a bare call that falls back to the
    // process's own. A bare `stabilityFindings(root)` is what let the tree's answer vary.
    expect(body).toMatch(/stabilityFindings\(root, \{ env: \{\} \}\)/);
    expect(body).not.toMatch(/stabilityFindings\(root\)/);
  });

  test(
    'the tree-scoped scan answers the same way whatever the environment says',
    async () => {
      // BEHAVIOURAL, because the structural check above cannot see a transitive read: the same
      // scan under a push to `main` and under no environment at all must answer identically. A
      // tree scan whose answer varies by the process that asked is the defect this whole split
      // exists to prevent — the `packages (1/2)` job went red for exactly that, on a rule that had
      // nothing to do with the tree.
      //
      // It runs over the BREAKING fixture, not over this repo: the env-dependent rule only speaks
      // on a tree that has a break headed at a branch, and this repo's own tree has none (v30 has
      // not shipped, so the window cannot be read and the rule is silent whatever the environment
      // says). Over this tree the check would pass against the very defect it exists to catch.
      const dir = await breakingTree();
      try {
        // SEQUENTIAL, never concurrent: the environment is process-wide state, so two scans
        // mutating it at once would read each other's machine and prove nothing.
        const answers: string[][] = [];
        // THREE environments, and the first is the one that failed: the `packages` job's own
        // (ci push run 41714452760) — a push to `main` on Actions, with no secret and no
        // requirement, because that job is not the one that scans for names. The second is a
        // push that DOES name the branch, and the third is no environment at all.
        const environments: readonly Readonly<Record<string, string>>[] = [
          PACKAGES_JOB_PUSH,
          PUSH_TO_MAIN,
          {},
        ];
        for (const env of environments) {
          const previous = { ...process.env };
          try {
            for (const [key, value] of Object.entries(env)) {
              process.env[key] = value;
            }
            const findings = await tierBoundaries(dir);
            answers.push(findings.map((finding) => `${finding.code} at ${finding.at}`));
          } finally {
            for (const key of Object.keys(process.env)) {
              if (!(key in previous)) delete process.env[key];
            }
            Object.assign(process.env, previous);
          }
        }
        expect(answers[0]).toEqual(answers[1]);
        expect(answers[1]).toEqual(answers[2]);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    },
    REPO_SCAN_TIMEOUT_MS,
  );

  test('the no-break-on-main rule is not weakened: a break headed to main is still red', async () => {
    // The rule that moved to the RUN's half, still firing: a `BREAKING —` entry under
    // `[Unreleased]` headed at `main` while the window is closed is refused. Asked of the run that
    // knows the branch, exactly as the private-name guard is asked of the run that knows the
    // secret — so the rule is asked, not deleted.
    const dir = await breakingTree();
    try {
      const findings = await breaksOnMain(dir, {
        GITHUB_EVENT_NAME: 'push',
        GITHUB_REF_NAME: 'main',
      });
      expect(findings.map((finding) => finding.code)).toEqual(['X_BREAKING_ON_MAIN']);
      expect(findings[0]?.fix).toStartWith('git rebase --onto next main');
      // The same tree headed at `next` is fine — the rule asks WHERE the change is landing.
      expect(
        await breaksOnMain(dir, { GITHUB_EVENT_NAME: 'push', GITHUB_REF_NAME: 'next' }),
      ).toEqual([]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test('the tree-scoped scan never answers the no-break-on-main question', async () => {
    // The rule that MOVED: the tree's half asks the stability rule with an explicit empty
    // environment, so the tree scan can never report a break-on-main — that is the RUN's answer,
    // and it is asked of the run. This is the half a re-merge of the two would put back.
    //
    // Asked under the environment that makes the rule SPEAK (a push to `main`): under an empty
    // environment the rule is silent whoever asks it, so the check would pass against the very
    // defect it exists to catch.
    const dir = await breakingTree();
    const previous = { ...process.env };
    try {
      for (const [key, value] of Object.entries(PUSH_TO_MAIN)) process.env[key] = value;
      const findings = await tierBoundaries(dir);
      expect(findings.map((finding) => finding.code)).not.toContain('X_BREAKING_ON_MAIN');
    } finally {
      for (const key of Object.keys(process.env)) {
        if (!(key in previous)) delete process.env[key];
      }
      Object.assign(process.env, previous);
      await rm(dir, { recursive: true, force: true });
    }
  });

  test('the rule is not weakened: the run that owns the secret still gets red without it', async () => {
    // What CI proved: the guard answers the RUN question (the push to main that OWNS the secret).
    // The run that owns it is the one `.github/workflows/ci.yml` sets
    // `ULTIMATE_PRIVATE_NAMES_REQUIRED=1` for, so that is the environment asked here — and the
    // rule still fires, with the same code, the same cause and the same file.
    const findings = await privateNames(repoRoot(), CI_PUSH);
    expect(findings.map((finding) => finding.code)).toEqual(['X_PRIVATE_NAMES_UNSET']);
    // The finding names its cause and its file, so a reader is not left guessing.
    expect(findings[0]?.cause).toContain('ULTIMATE_PRIVATE_NAMES');
    expect(findings[0]?.at).toBe('.github/workflows/ci.yml');
  });

  test('the tree-scoped scan never answers the private-name question', async () => {
    // The half that MOVED: the tree's answer is about the tree, and the private-name guard is
    // about the RUN — so the tree scan must never carry it. This is the exact defect of ci push
    // run 41714452760: the `packages (1/2)` job asked the tree a question only the run could
    // answer, and the tree's answer moved with the process that asked.
    //
    // Asked under the environment that makes the rule SPEAK — the run that owns the secret, with
    // the requirement declared. Under the `packages` job's own environment the rule skips, so the
    // check would pass against the very defect it exists to catch.
    const dir = await breakingTree();
    const previous = { ...process.env };
    try {
      for (const [key, value] of Object.entries(CI_PUSH)) process.env[key] = value;
      const findings = await tierBoundaries(dir);
      expect(findings.map((finding) => finding.code)).not.toContain('X_PRIVATE_NAMES_UNSET');
    } finally {
      for (const key of Object.keys(process.env)) {
        if (!(key in previous)) delete process.env[key];
      }
      Object.assign(process.env, previous);
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("the gate's boundaries step still carries EVERY half: the tree and the two runs", async () => {
    // The WIRING, not the rule: a rule with a test and no place on a step is a rule
    // `bun run verify` never runs — and this is the half lost if the repair were made by
    // DELETING the guard instead of by asking it of the run that owns the secret. STRUCTURAL:
    // on a local run the guard SKIPS, so both answers are the same list either way.
    const text = await source();
    const step = text.slice(text.indexOf('export const HOST_CHECKS'));
    expect(step).toContain('boundaries:');
    expect(step).toContain('tierBoundaries(root)');
    expect(step).toContain('privateNames(root)');
    // And the no-break-on-main rule, which is the second RUN's answer, rides the same step.
    expect(step).toContain('breaksOnMain(root)');
  });
});
