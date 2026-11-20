// Pins `--rehearse`: the bump a release PR makes, minus the changelog side, so a pull request can
// run the version-sensitive suites on a tree stamped at the next version (ci.yml `release-rehearsal`).

import { describe, expect, test } from 'bun:test';
import { jobOf, readWorkflow, text } from './lib/ci-workflow-read';
import { stampReaders } from './lib/stamp-readers';
import { releaseInvocation, unknownReleaseFlags } from './release';
import {
  REHEARSAL_PATHS,
  rehearsalDue,
  rehearsalSuites,
  rehearsalSuitesHere,
  stampReadersHere,
  unlessRehearsed,
} from './release-rehearse';

describe('unit · --rehearse is the bump without the changelog', () => {
  test('the flag is declared, and a refusal repeats it', () => {
    expect(unknownReleaseFlags(['bump', 'rehearse', 'json'])).toEqual([]);
    expect(
      releaseInvocation({
        explicit: undefined,
        bump: 'minor',
        dryRun: false,
        json: true,
        rehearse: true,
      }),
    ).toBe('bun run scripts/release.ts --bump minor --rehearse --json');
  });

  test('a rehearsal drops the changelog side: its refusals and its writes', () => {
    const side = [{ path: 'CHANGELOG.md' }, { path: 'wiki/Known-Gaps.md' }];
    expect(unlessRehearsed(true, side)).toEqual([]);
    expect(unlessRehearsed(false, side)).toEqual(side);
  });
});

describe('unit · which pull requests rehearse', () => {
  test('scripts, the CLI templates, codemods and upgrade, and any package.json', () => {
    for (const path of [
      'scripts/template-codemods-render.ts',
      'packages/cli/src/templates/scaffold-helm.ts',
      'packages/cli/src/codemods/index.ts',
      'packages/cli/src/upgrade-hop.ts',
      'packages/cli/src/cmd-upgrade.ts',
      'package.json',
      'packages/money/package.json',
      'examples/dummy/package.json',
    ]) {
      expect({ path, due: rehearsalDue([path]) }).toEqual({ path, due: true });
    }
  });

  test('prose and other source do not', () => {
    expect(rehearsalDue(['wiki/Home.md', 'packages/core/src/errors.ts', 'docs/x.md'])).toBe(false);
    expect(rehearsalDue([])).toBe(false);
    expect(REHEARSAL_PATHS.length).toBeGreaterThan(0);
  });
});

describe('unit · which suites a rehearsal runs', () => {
  // The 31.28.0 break, verbatim: two literal versions, no other mention of the stamp.
  const baked = "expect(renderScaffold('31.28.0')).toEqual(renderScaffold('31.29.0'));";

  test('a scripts test naming a version, or a semver literal, is version-sensitive', () => {
    const files = [
      { path: 'scripts/template-codemods-render.test.ts', text: baked },
      { path: 'scripts/release.test.ts', text: 'expect(nextVersion(x)).toBe(y)' },
      { path: 'scripts/guards-doc.test.ts', text: "expect(render(rows)).toContain('|')" },
    ];
    expect(rehearsalSuites(files, [])).toEqual([
      './scripts/release.test.ts',
      './scripts/template-codemods-render.test.ts',
    ]);
  });

  test("the CLI's template, codemod and upgrade test FILES, never a prefix bun would match nothing on", () => {
    const cli = [
      'packages/cli/src/upgrade-plan.test.ts',
      'packages/cli/src/cmd-upgrade.test.ts',
      'packages/cli/src/templates/scaffold-ci.test.ts',
      'packages/cli/src/codemods/engine-edits.test.ts',
      'packages/cli/src/cmd-db.test.ts',
    ].map((path) => ({ path, text: '' }));
    expect(rehearsalSuites([], cli)).toEqual([
      './packages/cli/src/cmd-upgrade.test.ts',
      './packages/cli/src/codemods/engine-edits.test.ts',
      './packages/cli/src/templates/scaffold-ci.test.ts',
      './packages/cli/src/upgrade-plan.test.ts',
    ]);
  });

  // The 31.49.0 break (#1284): `doctor-warnings.test.ts` sits under none of those paths, and
  // `cmd-doctor.ts`, which it imports, read `cliVersion()` — only the release PR ran it bumped.
  test('a CLI test importing a module that reads the stamp, wherever it lives', () => {
    const readers = stampReaders([
      { path: 'packages/cli/src/cmd-doctor.ts', text: 'pending(root, cliVersion());' },
      { path: 'packages/cli/src/registry.ts', text: 'export function cliVersion() {}' },
      { path: 'packages/cli/src/fixture.test.ts', text: 'loadVersion();' },
    ]);
    expect(readers).toEqual(['packages/cli/src/cmd-doctor.ts']);
    const cli = [
      {
        path: 'packages/cli/src/doctor-warnings.test.ts',
        text: "import { r } from './cmd-doctor';",
      },
      { path: 'packages/cli/src/doctor-pins.test.ts', text: "import { r } from './doctor-pins';" },
      { path: 'packages/cli/src/a/b.test.tsx', text: "import { r } from '../cmd-doctor.ts';" },
    ];
    expect(rehearsalSuites([], cli, readers)).toEqual([
      './packages/cli/src/a/b.test.tsx',
      './packages/cli/src/doctor-warnings.test.ts',
    ]);
  });

  test('a pull request changing a stamp reader, or a suite that imports one, rehearses', () => {
    const reached = [
      'packages/cli/src/cmd-doctor.ts',
      './packages/cli/src/doctor-warnings.test.ts',
    ];
    expect(rehearsalDue(['packages/cli/src/cmd-doctor.ts'], reached)).toBe(true);
    expect(rehearsalDue(['packages/cli/src/doctor-warnings.test.ts'], reached)).toBe(true);
    expect(rehearsalDue(['packages/cli/src/doctor-pins.ts'], reached)).toBe(false);
  });

  test('on this tree: every emitted path is a file, and the upgrade tests are among them', async () => {
    const suites = await rehearsalSuitesHere();
    for (const suite of suites) {
      expect({ suite, file: await Bun.file(suite).exists() }).toEqual({ suite, file: true });
    }
    expect(suites).toContain('./packages/cli/src/upgrade-plan.test.ts');
    expect(suites).toContain('./packages/cli/src/cmd-upgrade.test.ts');
    expect(suites).toContain('./scripts/release.test.ts');
    expect(await stampReadersHere()).toContain('packages/cli/src/cmd-doctor.ts');
    expect(suites).toContain('./packages/cli/src/doctor-warnings.test.ts');
  });
});

describe('unit · ci.yml · the release-rehearsal job', () => {
  test('a pull request only: bump, then the suites, each behind the due answer', async () => {
    const job = jobOf(await readWorkflow('ci.yml'), 'release-rehearsal');
    expect(job.if).toBe("github.event_name == 'pull_request'");
    const runs = (job.steps ?? []).map((step) => text(step.run));
    const due = runs.findIndex((run) => run.includes('scripts/release-rehearse.ts "$RUNNER_TEMP'));
    const bump = runs.findIndex(
      (run) => run.trim() === 'bun run scripts/release.ts --bump minor --rehearse',
    );
    const suites = runs.findIndex((run) => run.includes('release-rehearse.ts --suites --json'));
    expect(due).toBeGreaterThanOrEqual(0);
    expect(bump).toBeGreaterThan(due);
    expect(suites).toBeGreaterThan(bump);
    for (const step of (job.steps ?? []).slice(bump)) {
      expect(text(step.if)).toBe("steps.due.outputs.due == 'true'");
    }
  });
});
