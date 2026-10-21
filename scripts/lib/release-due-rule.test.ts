// The release-due decision over fixtures: each reason it can refuse with, the bump it computes,
// and what it tells the releaser to write first. Git and the clock never enter this file.

import { describe, expect, test } from 'bun:test';
import type { DueInput, WindowCommit } from './release-due-rule';
import { bumpOf, DEPENDABOT, openReleaseAsk, releaseDue } from './release-due-rule';
import { RELEASE_SUBJECT } from './release-subject';

const HOUR = 3_600_000;
const NOW = Date.UTC(2026, 9, 14, 12);
/** Landed `hoursAgo` before NOW, as git's epoch seconds. */
const at = (hoursAgo: number): number => Math.floor((NOW - hoursAgo * HOUR) / 1000);

const commit = (overrides: Partial<WindowCommit> = {}): WindowCommit => ({
  sha: 'a'.repeat(40),
  subject: 'fix(core): a thing (#9)',
  author: 'Outside Contributor',
  committedAt: at(48),
  files: ['packages/core/src/a.ts'],
  ...overrides,
});

const input = (overrides: Partial<DueInput> = {}): DueInput => ({
  tagged: '1.2.3',
  stamped: '1.2.3',
  commits: [commit()],
  unreleased: '### Fixed\n\n- a thing',
  nowMs: NOW,
  settleHours: 24,
  ships: (path) => /^packages\/([^/]+)\/src\//.exec(path)?.[1],
  ...overrides,
});

describe('unit · release-due-rule · due', () => {
  test('a settled shipping fix is a due patch, with the command that cuts it', () => {
    const decision = releaseDue(input());
    expect(decision.due).toBe(true);
    expect(decision.reason).toBeUndefined();
    expect(decision.bump).toBe('patch');
    expect(decision.next).toBe('1.2.4');
    expect(decision.command).toBe('bun run scripts/release.ts --version 1.2.4');
    expect(decision.shipping.map((c) => [c.subject, c.packages])).toEqual([
      ['fix(core): a thing (#9)', ['core']],
    ]);
    expect(decision.notes).toEqual([]);
    expect(decision.breaking).toEqual([]);
  });

  test('exactly at the settle boundary is due; a minute before it is settling', () => {
    expect(releaseDue(input({ commits: [commit({ committedAt: at(24) })] })).due).toBe(true);
    const early = releaseDue(input({ commits: [commit({ committedAt: at(24 - 1 / 60) })] }));
    expect(early.reason).toBe('settling');
  });
});

describe('unit · release-due-rule · not due', () => {
  test('nothing ships: only root tooling, docs and release commits since the tag', () => {
    const decision = releaseDue(
      input({
        commits: [
          commit({ files: ['bun.lock', 'docs/a.md'], author: DEPENDABOT }),
          commit({ subject: 'chore: release 1.2.3 (#8)', files: ['packages/core/src/a.ts'] }),
        ],
      }),
    );
    expect(decision.reason).toBe('nothing_ships');
    expect(decision.due).toBe(false);
    expect(decision.inert).toBe(1);
    expect(decision.next).toBeUndefined();
  });

  test('a release commit is never a shipping commit, in either subject this repo has used', () => {
    for (const subject of ['chore: release 27.10.1 (#770)', 'release: 6.0.0']) {
      expect({ subject, release: RELEASE_SUBJECT.test(subject) }).toEqual({
        subject,
        release: true,
      });
    }
    expect(RELEASE_SUBJECT.test('fix(release): the release script')).toBe(false);
    expect(RELEASE_SUBJECT.test('chore: release notes wording')).toBe(false);
  });

  test('a BREAKING — line under [Unreleased] holds it for a maintainer, as a major', () => {
    const decision = releaseDue(
      input({ unreleased: '### Changed\n\n- **BREAKING — (#1) a thing goes.** detail' }),
    );
    expect(decision.due).toBe(false);
    expect(decision.reason).toBe('major_needs_a_maintainer');
    expect(decision.next).toBe('2.0.0');
    expect(decision.breaking).toEqual(['- **BREAKING — (#1) a thing goes.** detail']);
  });

  test('so does a `!:` subject, while an indented or quoted BREAKING does not', () => {
    const bang = releaseDue(input({ commits: [commit({ subject: 'feat(core)!: drop a thing' })] }));
    expect(bang.reason).toBe('major_needs_a_maintainer');
    expect(bang.breaking).toEqual(['feat(core)!: drop a thing']);
    expect(bumpOf('- **New names, nothing `BREAKING`.**', [])).toBe('patch');
  });

  test('a fresh shipping commit is settling, and says when it becomes due', () => {
    const decision = releaseDue(input({ commits: [commit({ committedAt: at(2) })] }));
    expect(decision.due).toBe(false);
    expect(decision.reason).toBe('settling');
    expect(decision.dueAt).toBe(new Date(at(2) * 1000 + 24 * HOUR).toISOString());
    expect(decision.next).toBe('1.2.4');
  });

  test('the OLDEST shipping commit decides the window, not the newest', () => {
    const decision = releaseDue(
      input({ commits: [commit({ committedAt: at(1) }), commit({ committedAt: at(30) })] }),
    );
    expect(decision.due).toBe(true);
  });

  test('a stamped version past the last tag is a merged release awaiting its tag', () => {
    const decision = releaseDue(input({ stamped: '1.3.0' }));
    expect(decision.due).toBe(false);
    expect(decision.reason).toBe('awaiting_tag');
    expect(decision.command).toContain('release-tag.yml');
  });
});

describe('unit · release-due-rule · the bump', () => {
  // `### Changed` alone is a patch: 20.1.2 and 20.2.1 shipped one as a patch release.
  test('### Added under [Unreleased] is minor; ### Changed or ### Fixed alone is patch', () => {
    expect(releaseDue(input({ unreleased: '### Added\n\n- x' })).next).toBe('1.3.0');
    expect(releaseDue(input({ unreleased: '### Changed\n\n- x' })).next).toBe('1.2.4');
    expect(releaseDue(input({ unreleased: '### Changed\n\n- x\n\n### Added\n\n- y' })).next).toBe(
      '1.3.0',
    );
    expect(releaseDue(input({ unreleased: '### Fixed\n\n- x' })).next).toBe('1.2.4');
  });

  test('a feat: subject is minor even before its changelog line is written', () => {
    const decision = releaseDue(input({ commits: [commit({ subject: 'feat(ai): a thing' })] }));
    expect(decision.bump).toBe('minor');
  });
});

describe('unit · release-due-rule · what the changelog owes', () => {
  test('a Dependabot-only window with an empty [Unreleased] asks for a ### Changed line', () => {
    const decision = releaseDue(
      input({
        unreleased: '',
        commits: [
          commit({
            author: DEPENDABOT,
            subject: 'chore(deps): bump x',
            files: ['packages/core/src/x.ts'],
          }),
        ],
      }),
    );
    expect(decision.due).toBe(true);
    expect(decision.notes.join('\n')).toContain('Dependabot-only');
    expect(decision.notes.join('\n')).toContain('### Changed');
    expect(decision.bump).toBe('patch');
  });

  test('the same window with its ### Changed dependency line written is still a patch', () => {
    const decision = releaseDue(
      input({
        unreleased: '### Changed\n\n- `x` 1.0.0 → 1.1.0',
        commits: [commit({ author: DEPENDABOT, subject: 'chore(deps): bump x' })],
      }),
    );
    expect(decision.bump).toBe('patch');
    expect(decision.notes).toEqual([]);
  });

  test('an empty [Unreleased] over a human window asks for the notes, as a patch', () => {
    const decision = releaseDue(input({ unreleased: '' }));
    expect(decision.notes.join('\n')).toContain('empty');
    expect(decision.notes.join('\n')).not.toContain('Dependabot');
    expect(decision.bump).toBe('patch');
  });

  test('a written [Unreleased] owes nothing', () => {
    expect(releaseDue(input({ commits: [commit({ author: DEPENDABOT })] })).notes).toEqual([]);
  });
});

describe('unit · release-due-rule · the ask dedupe', () => {
  // The exact failed-publish titles release-subject.test.ts:50-59 pins as non-asks. None of them is
  // a twin, so none may suppress a real ask.
  const FAILED_PUBLISH = [
    'Release failed: 27.10.1',
    'Release 27.10.1 failed to publish',
    'Release 27.10.1 (#1)',
    'release 27.10.1',
    'Release 27.10.1-beta',
    'Release 27.10.1.1',
    'Release 27.10',
    'Release: 27.10.1',
    'Release X.Y.Z',
  ];

  test('a true twin — an open issue titled exactly `Release 27.10.1` — reports open', () => {
    expect(openReleaseAsk(['Release 27.10.1'], '27.10.1')).toEqual({
      open: true,
      twin: 'Release 27.10.1',
    });
  });

  test('every failed-publish title reports not open, so it never suppresses the ask', () => {
    for (const title of FAILED_PUBLISH) {
      expect({ title, ...openReleaseAsk([title], '27.10.1') }).toEqual({
        title,
        open: false,
      });
    }
  });

  test('an ask for a different version is not a twin', () => {
    expect(openReleaseAsk(['Release 27.10.2'], '27.10.1').open).toBe(false);
    expect(openReleaseAsk(['Release 1.0.0'], '27.10.1').open).toBe(false);
  });

  test('a longer version that starts with the target is not a twin: 27.10.10 ≠ 27.10.1', () => {
    expect(openReleaseAsk(['Release 27.10.10'], '27.10.1').open).toBe(false);
  });

  test('an empty open-issue list is not open', () => {
    expect(openReleaseAsk([], '27.10.1')).toEqual({ open: false });
  });

  test('a due decision names the twin in detail, so the bot can decide not to file', () => {
    const decision = releaseDue(
      input({
        tagged: '27.10.0',
        stamped: '27.10.0',
        openIssueTitles: ['Release 27.10.1'],
      }),
    );
    expect(decision.due).toBe(true);
    expect(decision.next).toBe('27.10.1');
    expect(decision.detail).toContain('Release 27.10.1');
  });

  test('a due decision with no twin carries no twin in detail', () => {
    const decision = releaseDue(input({ openIssueTitles: FAILED_PUBLISH }));
    expect(decision.due).toBe(true);
    expect(decision.detail).not.toContain('already open');
  });
});
