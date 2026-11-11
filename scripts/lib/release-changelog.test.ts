// `promoteUnreleased`, the changelog half of a bump: [Unreleased] becomes its own
// `docs/changelog/X.Y.Z.md`, the index gains its row and a fresh [Unreleased], and the result
// passes the gate rules. Moved out of `release.test.ts` at the size ceiling.

import { describe, expect, test } from 'bun:test';
import { checkChangelog } from '../changelog-check';
import { indexFindings } from './changelog-index';
import { assembleChangelog, type ChangelogFile } from './changelog-store';
import { commitBlock, promoteUnreleased } from './release-changelog';

describe('promoteUnreleased', () => {
  const index = [
    '# Changelog',
    '',
    'Preamble.',
    '',
    '## [Unreleased]',
    '',
    '### Changed',
    '',
    '- **BREAKING — a thing moved.** Do the edit.',
    '',
    '## Releases',
    '',
    '| Version | Date | Summary |',
    '|---|---|---|',
    '| [1.0.0](docs/changelog/1.0.0.md) | 2026-08-10 | — |',
    '',
    '## Older releases',
    '',
    'In git history.',
    '',
  ].join('\n');
  const FIRST: ChangelogFile = {
    path: 'docs/changelog/1.0.0.md',
    text: '## 1.0.0 - 2026-08-10\n\n- first\n',
  };
  interface Store {
    readonly index: string;
    readonly files: readonly ChangelogFile[];
  }
  const START: Store = { index, files: [FIRST] };

  const promote = (store: Store, version = '2.0.0', subjects: readonly string[] = []): Store => {
    const result = promoteUnreleased({
      index: store.index,
      changelog: assembleChangelog(store.index, store.files),
      version,
      date: '2026-08-20',
      subjects,
    });
    if ('findings' in result) return expect.unreachable(result.findings[0]?.cause);
    return { index: result.index, files: [...store.files, result.file] };
  };
  const fileOf = (store: Store, version: string): string =>
    store.files.find((file) => file.path === `docs/changelog/${version}.md`)?.text ?? '';

  // The whole issue, in one assertion: the migration ends up IN the version's own file, and there
  // is exactly one heading for that version — not a generated one above a hand-written one.
  test('the [Unreleased] body becomes the version file, migration and all', () => {
    const out = promote(START);
    expect(out.files.map((file) => file.path)).toEqual([
      'docs/changelog/1.0.0.md',
      'docs/changelog/2.0.0.md',
    ]);
    const section = fileOf(out, '2.0.0');
    expect(section).toStartWith('## 2.0.0 - 2026-08-20\n\n### Changed\n');
    expect(section).toContain('- **BREAKING — a thing moved.** Do the edit.');
    expect(section).toEndWith('Do the edit.\n');
    // The index keeps no release section: [Unreleased], the table, the stub.
    const headings = out.index.split('\n').filter((line) => line.startsWith('## '));
    expect(headings).toEqual(['## [Unreleased]', '## Releases', '## Older releases']);
  });

  test('a fresh, empty [Unreleased] is opened, and the table gains the row, newest first', () => {
    const out = promote(START);
    const head = out.index.slice(
      out.index.indexOf('## [Unreleased]'),
      out.index.indexOf('## Releases'),
    );
    expect(head).toBe('## [Unreleased]\n\nNothing yet.\n\n');
    const rows = out.index.split('\n').filter((line) => line.startsWith('| ['));
    expect(rows).toEqual([
      '| [2.0.0](docs/changelog/2.0.0.md) | 2026-08-20 | Changed |',
      '| [1.0.0](docs/changelog/1.0.0.md) | 2026-08-10 | — |',
    ]);
    expect(indexFindings(out.index, out.files)).toEqual([]);
  });

  // A second release is a second promotion, and the placeholder must not accumulate.
  test('the placeholder is never carried into a release file', () => {
    const once = promote(START);
    const next = {
      ...once,
      index: once.index.replace('Nothing yet.', '- **BREAKING — the next one.** Edit.'),
    };
    const twice = promote(next, '2.0.1');
    const all = [twice.index, ...twice.files.map((file) => file.text)].join('\n');
    expect(all.split('Nothing yet.').length - 1).toBe(1);
    expect(fileOf(twice, '2.0.1')).toContain('the next one');
  });

  // The after-state every later bump step reads (the Stability next-window line): the stale
  // [Unreleased] carried into it is a release that still reads its own entries as pending.
  test('the returned changelog is the after-state: fresh [Unreleased], then the new release', () => {
    const result = promoteUnreleased({
      index,
      changelog: assembleChangelog(index, [FIRST]),
      version: '2.0.0',
      date: '2026-08-20',
      subjects: [],
    });
    const after = 'changelog' in result ? result.changelog : [];
    expect(after.map((one) => one.version)).toEqual(['unreleased', '2.0.0', '1.0.0']);
    expect(after[0]?.breaking).toBe(0);
    expect(after[1]?.file).toBe('docs/changelog/2.0.0.md');
  });

  test('commit subjects land INSIDE the section, under a heading nothing hand-written uses', () => {
    const section = fileOf(
      promote(START, '2.0.0', ['fix(cli): a thing', 'docs: another']),
      '2.0.0',
    );
    expect(section).toContain('### Commits\n\n- fix(cli): a thing\n- docs: another\n');
    // Verbatim: a subject is provenance, and rewriting it is how it stops matching `git log`.
    expect(section).not.toContain('### Fixed');
  });

  test('a --security advisory is recorded in the new file, under its heading', () => {
    const result = promoteUnreleased({
      index,
      changelog: assembleChangelog(index, [FIRST]),
      version: '2.0.0',
      date: '2026-08-20',
      subjects: [],
      security: 'CVE-2026-1234',
    });
    const text = 'file' in result ? result.file.text : '';
    expect(text).toStartWith('## 2.0.0 - 2026-08-20\n\n> **Security exception:** `CVE-2026-1234`');
  });

  test('the promoted store passes the changelog gate rules, tagged', () => {
    // The heading as well as the row: `changelog-check` asserts both, because a row pointing at a
    // section that does not exist is what let `1.x → 2.0.0` promise a walkthrough for six releases.
    const upgrading = [
      '| From → to | Breaking entries | Read |',
      '|---|---|---|',
      '| 1.x → 2.0.0 | **1** | the `2.0.0` section, in order |',
      '',
      '## 1.x → 2.0.0, entry by entry',
      '',
      '- the one entry',
    ].join('\n');
    const out = promote(START);
    expect(
      checkChangelog({
        changelog: assembleChangelog(out.index, out.files),
        upgrading,
        taggedVersion: '2.0.0',
      }),
    ).toEqual([]);
    // And the store it was promoted FROM does not, which is what the promotion is for.
    expect(
      checkChangelog({
        changelog: assembleChangelog(index, [FIRST]),
        upgrading,
        taggedVersion: '2.0.0',
      }).map((gap) => gap.kind),
    ).toContain('unreleased-breaking');
  });

  test('no [Unreleased] heading is a refusal, never a guess', () => {
    const bare = '# Changelog\n\n## Releases\n';
    const result = promoteUnreleased({
      index: bare,
      changelog: assembleChangelog(bare, [FIRST]),
      version: '2.0.0',
      date: '2026-08-20',
      subjects: [],
    });
    expect('findings' in result && result.findings[0]?.code).toBe('X_RELEASE_UNRELEASED_MISSING');
  });

  test('nothing to say is a refusal too, so no release ships an empty section', () => {
    const empty = '# Changelog\n\n## [Unreleased]\n\nNothing yet.\n\n## Releases\n';
    const result = promoteUnreleased({
      index: empty,
      changelog: assembleChangelog(empty, [FIRST]),
      version: '1.0.1',
      date: '2026-08-20',
      subjects: [],
    });
    expect('findings' in result && result.findings[0]?.code).toBe(
      'X_DOC_CHANGELOG_SECTION_INVALID',
    );
  });

  // 93443aeb is a human writing a version's section by hand after a botched release, which is the
  // shape this refuses: the version already has its file, so promotion would write a SECOND one —
  // the two-sections-per-version defect the promotion rewrite was for, one step further along.
  // Refused here, so it happens before the 47 manifests move.
  test('a version the changelog already holds is a refusal, not a second section', () => {
    const held: ChangelogFile = {
      path: 'docs/changelog/6.0.0.md',
      text: '## 6.0.0 - 2026-08-19\n\n- released by hand\n',
    };
    const result = promoteUnreleased({
      index,
      changelog: assembleChangelog(index, [held, FIRST]),
      version: '6.0.0',
      date: '2026-08-20',
      subjects: ['fix(cli): a thing'],
    });
    expect('findings' in result && result.findings[0]?.code).toBe(
      'X_DOC_CHANGELOG_SECTION_INVALID',
    );
    expect('findings' in result && result.findings[0]?.at).toBe('docs/changelog/6.0.0.md:1');
    expect('file' in result).toBe(false);
  });

  // The refusal is about the TARGET version only — an unrelated release file is not one.
  test('a different version already in docs/changelog/ still promotes', () => {
    const out = promote(START, '2.0.0');
    expect(out.files.filter((file) => file.path.endsWith('/2.0.0.md')).length).toBe(1);
  });

  test('an empty subject list adds no heading at all', () => {
    expect(commitBlock([])).toEqual([]);
  });
});
