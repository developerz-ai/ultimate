// Every rule in changelog-check.ts, each proved against a fixture that violates exactly it — and
// then the whole rule set against the two files this repo really ships, which is the assertion that
// makes it a gate rather than a demo.

import { describe, expect, setDefaultTimeout, test } from 'bun:test';
import type { ChangelogGapKind } from './changelog-check';
import {
  BREAKING_ENTRY,
  CHANGELOG_PATH,
  changelogFinding,
  checkChangelog,
  parseChangelog,
  parseDerivedTotal,
  parseMigrationTable,
  taggedVersion,
  UPGRADING_PATH,
} from './changelog-check';
import { REPO_SCAN_TIMEOUT_MS, repoRoot } from './lib/run';

// Reads the real tree, so it runs on the repo-scan backstop rather than Bun's 5000ms
// default — see `REPO_SCAN_TIMEOUT_MS`. A backstop, not an assertion: nothing here is meant
// to take minutes, and a test that does has hung.
setDefaultTimeout(REPO_SCAN_TIMEOUT_MS);

/** A file that passes every rule. Each test breaks one thing in it and nothing else. */
const GOOD_CHANGELOG = `# Changelog

Preamble.

## [Unreleased]

Nothing yet.

## 2.0.0 - 2026-08-17

### Changed

- **BREAKING — one thing moved.** Do the edit.
- **BREAKING — another thing moved.** Do the other edit.

## 1.0.0 - 2026-08-10

First release.
`;

const GOOD_UPGRADING = `# Upgrading

| From → to | Breaking entries | Read |
|---|---|---|
| 1.x → 2.0.0 | **2** | the \`2.0.0\` section, in order |
| 1.x → 2.0.0 | **2** | all one sections, oldest first |

\`\`\`sh
grep -cE '^(- \\*\\*|### )BREAKING —' CHANGELOG.md
# 2 As of 2026-08
\`\`\`

## 1.x → 2.0.0, entry by entry

The section the row above sends the reader to.
`;

const kinds = (changelog: string, upgrading: string, taggedVersion?: string): readonly string[] =>
  checkChangelog({ changelog, upgrading, taggedVersion }).map((gap) => gap.kind);

describe('parsing', () => {
  test('a section owns the lines under its heading, and knows its own breaking count', () => {
    const sections = parseChangelog(GOOD_CHANGELOG);
    expect(sections.map((section) => section.version)).toEqual(['unreleased', '2.0.0', '1.0.0']);
    expect(sections.map((section) => section.breaking)).toEqual([0, 2, 0]);
    expect(sections[1]?.line).toBe(9);
  });

  // The anchor is the rule: three sub-bullets under one entry are ONE entry, which is what makes
  // 6.0.0's ten `BREAKING —` lines the seven entries wiki/Upgrading.md counts.
  test('an indented BREAKING sub-bullet belongs to the entry above it', () => {
    expect(BREAKING_ENTRY.test('- **BREAKING — a thing.** edit')).toBe(true);
    expect(BREAKING_ENTRY.test('### BREAKING — a thing')).toBe(true);
    expect(BREAKING_ENTRY.test('  - **BREAKING — a detail.** edit')).toBe(false);
  });

  test('a row is read by where it sends the reader, not by its position', () => {
    const rows = parseMigrationTable(GOOD_UPGRADING);
    expect(rows.map((row) => row.target)).toEqual(['2.0.0', undefined]);
    expect(rows.map((row) => row.aggregate)).toEqual([false, true]);
    expect(rows[0]?.claimed).toBe(2);
  });

  test('the derived total counts RELEASED sections only', () => {
    // A whole-file sum agrees with the page only while [Unreleased] is empty, so every PR that
    // landed a breaking change turned this red and the repair was a number the next release
    // invalidates — the release PROMOTES the section, it does not append one, so the total is
    // unchanged by a release and must be unchanged by the work leading to it.
    const pending = GOOD_CHANGELOG.replace(
      'Nothing yet.',
      '- **BREAKING — a third thing moved.** Do the third edit.',
    );
    expect(kinds(pending, GOOD_UPGRADING)).not.toContain('total');
    // Non-vacuous: the same entry inside a RELEASED section does move it.
    const shipped = GOOD_CHANGELOG.replace(
      '- **BREAKING — another thing moved.** Do the other edit.',
      '- **BREAKING — another thing moved.** Do the other edit.\n- **BREAKING — a third.** Edit.',
    );
    expect(kinds(shipped, GOOD_UPGRADING)).toContain('total');
  });

  test('the derived total is read out of the fenced grep the page prints', () => {
    expect(parseDerivedTotal(GOOD_UPGRADING)?.claimed).toBe(2);
    expect(parseDerivedTotal('# Upgrading\n\nno fence here\n')).toBeUndefined();
  });
});

describe('the rules, each proved against the fixture that breaks it', () => {
  test('the good fixture is silent, so every finding below is caused by the mutation', () => {
    expect(kinds(GOOD_CHANGELOG, GOOD_UPGRADING, '2.0.0')).toEqual([]);
  });

  // The failure that shipped twice unnoticed: an auto-generated section above a hand-written one,
  // both `## 5.0.1`, with the migration in the lower half.
  test('two sections naming one version', () => {
    const doubled = GOOD_CHANGELOG.replace(
      '## 1.0.0 - 2026-08-10',
      '## 2.0.0\n\n- generated subject\n\n## 1.0.0 - 2026-08-10',
    );
    expect(kinds(doubled, GOOD_UPGRADING)).toContain('duplicate');
  });

  test('a released section with no body', () => {
    const hollow = GOOD_CHANGELOG.replace(
      '### Changed\n\n- **BREAKING — one thing moved.** Do the edit.\n- **BREAKING — another thing moved.** Do the other edit.\n',
      '',
    );
    expect(kinds(hollow, GOOD_UPGRADING)).toContain('empty');
  });

  test('[Unreleased] is empty on purpose and is never reported as hollow', () => {
    expect(kinds(GOOD_CHANGELOG.replace('Nothing yet.\n', ''), GOOD_UPGRADING)).not.toContain(
      'empty',
    );
  });

  // 6.0.0 exactly: the migration under [Unreleased] at the moment the tag was pushed.
  test('a BREAKING entry left under [Unreleased] at a tagged commit', () => {
    const stranded = GOOD_CHANGELOG.replace(
      'Nothing yet.',
      '- **BREAKING — the migration.** Do the edit.',
    );
    expect(kinds(stranded, GOOD_UPGRADING, '2.0.0')).toContain('unreleased-breaking');
    // Between releases the same file is correct: that is where a breaking entry is supposed to sit.
    expect(kinds(stranded, GOOD_UPGRADING)).not.toContain('unreleased-breaking');
  });

  // The rule the issue calls out. A whole-file count cannot see this: moving an entry into the
  // wrong section leaves the total at 2 and only the PER-SECTION number moves.
  test('a count read from the whole file instead of from the major own section', () => {
    const misfiled = GOOD_CHANGELOG.replace(
      '- **BREAKING — another thing moved.** Do the other edit.\n',
      '',
    ).replace('First release.', '- **BREAKING — another thing moved.** Do the other edit.');
    expect(kinds(misfiled, GOOD_UPGRADING)).toEqual(['count', 'count']);
    // And the whole-file total is STILL 2, which is exactly why a derived total waved this through:
    // a misplaced entry does not change the number, it only changes which section holds it.
    expect(parseDerivedTotal(GOOD_UPGRADING)?.claimed).toBe(2);
    expect(kinds(misfiled, GOOD_UPGRADING)).not.toContain('total');
  });

  // The 2.0.0 failure, exactly: a row naming a section the page has never carried. The row is
  // present and its count is right, so every other rule in this file passes over it — which is how
  // it survived six releases. Deleting the HEADING alone is the whole mutation.
  test('a row whose section the page does not carry', () => {
    const rowOnly = GOOD_UPGRADING.replace('## 1.x → 2.0.0, entry by entry\n', '');
    expect(kinds(GOOD_CHANGELOG, rowOnly)).toEqual(['missing-section']);
    // Not reported as a missing ROW, and not as a stale count: the row is there and reads 2.
    expect(kinds(GOOD_CHANGELOG, rowOnly)).not.toContain('missing-row');
    expect(kinds(GOOD_CHANGELOG, rowOnly)).not.toContain('count');
  });

  test('a section heading that names the version some other way does not satisfy the rule', () => {
    const renamed = GOOD_UPGRADING.replace(
      '## 1.x → 2.0.0, entry by entry',
      '## Migrating to 2.0.0',
    );
    expect(kinds(GOOD_CHANGELOG, renamed)).toContain('missing-section');
  });

  test('a stale per-major count', () => {
    expect(kinds(GOOD_CHANGELOG, GOOD_UPGRADING.replace('**2** | the', '**3** | the'))).toContain(
      'count',
    );
  });

  test('a stale aggregate row', () => {
    expect(kinds(GOOD_CHANGELOG, GOOD_UPGRADING.replace('**2** | all', '**9** | all'))).toContain(
      'count',
    );
  });

  test('a released major with no row sending the reader anywhere', () => {
    const third = GOOD_CHANGELOG.replace(
      '## 2.0.0 - 2026-08-17',
      '## 3.0.0 - 2026-08-19\n\nA major.\n\n## 2.0.0 - 2026-08-17',
    );
    expect(kinds(third, GOOD_UPGRADING)).toContain('missing-row');
  });

  // One edit per finding. With no row there is no heading either, so the loop reported BOTH — and
  // the two fixes contradict on their first step: write the row, write the section. `missing-section`
  // is the row-present case, and `toEqual` is what holds the pair to one finding.
  test('a major with no row is not also reported as a missing section', () => {
    const third = GOOD_CHANGELOG.replace(
      '## 2.0.0 - 2026-08-17',
      '## 3.0.0 - 2026-08-19\n\nA major.\n\n## 2.0.0 - 2026-08-17',
    );
    expect(kinds(third, GOOD_UPGRADING)).toEqual(['missing-row']);
  });

  test('1.0.0 has nothing to migrate from, so it needs no row', () => {
    expect(kinds(GOOD_CHANGELOG, GOOD_UPGRADING)).not.toContain('missing-row');
  });

  test('the fenced grep promises a number the grep does not print', () => {
    expect(kinds(GOOD_CHANGELOG, GOOD_UPGRADING.replace('# 2 As of', '# 5 As of'))).toContain(
      'total',
    );
  });

  // A rule with no input is a false green, not a pass — the same argument gate-steps.ts makes.
  test('a table that sends the reader to no section at all reports itself', () => {
    expect(kinds(GOOD_CHANGELOG, '# Upgrading\n\nnothing here\n')).toEqual(['unscanned']);
  });
});

describe('findings', () => {
  test('every kind maps to a code, and every fix is runnable as written', () => {
    const gaps = checkChangelog({
      changelog: GOOD_CHANGELOG.replace(
        '## 1.0.0 - 2026-08-10',
        '## 2.0.0\n\n- generated\n\n## 1.0.0 - 2026-08-10',
      ).replace('Nothing yet.', '- **BREAKING — stranded.** edit'),
      upgrading: GOOD_UPGRADING.replace('**2** | the', '**4** | the'),
      taggedVersion: '2.0.0',
    });
    const findings = gaps.map(changelogFinding);
    expect(findings.map((finding) => finding.code)).toContain('X_DOC_CHANGELOG_SECTION_INVALID');
    expect(findings.map((finding) => finding.code)).toContain(
      'X_DOC_CHANGELOG_UNRELEASED_BREAKING',
    );
    expect(findings.map((finding) => finding.code)).toContain('X_DOC_MIGRATION_COUNT_STALE');
    for (const finding of findings) {
      expect(finding.fix.length).toBeGreaterThan(0);
      expect(finding.fix).not.toContain('<');
      expect(finding.at).toBeDefined();
    }
  });

  // `--dry-run` writes nothing, so a fix: whose whole remedy is a --dry-run command hands the
  // reader something that checks the problem and does not solve it. Axiom 4 at the point it is read.
  test('a fix: citing --dry-run also says --dry-run only validates', () => {
    const kinds: readonly ChangelogGapKind[] = [
      'duplicate',
      'empty',
      'unreleased-breaking',
      'count',
      'unknown-section',
      'missing-row',
      'missing-section',
      'total',
      'unscanned',
    ];
    for (const kind of kinds) {
      const { fix } = changelogFinding({ kind, at: 'CHANGELOG.md:9', detail: 'a detail' });
      if (!fix.includes('--dry-run')) continue;
      expect(fix).toContain('validates');
    }
    expect(
      changelogFinding({ kind: 'unreleased-breaking', at: 'CHANGELOG.md:9', detail: 'd' }).fix,
    ).toContain('CHANGELOG.md');
  });

  // Axiom 4, on the one line the reader acts on. `missing-row` fires when NO row exists, so
  // "set that count" names an edit that has no subject — there is no count on the page to set.
  test('the missing-row fix says to add the row, because there is no count to set', () => {
    const third = GOOD_CHANGELOG.replace(
      '## 2.0.0 - 2026-08-17',
      '## 3.0.0 - 2026-08-19\n\nA major.\n\n## 2.0.0 - 2026-08-17',
    );
    const gap = checkChangelog({ changelog: third, upgrading: GOOD_UPGRADING }).find(
      (one) => one.kind === 'missing-row',
    );
    expect(gap).toBeDefined();
    const finding = changelogFinding(gap ?? { kind: 'missing-row', at: '', detail: '' });
    expect(finding.code).toBe('X_DOC_MIGRATION_COUNT_STALE');
    expect(finding.fix).toContain(UPGRADING_PATH);
    expect(finding.fix).toStartWith('add a row');
    expect(finding.fix).not.toContain('set that count');
  });

  // The same defect one row along: the row exists and points at a section that does not, so the
  // count it claims cannot be read from anywhere. The edit is to the row or to CHANGELOG.md.
  test('a row naming a section CHANGELOG.md does not have is not told to set a count', () => {
    const finding = checkChangelog({
      changelog: GOOD_CHANGELOG,
      upgrading: GOOD_UPGRADING.replace('the `2.0.0` section', 'the `9.9.9` section'),
    })
      .map(changelogFinding)
      .find((one) => one.cause.includes('does not have'));
    expect(finding).toBeDefined();
    expect(finding?.fix).not.toContain('set that count');
    expect(finding?.fix).toContain(CHANGELOG_PATH);
  });

  test('the unscanned kind names the file to edit, not the file it read', () => {
    const gap = checkChangelog({ changelog: GOOD_CHANGELOG, upgrading: '# Upgrading\n' })[0];
    expect(gap).toBeDefined();
    expect(changelogFinding(gap ?? { kind: 'unscanned', at: '', detail: '' }).code).toBe(
      'X_DOC_MIGRATION_UNSCANNED',
    );
  });
});

// The point of the whole file: these two are what ships, and they have to be clean under the same
// rules the fixtures above are graded by.
describe('the committed CHANGELOG.md and wiki/Upgrading.md', () => {
  test('pass every rule, at whatever commit this is', async () => {
    const root = repoRoot();
    const changelog = await Bun.file(`${root}/CHANGELOG.md`).text();
    const upgrading = await Bun.file(`${root}/wiki/Upgrading.md`).text();
    // The real tag, never a literal. Hardcoding one asserts the tree must be RELEASABLE at every
    // commit, which forbids the ordinary state of development: a `BREAKING —` entry accumulating
    // under [Unreleased] between releases. That is the entry's correct home until a release
    // promotes it, and a rule that refuses it would push every breaking change out the day it
    // landed — the opposite of what promotion is for.
    expect(
      checkChangelog({ changelog, upgrading, taggedVersion: await taggedVersion(root) }),
    ).toEqual([]);
  });

  test('the same files WOULD be refused if this commit were tagged with breaking entries stranded', async () => {
    const root = repoRoot();
    const changelog = await Bun.file(`${root}/CHANGELOG.md`).text();
    const upgrading = await Bun.file(`${root}/wiki/Upgrading.md`).text();
    const stranded = parseChangelog(changelog).find((section) => !section.released)?.breaking ?? 0;
    const gaps = checkChangelog({ changelog, upgrading, taggedVersion: '99.0.0' });
    // Non-vacuous in both directions: when [Unreleased] holds a breaking entry the tagged reading
    // must refuse it, and when it holds none the tagged reading must be as clean as the untagged
    // one. Either way this test reads the real file, so it cannot pass by describing a fixture.
    if (stranded > 0) expect(gaps.map((gap) => gap.kind)).toContain('unreleased-breaking');
    else expect(gaps).toEqual([]);
  });
});
