// `doc-unreleased.ts`: each phrase against a page that carries it, at a release and between
// releases, the `main`-cell rewrite `release.ts --bump` performs, then the committed tree.

import { describe, expect, setDefaultTimeout, test } from 'bun:test';
import {
  atRelease,
  checkUnreleasedPhrases,
  docUnreleasedFindings,
  rewriteMainCells,
  unreleasedPhrases,
} from './doc-unreleased';
import { REPO_SCAN_TIMEOUT_MS, repoRoot } from './lib/run';

setDefaultTimeout(REPO_SCAN_TIMEOUT_MS);

const PENDING = '# Changelog\n\n## [Unreleased]\n\n### Fixed\n\n- a fix\n\n## 1.0.0 - 2026-01-01\n';
const RELEASED = '# Changelog\n\n## [Unreleased]\n\n## 1.1.0 - 2026-02-01\n\n- a fix\n';

const lines = (path: string, text: string): readonly string[] =>
  unreleasedPhrases(path, text).map((one) => `${one.line} ${one.phrase}`);

describe('the phrases', () => {
  test('As of Unreleased, not yet tagged, and a claim about the next major', () => {
    const text = [
      '`As of Unreleased`. a thing',
      'in the tree, not yet tagged',
      'The next major closes it.',
      'this default flips in the next major',
    ].join('\n');
    expect(lines('wiki/A.md', text)).toEqual([
      '1 As of Unreleased',
      '2 not yet tagged',
      '3 next major closes',
      '4 flips in the next major',
    ]);
  });

  test('x upgrade’s own words about an app’s next major are not a claim about this repo', () => {
    const text = "`--to`: an exact release in the next major; the next major's newest";
    expect(lines('wiki/CLI-Reference.md', text)).toEqual([]);
  });

  test('a `main` cell counts on Known-Gaps alone, and a fenced line never', () => {
    const row = '| A gap | `main` | the workaround |';
    expect(lines('wiki/Known-Gaps.md', row)).toEqual(['1 `main` cell']);
    expect(lines('wiki/Other.md', row)).toEqual([]);
    expect(lines('wiki/A.md', '```\nAs of Unreleased\n```')).toEqual([]);
  });
});

describe('when the rule applies', () => {
  test('at a release commit or with [Unreleased] empty, never between releases', () => {
    expect(atRelease(PENDING, undefined)).toBe(false);
    expect(atRelease(PENDING, '1.0.0')).toBe(true);
    expect(atRelease(RELEASED, undefined)).toBe(true);
  });

  test('between releases a phrase is allowed; at a release it is X_DOC_UNRELEASED_STALE', () => {
    const pages = [{ path: 'wiki/A.md', text: 'x\n`As of Unreleased`.' }];
    expect(checkUnreleasedPhrases({ changelog: PENDING, pages })).toEqual([]);
    const [finding] = checkUnreleasedPhrases({ changelog: RELEASED, pages });
    expect(finding?.code).toBe('X_DOC_UNRELEASED_STALE');
    expect(finding?.at).toBe('wiki/A.md:2');
    expect(finding?.fix).toContain('bun run scripts/release.ts --bump');
  });
});

describe('rewriteMainCells', () => {
  test('stamps each `main` cell with the version, and nothing else', () => {
    const page = '| A | `main` | w |\n| B | **2.0.0** | w |\nfixed on `main` is prose';
    expect(rewriteMainCells(page, '3.0.0')).toEqual({
      text: '| A | **3.0.0** | w |\n| B | **2.0.0** | w |\nfixed on `main` is prose',
      moved: 1,
    });
  });
});

describe('the release wiring', () => {
  test('release.ts --bump rewrites the Known-Gaps cells in the step that promotes the changelog', async () => {
    const source = await Bun.file(`${repoRoot()}/scripts/release.ts`).text();
    const stamp = source.slice(source.indexOf('stampReleaseFiles(root, ['));
    expect(stamp).toContain("path: join(root, 'wiki/Known-Gaps.md')");
    expect(stamp.slice(0, stamp.indexOf(']);'))).toContain('rewriteMainCells(raw, version)');
  });
});

describe('the committed tree', () => {
  test('carries no stale phrase at its own release state', async () => {
    expect(await docUnreleasedFindings(repoRoot())).toEqual([]);
  });
});
