// Cutting a maintenance lane, against stubbed git, registry and runner: the branch from the last
// tag of the major, maint-<major> per package at its newest held version, every step skipped once
// done — and a major with no open window, or no tag to cut from, refused before anything runs.

import { describe, expect, test } from 'bun:test';
import { parseChangelog } from './lib/changelog-sections';
import type { RunResult } from './lib/run';
import { type MaintLaneSeams, maintLaneResult } from './release-maint';

const CHANGELOG = parseChangelog(
  ['# Changelog', '', '## 31.0.0 - 2026-11-10', '', '- a', '', '## 30.0.0 - 2026-11-07', ''].join(
    '\n',
  ),
);
const TAGS = ['aaa\trefs/tags/v30.9.0', 'ccc\trefs/tags/v30.9.0^{}', 'ddd\trefs/tags/v31.0.0'].join(
  '\n',
);

const ok = (output: string): RunResult => ({
  command: [],
  code: 0,
  ok: true,
  output,
  durationMs: 1,
  timedOut: false,
});

const packument = (versions: readonly string[], tags: Record<string, string>) =>
  new Response(
    JSON.stringify({
      'dist-tags': tags,
      versions: Object.fromEntries(versions.map((version) => [version, {}])),
    }),
  );

const seams = (over: Partial<MaintLaneSeams> = {}) => {
  const ran: string[] = [];
  const base: MaintLaneSeams = {
    changelog: CHANGELOG,
    today: '2026-11-15',
    packages: ['@ultimat3/core', '@ultimat3/flags'],
    git: async (args) => ok(args.includes('--tags') ? TAGS : ''),
    fetch: async (url) =>
      String(url).includes('flags')
        ? packument(['30.8.0', '31.0.0'], { latest: '31.30.0' })
        : packument(['30.9.0', '31.0.0'], { latest: '31.30.0', 'maint-30': '30.9.0' }),
    exec: async (argv) => {
      ran.push(argv.join(' '));
      return ok('');
    },
    ...over,
  };
  return { seams: base, ran };
};

describe('unit · release-maint · the plan', () => {
  test('a dry run prints the branch cut and every missing dist-tag, and runs nothing', async () => {
    const { seams: stubs, ran } = seams();
    const result = await maintLaneResult({ major: 30, dryRun: true }, stubs);
    expect(result.ok).toBe(true);
    expect(ran).toEqual([]);
    expect(result.data).toMatchObject({
      major: 30,
      branch: 'release/30.x',
      distTag: 'maint-30',
      closesOn: '2027-05-10',
      fromTag: 'v30.9.0',
      steps: [
        {
          kind: 'branch',
          state: 'pending',
          command: 'gh api repos/{owner}/{repo}/git/refs -f ref=refs/heads/release/30.x -f sha=ccc',
        },
        {
          kind: 'dist-tag',
          target: '@ultimat3/core',
          state: 'done',
          command: 'npm dist-tag add @ultimat3/core@30.9.0 maint-30',
        },
        {
          kind: 'dist-tag',
          target: '@ultimat3/flags',
          state: 'pending',
          command: 'npm dist-tag add @ultimat3/flags@30.8.0 maint-30',
        },
      ],
    });
  });

  test('without --dry-run the pending steps run in order, the done ones never', async () => {
    const { seams: stubs, ran } = seams();
    const result = await maintLaneResult({ major: 30, dryRun: false }, stubs);
    expect(result.ok).toBe(true);
    expect(ran).toEqual([
      'gh api repos/{owner}/{repo}/git/refs -f ref=refs/heads/release/30.x -f sha=ccc',
      'npm dist-tag add @ultimat3/flags@30.8.0 maint-30',
    ]);
  });

  test('a branch already on origin is done; a package with no 30.x on npm is skipped', async () => {
    const { seams: stubs, ran } = seams({
      git: async (args) => ok(args.includes('--tags') ? TAGS : 'ccc\trefs/heads/release/30.x\n'),
      fetch: async () => packument(['31.0.0'], { latest: '31.30.0' }),
    });
    const result = await maintLaneResult({ major: 30, dryRun: false }, stubs);
    expect(result.ok).toBe(true);
    expect(ran).toEqual([]);
    expect(result.lines?.join('\n')).toContain('no 30.x version on npm');
  });

  test('a failing write stops the run with the rerun as its fix', async () => {
    const { seams: stubs } = seams({
      exec: async () => ({ ...ok('npm error code EOTP'), ok: false, code: 1 }),
    });
    const result = await maintLaneResult({ major: 30, dryRun: false }, stubs);
    expect(result.ok).toBe(false);
    expect(result.findings?.map((finding) => finding.code)).toEqual(['X_MAINT_LANE_WRITE_FAILED']);
    expect(
      result.findings?.[0]?.fix.startsWith('bun run scripts/release-maint.ts --major 30'),
    ).toBe(true);
  });
});

describe('unit · release-maint · refusals before anything runs', () => {
  test('the current major, a pre-30 major and a closed window have no lane to cut', async () => {
    for (const [major, today] of [
      [31, '2026-11-15'],
      [29, '2026-11-15'],
      [30, '2027-05-11'],
    ] as const) {
      const { seams: stubs, ran } = seams({ today });
      const result = await maintLaneResult({ major, dryRun: false }, stubs);
      expect(result.ok).toBe(false);
      expect(result.findings?.map((finding) => finding.code)).toEqual(['X_MAINT_LANE_REFUSED']);
      expect(ran).toEqual([]);
    }
  });

  test('no v30 tag on origin is a refusal, never a branch cut from nothing', async () => {
    const { seams: stubs, ran } = seams({ git: async () => ok('') });
    const result = await maintLaneResult({ major: 30, dryRun: false }, stubs);
    expect(result.findings?.map((finding) => finding.code)).toEqual(['X_MAINT_LANE_REFUSED']);
    expect(ran).toEqual([]);
  });

  test('a registry that does not answer refuses the whole run', async () => {
    const { seams: stubs, ran } = seams({ fetch: async () => new Response('', { status: 503 }) });
    const result = await maintLaneResult({ major: 30, dryRun: false }, stubs);
    expect(result.findings?.map((finding) => finding.code)).toContain('X_REGISTRY_UNREACHABLE');
    expect(ran).toEqual([]);
  });
});
