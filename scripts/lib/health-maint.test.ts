// The maintenance-lane row in isolation: the lane is judged against the windows the changelog
// derives — an open window with no branch or no dist-tag is red, a closed one whose branch is still
// up is red — and the reader's argv and parsing are read off runner stubs, no network.

import { describe, expect, test } from 'bun:test';
import { type Changelog, parseChangelog } from './changelog-sections';
import {
  judgeMaintLane,
  MAINT_BRANCHES_COMMAND,
  MAINT_DIST_TAGS_COMMAND,
  maintLaneFindings,
  maintLaneReader,
} from './health-maint';
import { maintWindows } from './release-maint';
import type { RunResult } from './run';

const changelog: Changelog = parseChangelog(
  [
    '# Changelog',
    '',
    '## [Unreleased]',
    '',
    '## 31.0.0 - 2026-11-10',
    '',
    '- opener',
    '',
    '## 30.9.0 - 2026-11-09',
    '',
    '- last',
    '',
  ].join('\n'),
);
const windows = maintWindows(changelog);
const INSIDE = '2026-11-15';
const AFTER = '2027-05-11';
const TAGS = { latest: '31.30.0', 'maint-30': '30.9.0' };

const codes = (findings: readonly { readonly code: string }[]): readonly string[] =>
  findings.map((finding) => finding.code);

describe('unit · health-maint · maintLaneFindings', () => {
  test('inside 30s window, release/30.x up and maint-30 on a 30.x version: nothing to say', () => {
    expect(
      maintLaneFindings({ windows, today: INSIDE, branches: ['release/30.x'], distTags: TAGS }),
    ).toEqual([]);
  });

  test('a promised window with no branch is red, naming the command that cuts it', () => {
    const findings = maintLaneFindings({ windows, today: INSIDE, branches: [], distTags: TAGS });
    expect(codes(findings)).toEqual(['X_MAINT_LANE_ABSENT']);
    expect(findings[0]?.cause).toContain('release/30.x');
    expect(findings[0]?.cause).toContain('2027-05-10');
    expect(findings[0]?.fix).toBe('bun run scripts/release-maint.ts --major 30 --dry-run --json');
  });

  test('a promised window with no maint-30 dist-tag is red', () => {
    const findings = maintLaneFindings({
      windows,
      today: INSIDE,
      branches: ['release/30.x'],
      distTags: { latest: '31.30.0' },
    });
    expect(codes(findings)).toEqual(['X_MAINT_LANE_ABSENT']);
    expect(findings[0]?.cause).toContain('maint-30');
  });

  test('maint-30 naming a version off the 30 line is as absent as no tag', () => {
    const findings = maintLaneFindings({
      windows,
      today: INSIDE,
      branches: ['release/30.x'],
      distTags: { latest: '31.30.0', 'maint-30': '31.0.0' },
    });
    expect(codes(findings)).toEqual(['X_MAINT_LANE_ABSENT']);
    expect(findings[0]?.cause).toContain('31.0.0');
  });

  test('a closed window whose branch is still up is red, the fix deletes it', () => {
    const findings = maintLaneFindings({
      windows,
      today: AFTER,
      branches: ['release/30.x'],
      distTags: TAGS,
    });
    expect(codes(findings)).toEqual(['X_MAINT_LANE_EXPIRED']);
    expect(findings[0]?.fix.startsWith('git push origin --delete release/30.x')).toBe(true);
  });

  test('a closed window with the branch gone is healthy: the dist-tag may keep naming 30.x', () => {
    expect(maintLaneFindings({ windows, today: AFTER, branches: [], distTags: TAGS })).toEqual([]);
  });
});

/** A runner that records the argv it was asked for and answers one output. */
const stub = (output: string, ok = true) => {
  const asked: string[][] = [];
  const runner = async (args: readonly string[]): Promise<RunResult> => {
    asked.push([...args]);
    return {
      command: ['stub', ...args],
      code: ok ? 0 : 1,
      ok,
      output,
      durationMs: 1,
      timedOut: false,
    };
  };
  return { asked, runner };
};

describe('unit · health-maint · maintLaneReader', () => {
  test('asks gh for release/* refs and npm for core dist-tags — the commands the row quotes', async () => {
    const gh = stub('refs/heads/release/30.x\n');
    const npm = stub(`npm warn config something\n${JSON.stringify(TAGS, null, 2)}\n`);
    const read = await maintLaneReader('/repo', {
      gh: gh.runner,
      npm: npm.runner,
      load: async () => changelog,
    });
    expect(`gh ${gh.asked[0]?.join(' ')}`).toBe(MAINT_BRANCHES_COMMAND);
    expect(`npm ${npm.asked[0]?.join(' ')}`).toBe(MAINT_DIST_TAGS_COMMAND);
    expect(read.branches).toEqual(['release/30.x']);
    expect(read.distTags).toEqual(TAGS);
  });

  test('no matching ref is an empty list, not a refusal', async () => {
    const read = await maintLaneReader('/repo', {
      gh: stub('').runner,
      npm: stub(JSON.stringify(TAGS)).runner,
      load: async () => changelog,
    });
    expect(read.branches).toEqual([]);
  });

  test('a failed gh or an npm with no JSON reads as unreadable, never as absent', async () => {
    const read = await maintLaneReader('/repo', {
      gh: stub('HTTP 401: Bad credentials', false).runner,
      npm: stub('npm error code E404').runner,
      load: async () => changelog,
    });
    expect(read.branches).toBeUndefined();
    expect(read.distTags).toBeUndefined();
  });
});

describe('unit · health-maint · judgeMaintLane', () => {
  test('healthy with the lane in place, unhealthy carrying the findings when it is not', () => {
    const healthy = judgeMaintLane(
      { changelog, branches: ['release/30.x'], distTags: TAGS },
      INSIDE,
    );
    expect(healthy).toMatchObject({ row: 'maint-lane', verdict: 'healthy' });
    const red = judgeMaintLane({ changelog, branches: [], distTags: {} }, INSIDE);
    expect(red).toMatchObject({ row: 'maint-lane', verdict: 'unhealthy' });
    expect('findings' in red ? codes(red.findings) : []).toEqual([
      'X_MAINT_LANE_ABSENT',
      'X_MAINT_LANE_ABSENT',
    ]);
  });

  test('an unread answer refuses the checkup with the row command, never a verdict', () => {
    const refused = judgeMaintLane({ changelog, branches: undefined, distTags: TAGS }, INSIDE);
    expect(refused).toMatchObject({ code: 'X_HEALTH_ROW_UNREADABLE' });
    expect('cause' in refused ? refused.cause : '').toContain(MAINT_BRANCHES_COMMAND);
    const npmRefused = judgeMaintLane({ changelog, branches: [], distTags: undefined }, INSIDE);
    expect('cause' in npmRefused ? npmRefused.cause : '').toContain(MAINT_DIST_TAGS_COMMAND);
  });
});
