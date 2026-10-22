// The release-due decision over fixtures: each reason it can refuse with, the bump it computes,
// and what it tells the releaser to write first. Git and the clock never enter this file. The
// last describe also pins the brief's decision table (.dz/briefs/release-due.md) to the closed
// reason list, so the checkup's branch point cannot drift from the rule it branches on.

import { describe, expect, setDefaultTimeout, test } from 'bun:test';
// why: Bun exposes no path-join primitive; Bun.file takes one already joined.
import { join } from 'node:path';
import type { DueInput, WindowCommit } from './release-due-rule';
import {
  bumpOf,
  DEPENDABOT,
  NOT_DUE_REASONS,
  openReleaseAsk,
  openReleaseBump,
  releaseDue,
} from './release-due-rule';
import { RELEASE_SUBJECT } from './release-subject';
import { REPO_SCAN_TIMEOUT_MS, repoRoot } from './run';

// Names `repoRoot()`, so the repo-scan guard (scripts/repo-scan-timeout.test.ts) holds this file
// to the repo-scan backstop even though it reads one pinned file, not a tree walk.
setDefaultTimeout(REPO_SCAN_TIMEOUT_MS);

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

  test('the OLDEST shipping commit decides the window, not the newest, and the success detail names its age', () => {
    // Newest is 1h old; oldest is 30h old. The success detail must name the OLDEST's age
    // (30h ≥ settleHours=24), and must NOT misstate the freshly-pushed newest's age nor echo
    // settleHours as "unreleased for Xh or more". Exact wording pin.
    const decision = releaseDue(
      input({ commits: [commit({ committedAt: at(1) }), commit({ committedAt: at(30) })] }),
    );
    expect(decision.due).toBe(true);
    expect(decision.detail).toBe(
      '2 shipping commit(s) since v1.2.3, the oldest shipping commit is 30h or older: patch to 1.2.4',
    );
  });

  test('the settling detail names the OLDEST shipping commit, not the newest, in a mixed-age window', () => {
    // Newest is 1h old; oldest is 23h old. Settling engages against the oldest (23h < 24h),
    // so the settling detail must reference the OLDEST, not the freshly-pushed newest.
    const decision = releaseDue(
      input({ commits: [commit({ committedAt: at(1) }), commit({ committedAt: at(23) })] }),
    );
    expect(decision.due).toBe(false);
    expect(decision.reason).toBe('settling');
    expect(decision.detail).toContain('the oldest shipping commit is younger than 24h');
    expect(decision.detail).not.toContain('newest');
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
        commits: [commit({ committedAt: at(1) }), commit({ committedAt: at(30) })],
        openIssueTitles: ['Release 27.10.1'],
      }),
    );
    expect(decision.due).toBe(true);
    expect(decision.next).toBe('27.10.1');
    expect(decision.detail).toBe(
      '2 shipping commit(s) since v27.10.0, the oldest shipping commit is 30h or older: patch to 27.10.1; an ask already open: Release 27.10.1',
    );
  });

  test('a due decision with no twin carries no twin in detail', () => {
    const decision = releaseDue(input({ openIssueTitles: FAILED_PUBLISH }));
    expect(decision.due).toBe(true);
    expect(decision.detail).not.toContain('already open');
  });
});

describe('unit · release-due-rule · the brief covers the closed list', () => {
  // The brief's decision table is the checkup's only branch point on `data.reason`, so its
  // reason-keyed not-due rows must equal `NOT_DUE_REASONS` exactly: a reason losing its row, or
  // the table growing a reason the rule never returns, must red here rather than send the bot
  // off-table in production. The `X_RELEASE_HEAD_NOT_MAIN` row keys a findings code, not a
  // `NOT_DUE_REASONS` entry — its second cell carries `(in findings)` after the token, so the row
  // regex below passes it over and the pin holds at four.
  test('one brief row per reason, and awaiting_tag pins its watch command', async () => {
    const brief = await Bun.file(join(repoRoot(), '.dz/briefs/release-due.md')).text();
    const falseRows = brief.split('\n').filter((line) => line.startsWith('| `false` |'));
    const reasons = falseRows
      .map((line) => /^\| `false` \| `([^`]+)` \|/.exec(line)?.[1])
      .filter((reason): reason is string => reason !== undefined);
    expect([...reasons].sort()).toEqual([...NOT_DUE_REASONS].sort());
    const awaitingTag = falseRows.find((line) => line.startsWith('| `false` | `awaiting_tag` |'));
    // The row is the whole instruction for this reason, so the pin is on its payload — the
    // command to watch and the verdict to file nothing — not merely on the row's existence.
    // The command is pinned with its backtick delimiters: a bare substring would survive a
    // changed limit, since `--limit 50` contains `--limit 5`.
    expect(awaitingTag, 'the awaiting_tag row vanished from the brief').toBeDefined();
    expect(awaitingTag).toContain('`gh run list --workflow release-tag.yml --limit 5`');
    expect(awaitingTag).toContain('nothing');
  });
});

describe('unit · release-due-rule · the doc table tracks DueDecision', () => {
  // PUBLISHING.md's due-decision envelope table is the maintainer's view of `DueDecision`, so its
  // rows must equal the interface's fields exactly: a field losing its row, or the table growing
  // a field the decision never carries, must red here rather than ship a doc that misdescribes
  // the JSON the bot reads. The fields are parsed from the rule's source, not imported — an
  // import cannot catch a field the interface lost.
  test('one envelope row per field, and breaking names the maintainer issue', async () => {
    const source = await Bun.file(join(repoRoot(), 'scripts/lib/release-due-rule.ts')).text();
    const start = source.indexOf('export interface DueDecision {');
    expect(start, 'DueDecision vanished from release-due-rule.ts').toBeGreaterThanOrEqual(0);
    const interfaceLines = source.slice(start).split('\n');
    const close = interfaceLines.findIndex((line) => line === '}');
    expect(close, 'DueDecision never closes').toBeGreaterThan(0);
    const body = interfaceLines.slice(0, close).join('\n');
    const fields = [...body.matchAll(/^\s{2}readonly ([a-z][a-zA-Z0-9]*)/gm)]
      .map((match) => match[1])
      .filter((field): field is string => field !== undefined);
    expect(fields.length, 'DueDecision parsed to no fields').toBeGreaterThan(0);
    expect(new Set(fields).size, 'a duplicate field in DueDecision').toBe(fields.length);

    const doc = await Bun.file(join(repoRoot(), 'PUBLISHING.md')).text();
    const docLines = doc.split('\n');
    const table = docLines.findIndex((line) => line.startsWith('| `.data` field |'));
    expect(table, 'the envelope table vanished from PUBLISHING.md').toBeGreaterThanOrEqual(0);
    const rowKeys: string[] = [];
    for (let index = table + 1; index < docLines.length; index += 1) {
      const line = docLines[index];
      if (line === undefined || !line.startsWith('|')) break;
      const key = /^\| `([a-z][a-zA-Z0-9]*)` \|/.exec(line)?.[1];
      if (key !== undefined) rowKeys.push(key);
    }
    expect(rowKeys.length, 'the envelope table parsed to no rows').toBeGreaterThan(0);
    expect(new Set(rowKeys).size, 'a duplicate row in the envelope table').toBe(rowKeys.length);
    expect([...fields].sort()).toEqual([...rowKeys].sort());
    expect([...rowKeys].sort()).toEqual([...fields].sort());

    const breakingRow = docLines.find((line) => line.startsWith('| `breaking` |'));
    expect(breakingRow, 'the breaking row vanished from the envelope table').toBeDefined();
    expect(breakingRow).toContain('| array |');
    expect(breakingRow).toContain('maintainer issue');
  });
});

describe('unit · release-due-rule · the bump-PR twin', () => {
  test('a true twin — an open `chore: release 27.10.1 (#770)` — reports open', () => {
    expect(openReleaseBump(['chore: release 27.10.1 (#770)'], '27.10.1')).toEqual({
      open: true,
      twin: 'chore: release 27.10.1 (#770)',
    });
  });

  test('a PR that is not a release subject is no twin', () => {
    expect(openReleaseBump(['docs: a thing'], '27.10.1')).toEqual({ open: false });
  });

  test('an issue-side title is not a bump twin: the two readers stay disjoint', () => {
    // The disjointness pinned in `release-subject.test.ts`: `Release 27.10.1` is the ask, and the
    // case-insensitive title search hands that title to this matcher too.
    expect(openReleaseBump(['Release 27.10.1'], '27.10.1')).toEqual({ open: false });
  });

  test('a longer version that starts with the target is not a twin', () => {
    expect(openReleaseBump(['chore: release 27.10.10'], '27.10.1')).toEqual({ open: false });
  });

  test('no open PRs is not open', () => {
    expect(openReleaseBump([], '27.10.1')).toEqual({ open: false });
  });

  test('a due decision names the bump twin in detail, after the ask note', () => {
    const decision = releaseDue(
      input({
        tagged: '27.10.0',
        stamped: '27.10.0',
        commits: [commit({ committedAt: at(1) }), commit({ committedAt: at(30) })],
        openIssueTitles: ['Release 27.10.1'],
        openPrTitles: ['chore: release 27.10.1 (#812)'],
      }),
    );
    expect(decision.due).toBe(true);
    expect(decision.detail).toBe(
      '2 shipping commit(s) since v27.10.0, the oldest shipping commit is 30h or older: patch to 27.10.1; an ask already open: Release 27.10.1; a bump PR already open: chore: release 27.10.1 (#812)',
    );
  });

  test('a due decision whose open PRs are not twins carries no bump note', () => {
    const decision = releaseDue(input({ openPrTitles: ['docs: a thing', 'Release 1.2.4'] }));
    expect(decision.due).toBe(true);
    expect(decision.detail).not.toContain('bump PR');
  });

  // The ask note and the bump note are independent: a PR without its ask, and an ask without its
  // PR, each name only what is true.
  test('a bump twin with no ask twin still names itself', () => {
    const decision = releaseDue(input({ openPrTitles: ['chore: release 1.2.4 (#812)'] }));
    expect(decision.detail).toBe(
      '1 shipping commit(s) since v1.2.3, the oldest shipping commit is 48h or older: patch to 1.2.4; a bump PR already open: chore: release 1.2.4 (#812)',
    );
  });
});
