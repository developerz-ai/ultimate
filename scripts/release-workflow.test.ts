// The gate rule that keeps `.github/workflows/release.yml` naming every publishable workspace.
// Every case here is a FIXTURE, never an edit to the real workflow: the release runs from that
// file, and a test that rewrote it to prove a failure would race the gate it guards.

import { describe, expect, test } from 'bun:test';
// why: `node:` — Bun has no temporary-directory or path-join primitive of its own.
import { mkdtemp, rm } from 'node:fs/promises';
// why: Bun exposes no tmpdir(), so only node:os answers the platform temp root.
import { tmpdir } from 'node:os';
// why: Bun exposes no path-join primitive; Bun.file and import() take one already joined.
import { join } from 'node:path';
import { REPO_SCAN_TIMEOUT_MS, repoRoot, run } from './lib/run';
import { listWorkspaces, publishOrder } from './lib/workspaces';
import {
  checkPublishList,
  type PublishGap,
  type PublishListInput,
  type PublishTarget,
  publishCommands,
  publishGapFindingFor,
  publishListGaps,
  publishListMode,
  RELEASE_WORKFLOW,
  WORKSPACE_ENUMERATOR,
  workspaceFlags,
} from './release-workflow';

const pkg = (name: string, tier: number, isPrivate = false): PublishTarget => ({
  name: `@ultimat3/${name}`,
  tier,
  private: isPrivate,
});

/** Two tier-0 packages and one tier-1, published by one step, unless overridden. */
const tree = (over: Partial<PublishListInput> = {}): PublishListInput => ({
  workspaces: [pkg('core', 0), pkg('schema', 0), pkg('flags', 1)],
  workflow: [
    'jobs:',
    '  publish:',
    '    steps:',
    '      - name: publish tier 0',
    '        run: npm publish -w @ultimat3/core -w @ultimat3/schema',
    '',
    '      - name: publish tier 1',
    '        run: npm publish -w @ultimat3/flags',
    '',
  ].join('\n'),
  ...over,
});

const findings = (input: PublishListInput) => checkPublishList(input).map(publishGapFindingFor);

const without = (workflow: string, flag: string): string => workflow.replace(` -w ${flag}`, '');

describe('unit · a publishable workspace no publish step names', () => {
  test('is refused, and the fix is the exact flag to add and where', () => {
    const found = findings(tree({ workflow: without(tree().workflow, '@ultimat3/flags') }));

    expect(found).toHaveLength(1);
    expect(found[0]?.code).toBe('X_PUBLISH_LIST_INCOMPLETE');
    // The whole point: the package ships in the lockstep version and is on no registry.
    expect(found[0]?.cause).toContain('@ultimat3/flags');
    expect(found[0]?.cause).toContain('404');
    expect(found[0]?.fix).toContain('-w @ultimat3/flags');
    expect(found[0]?.fix).toContain('tier 1 publish step');
    // The durable fix, not just the one-line one: a list that must match a derived list is the
    // defect, and the flag alone re-breaks on the next package somebody adds.
    expect(found[0]?.fix).toContain(WORKSPACE_ENUMERATOR);
    expect(found[0]?.at).toBe(RELEASE_WORKFLOW);
  });

  test('passes once the flag is there', () => {
    expect(findings(tree())).toEqual([]);
  });

  test('a private workspace is not publishable, so its absence is not a gap', () => {
    expect(findings(tree({ workspaces: [...tree().workspaces, pkg('sandbox', 5, true)] }))).toEqual(
      [],
    );
  });
});

describe('unit · a `-w` the tree cannot publish', () => {
  test('is refused — npm exits non-zero after earlier steps already published', () => {
    const found = findings(
      tree({ workflow: tree().workflow.replace('@ultimat3/flags', '@ultimat3/flgs') }),
    );

    const unknown = found.filter((one) => one.code === 'X_PUBLISH_LIST_UNKNOWN');
    expect(unknown).toHaveLength(1);
    expect(unknown[0]?.cause).toContain('@ultimat3/flgs');
    expect(unknown[0]?.cause).toContain('no workspace under packages/');
    expect(unknown[0]?.fix).toContain('delete `-w @ultimat3/flgs`');
    // And the real package is now missing, so the typo is reported from both directions.
    expect(found.map((one) => one.code)).toContain('X_PUBLISH_LIST_INCOMPLETE');
  });

  test('a private workspace named by a publish step says so in its own words', () => {
    const found = findings(
      tree({ workspaces: [pkg('core', 0), pkg('schema', 0), pkg('flags', 1, true)] }),
    );

    expect(found).toHaveLength(1);
    expect(found[0]?.code).toBe('X_PUBLISH_LIST_UNKNOWN');
    expect(found[0]?.cause).toContain('private workspace');
  });
});

describe('unit · the rule cannot pass vacuously', () => {
  test('a workflow with no npm publish at all is a finding, not silence', () => {
    const found = findings(
      tree({ workflow: 'jobs:\n  publish:\n    steps:\n      - run: echo hi\n' }),
    );

    expect(found).toHaveLength(1);
    expect(found[0]?.code).toBe('X_PUBLISH_LIST_INCOMPLETE');
    expect(found[0]?.cause).toContain('no `npm publish` command');
  });

  test('a comment holding an example command publishes nothing', () => {
    const found = findings(
      tree({
        workflow: '      # npm publish -w @ultimat3/core -w @ultimat3/schema -w @ultimat3/flags\n',
      }),
    );
    expect(found[0]?.cause).toContain('no `npm publish` command');
  });
});

describe('unit · what the rule asserts when the list is not explicit', () => {
  /**
   * The shape this repo's workflow actually has `As of 2026-08`: a `run: |` script that reads the
   * package set from `scripts/list-workspaces.ts` and builds `-w` flags in a shell loop. The list
   * cannot go stale, so `missing` is answered by construction — and `-w $name` is a shell expansion,
   * not a package, which a checker that read it literally would report as an unknown workspace.
   */
  test('a step deriving its list from the repo enumeration is complete by construction', () => {
    const workflow = [
      '      - name: publish, tier by tier',
      '        run: |',
      '          plan="$(bun run scripts/list-workspaces.ts --json | jq -r .data)"',
      '          for name in $names; do args="$args -w $name"; done',
      '          npm publish $args',
    ].join('\n');

    expect(findings(tree({ workflow }))).toEqual([]);
    expect(workspaceFlags('for name in $names; do args="$args -w $name"; done')).toEqual([]);
    // Reported, because "every one named" and "the list is derived" are different guarantees.
    expect(publishListMode(workflow)).toBe('derived');
    expect(publishListMode(tree().workflow)).toBe('listed');
    expect(publishListMode('steps: []')).toBe('none');
  });

  test('a derived step that no longer reads the enumeration is not derived', () => {
    const workflow = [
      '      - name: publish, tier by tier',
      '        run: |',
      '          for name in core schema; do npm publish -w "@ultimat3/$name"; done',
    ].join('\n');
    // The list came from somewhere this repo does not define, so every package is unaccounted for.
    expect(findings(tree({ workflow })).map((one) => one.code)).toContain(
      'X_PUBLISH_LIST_INCOMPLETE',
    );
  });

  test('`--workspaces` satisfies completeness by construction, and `-w` is still checked', () => {
    const workflow = [
      '      - name: publish everything',
      '        run: npm publish --workspaces',
      '      - name: publish the shim',
      '        run: npm publish -w create-ultimate',
    ].join('\n');
    const found = findings(tree({ workflow }));

    // Nothing is `missing` — npm resolves the set from the root manifest, the same source
    // `listWorkspaces` reads — but a stale explicit flag is still a half-published release.
    expect(found).toHaveLength(1);
    expect(found[0]?.code).toBe('X_PUBLISH_LIST_UNKNOWN');
    expect(found[0]?.cause).toContain('create-ultimate');
  });
});

describe('unit · reading the workflow', () => {
  test('a folded `run: >` block is one command, flags on every continuation line', () => {
    const commands = publishCommands(
      [
        '      - name: publish tier 1',
        '        run: >',
        '          npm publish',
        '          -w @ultimat3/i18n -w @ultimat3/money',
        '          -w @ultimat3/time',
        '',
        '      - name: next',
        '        run: npm publish -w @ultimat3/entity',
      ].join('\n'),
    );

    expect(commands).toHaveLength(2);
    expect(workspaceFlags(commands[0] ?? '')).toEqual([
      '@ultimat3/i18n',
      '@ultimat3/money',
      '@ultimat3/time',
    ]);
    expect(workspaceFlags(commands[1] ?? '')).toEqual(['@ultimat3/entity']);
  });

  test('the other spellings npm accepts are the same flag', () => {
    expect(workspaceFlags('npm publish -w=a --workspace b --workspace=c')).toEqual(['a', 'b', 'c']);
  });
});

describe('unit · a workflow that is not there', () => {
  /**
   * The fourth fail-open of this cohort, found auditing this file's siblings after the same shape
   * was reported against three of them. The header used to claim "CI having no release job catches
   * it" — nothing in the gate reads `.github/` for a job's existence, so deleting the file made
   * "every package is published" true by leaving no publish step to disagree with.
   *
   * `absent` and `unreadable` are separate kinds because the edit differs: restore the file, or
   * restore the steps inside it.
   */
  test('is a finding when this tree has something to publish', async () => {
    // `node:` — Bun has no temporary-directory or path-join primitive of its own.
    const root = await mkdtemp(join(tmpdir(), 'ultimate-publish-absent-'));
    try {
      await Bun.write(
        join(root, 'packages/core/package.json'),
        '{ "name": "@ultimat3/core", "version": "1.0.0" }\n',
      );
      const gaps = await publishListGaps(root);

      expect(gaps).toHaveLength(1);
      expect(gaps[0]?.kind).toBe('absent');
      const finding = publishGapFindingFor(gaps[0] as PublishGap);
      expect(finding.code).toBe('X_PUBLISH_LIST_INCOMPLETE');
      expect(finding.cause).toContain('does not exist');
      expect(finding.cause).toContain('no list to disagree with');
      expect(finding.fix).toContain('git checkout');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('a tree with nothing to publish owes no workflow', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ultimate-publish-private-'));
    try {
      await Bun.write(
        join(root, 'packages/demo/package.json'),
        '{ "name": "demo", "version": "1.0.0", "private": true }\n',
      );
      expect(await publishListGaps(root)).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('a workflow that exists and publishes nothing is the OTHER kind', () => {
    const gaps = checkPublishList(tree({ workflow: '      - run: echo hi\n' }));
    expect(gaps[0]?.kind).toBe('unreadable');
    expect(publishGapFindingFor(gaps[0] as PublishGap).fix).toContain('git log');
  });
});

describe('unit · this repo', () => {
  /**
   * The workflow's own hygiene against the REAL tree: no step publishes a name this tree cannot
   * publish. Deliberately NOT the `missing` rule — that is the live gate step (`frameworkFiles` in
   * `scripts/verify.ts`), and asserting it here would duplicate the step and report a workflow the
   * release owns as this file's failure.
   */
  test(
    'publishes no name that is not a publishable workspace',
    async () => {
      const noise = (await publishListGaps(repoRoot())).filter((gap) => gap.kind !== 'missing');
      expect(noise).toEqual([]);
    },
    REPO_SCAN_TIMEOUT_MS,
  );

  test(
    'has publishable workspaces at all, so the rule has something to enforce',
    async () => {
      const publishable = publishOrder(await listWorkspaces(repoRoot()));
      expect(publishable.length).toBeGreaterThan(20);
    },
    REPO_SCAN_TIMEOUT_MS,
  );

  /**
   * The other half of the derived list, and the half no rule above can see: the release workflow
   * pipes `scripts/list-workspaces.ts --json` through
   *   `.data | map(select(.publish == "public")) | group_by(.tier)`
   * so the whole publish plan is three field names in a jq filter. Renaming any of them here would
   * leave the release publishing NOTHING, and the only place that fails today is the release
   * itself. Run as a subprocess, because the `--json` payload is what the workflow consumes.
   */
  test(
    'the enumeration the workflow derives from still carries name, tier and publish',
    async () => {
      const root = repoRoot();
      const result = await run(['bun', 'run', 'scripts/list-workspaces.ts', '--json'], {
        cwd: root,
      });
      expect(result.ok).toBe(true);
      const payload: unknown = JSON.parse(result.output);
      const rows = (payload as { data?: unknown }).data;
      expect(Array.isArray(rows)).toBe(true);

      const table = (Array.isArray(rows) ? rows : []) as readonly Record<string, unknown>[];
      const published = table
        .filter((row) => row['publish'] === 'public')
        .map((row) => row['name']);
      const expected = publishOrder(await listWorkspaces(root)).map((one) => one.name);
      expect(published.sort()).toEqual([...expected].sort());
      for (const row of table) expect(typeof row['tier']).toBe('number');
    },
    REPO_SCAN_TIMEOUT_MS,
  );
});
