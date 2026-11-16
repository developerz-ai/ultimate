// The `next` lane's rule (wiki/Stability.md): a major is PROPOSED — `next` merged into `main` and
// bumped, as one pull request — only when the major window is open and `next` exists, carries a
// change `main` lacks and is green at its tip. Every other answer names why, and none cuts.

import { describe, expect, test } from 'bun:test';
// why: Bun exposes no path-join primitive; Bun.file takes one already joined.
import { join } from 'node:path';
import { parseChangelog } from './changelog-sections';
import type { NextFacts } from './release-due-next';
import { NEXT_LANE_REASONS, nextLane, proposalSteps } from './release-due-next';
import { repoRoot } from './run';

const SHA = 'c'.repeat(40);
/** 31.0.0 opened the window clock on 2026-11-10: the next major may ship from 2027-02-08. */
const CHANGELOG = parseChangelog(
  [
    '# Changelog',
    '',
    '## [Unreleased]',
    '',
    '## 31.30.0 - 2026-11-15',
    '',
    '- a minor',
    '',
    '## 31.0.0 - 2026-11-10',
    '',
    '- the stable line',
    '',
  ].join('\n'),
);
const OPEN = '2027-02-09';
const CLOSED = '2026-11-15';

const ready = (overrides: Partial<NextFacts> = {}): NextFacts => ({
  branch: { kind: 'present', sha: SHA },
  changedFiles: 12,
  behindMain: 0,
  ci: { kind: 'green', url: 'https://example.test/run/1' },
  openPrTitles: [],
  ...overrides,
});

const lane = (today: string, facts?: NextFacts) =>
  nextLane({ stamped: '31.30.0', changelog: CHANGELOG, today, facts: () => facts ?? ready() });

describe('unit · release-due-next · the window decides first', () => {
  test('a closed window refuses with the bump’s own X_RELEASE_MAJOR_WINDOW and asks nothing', async () => {
    let asked = false;
    const decision = await nextLane({
      stamped: '31.30.0',
      changelog: CHANGELOG,
      today: CLOSED,
      facts: () => {
        asked = true;
        return ready();
      },
    });
    expect(decision.propose).toBe(false);
    expect(decision.reason).toBe('window_closed');
    expect(decision.version).toBe('32.0.0');
    expect(decision.windowOpensOn).toBe('2027-02-08');
    expect(decision.refusal?.code).toBe('X_RELEASE_MAJOR_WINDOW');
    expect(decision.steps).toEqual([]);
    // The lookups cost the network: a closed window never pays for them.
    expect(asked).toBe(false);
  });

  test('the day the window opens is open', async () => {
    const decision = await lane('2027-02-08');
    expect(decision.propose).toBe(true);
  });
});

describe('unit · release-due-next · an open window proposes only a ready next', () => {
  test('next present, ahead and green: one PR, merge plus bump, never merged by the box', async () => {
    const decision = await lane(OPEN);
    expect(decision.propose).toBe(true);
    expect(decision.reason).toBeUndefined();
    expect(decision.prTitle).toBe('chore: release 32.0.0');
    expect(decision.steps).toEqual(proposalSteps('32.0.0'));
    const joined = decision.steps.join('\n');
    expect(joined).toContain('git merge --no-edit origin/main');
    expect(joined).toContain('bun run scripts/release.ts --version 32.0.0');
    expect(joined).toContain(
      "gh pr create --base main --head chore/release-32.0.0 --title 'chore: release 32.0.0'",
    );
    // Proposed, never cut: no step merges the PR, tags, or publishes.
    expect(joined).not.toMatch(/gh pr merge|git tag|npm publish|gh release/);
  });

  const cases: readonly [string, NextFacts, (typeof NEXT_LANE_REASONS)[number]][] = [
    ['no next branch', ready({ branch: { kind: 'absent' } }), 'no_next'],
    [
      'the branch lookup failed',
      ready({ branch: { kind: 'unreadable', why: 'HTTP 502' } }),
      'cannot_tell',
    ],
    ['next carries nothing main lacks', ready({ changedFiles: 0 }), 'not_ahead'],
    ['the compare failed', ready({ changedFiles: undefined }), 'cannot_tell'],
    [
      'red at its tip',
      ready({ ci: { kind: 'red', conclusion: 'failure', url: 'u' } }),
      'not_green',
    ],
    ['still running', ready({ ci: { kind: 'running', url: 'u' } }), 'not_green'],
    ['never gated at its tip', ready({ ci: { kind: 'none' } }), 'not_green'],
    [
      'the run lookup failed',
      ready({ ci: { kind: 'unreadable', why: 'gh missing' } }),
      'cannot_tell',
    ],
    ['the PR lookup failed', ready({ openPrTitles: undefined }), 'cannot_tell'],
    ['the proposal is open', ready({ openPrTitles: ['chore: release 32.0.0'] }), 'proposal_open'],
  ];
  for (const [name, facts, reason] of cases) {
    test(`${name}: ${reason}, nothing proposed`, async () => {
      const decision = await lane(OPEN, facts);
      expect({ propose: decision.propose, reason: decision.reason, steps: decision.steps }).toEqual(
        { propose: false, reason, steps: [] },
      );
      expect(decision.detail.length).toBeGreaterThan(0);
    });
  }

  test('a PR for another version is not the twin', async () => {
    const decision = await lane(
      OPEN,
      ready({ openPrTitles: ['chore: release 31.31.0', 'Release 32.0.0'] }),
    );
    expect(decision.propose).toBe(true);
  });

  test('behind main still proposes: the first step merges main, and the detail says so', async () => {
    const decision = await lane(OPEN, ready({ behindMain: 4 }));
    expect(decision.propose).toBe(true);
    expect(decision.detail).toContain('4 commit(s) behind main');
  });

  test('every reason the rule can give is in the closed list', () => {
    expect([...NEXT_LANE_REASONS].sort()).toEqual(
      ['cannot_tell', 'no_next', 'not_ahead', 'not_green', 'proposal_open', 'window_closed'].sort(),
    );
  });
});

describe('unit · release-due-next · the brief keys one row per reason', () => {
  test('the `data.nextLane.reason` table is the closed list, plus the proposal row', async () => {
    const brief = await Bun.file(join(repoRoot(), '.dz/briefs/release-due.md')).text();
    const start = brief.indexOf('| `data.nextLane.reason` |');
    expect(start, 'the next-lane table vanished from the brief').toBeGreaterThan(-1);
    const rows = brief.slice(start).split('\n\n')[0]?.split('\n').slice(2) ?? [];
    const keys = rows.map((row) => /^\| `([a-z_]+)` \|/.exec(row)?.[1] ?? row.slice(0, 40));
    expect(keys.slice(0, -1).sort()).toEqual([...NEXT_LANE_REASONS].sort());
    expect(rows.at(-1)).toContain('`data.nextLane.steps`');
    expect(rows.at(-1)).toContain('`data.nextLane.prTitle`');
  });
});
