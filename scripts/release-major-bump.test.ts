// The next major bump, simulated on the committed files: [Unreleased] promoted to the next major
// on the day its window allows, wiki/Stability.md rewritten as the bump rewrites it, and every
// stability rule run over the result. The audit found the v30 bump red on its own gate; this is
// the test that would have said so before the release PR did.

import { describe, expect, setDefaultTimeout, test } from 'bun:test';
import { checkChangelog } from './changelog-check';
import { highlightFindings } from './lib/changelog-highlights';
import { indexFindings } from './lib/changelog-index';
import { parseChangelog } from './lib/changelog-sections';
import { assembleChangelog, readChangelogFiles } from './lib/changelog-store';
import { bumpWindowFindings, nextMajorWindow } from './lib/major-window';
import { promoteUnreleased } from './lib/release-changelog';
import { nextVersion } from './lib/release-version';
import { REPO_SCAN_TIMEOUT_MS, repoRoot } from './lib/run';
import {
  STABILITY_PATH,
  stabilityChangelogFindings,
  stabilityPageFindings,
  todayUtc,
  withNextWindowLine,
} from './lib/stability-findings';
import { listWorkspaces, publishOrder } from './lib/workspaces';

setDefaultTimeout(REPO_SCAN_TIMEOUT_MS);

// Right after a release `[Unreleased]` holds nothing, and promoting nothing is refused. Seed one
// breaking entry in the shape the next major will carry, so the rules below still run every day.
const SEED = [
  '### Highlights',
  '',
  '- The next major, seeded by this test.',
  '',
  '### Changed',
  '',
  '- **BREAKING — (#1) `@ultimat3/core`: a seeded entry.** Nothing ships it.',
].join('\n');

const HIGHLIGHT = ['### Highlights', '', '- The next major, seeded by this test.', ''].join('\n');

/**
 * [Unreleased] as the release commit would promote it. Empty: the whole SEED. Real entries with
 * no `### Highlights`: one seeded bullet above them — the bump's author writes the real ones, so
 * a contributor's entry is never what turns this red.
 */
function seeded(index: string): string {
  const empty = /^## \[Unreleased\]\n+Nothing yet\.\n/m;
  if (empty.test(index)) return index.replace(empty, `## [Unreleased]\n\n${SEED}\n`);
  const body = /^## \[Unreleased\]\n+([\s\S]*?)(?=^## )/m.exec(index)?.[1] ?? '';
  if (/^### Highlights$/m.test(body)) return index;
  return index.replace(/^## \[Unreleased\]\n+/m, `## [Unreleased]\n\n${HIGHLIGHT}\n`);
}

/** `index` with its [Unreleased] body replaced by `body`: what a contributor's PR leaves there. */
function withUnreleased(index: string, body: string): string {
  return index.replace(/^## \[Unreleased\]\n[\s\S]*?(?=^## )/m, `## [Unreleased]\n\n${body}\n\n`);
}

/** Every rule the bump runs, over `rawIndex` promoted to the next major on its window's day. */
async function bumpFindings(rawIndex: string) {
  const root = repoRoot();
  const read = await readChangelogFiles(root);
  const index = seeded(rawIndex);
  const changelog = assembleChangelog(index, read.files);
  const upgrading = await Bun.file(`${root}/wiki/Upgrading.md`).text();
  const page = await Bun.file(`${root}/${STABILITY_PATH}`).text();
  const current = publishOrder(await listWorkspaces(root))[0]?.version ?? '0.0.0';
  const version = nextVersion(current, 'major');
  const opensOn = nextMajorWindow(changelog)?.opensOn;
  const today = todayUtc();
  const date = opensOn !== undefined && opensOn > today ? opensOn : today;

  expect(bumpWindowFindings({ version, changelog, today: date, security: undefined })).toEqual([]);
  const promoted = promoteUnreleased({ index, changelog, version, date, subjects: [] });
  if ('findings' in promoted) return expect.unreachable('[Unreleased] could not be promoted');
  const written = withNextWindowLine(page, promoted.changelog);
  return {
    highlights: highlightFindings(parseChangelog(promoted.file.text, promoted.file.path)),
    index: indexFindings(promoted.index, [...read.files, promoted.file]),
    changelog: stabilityChangelogFindings(promoted.changelog, {}, date),
    page: stabilityPageFindings(written, promoted.changelog),
    // The shape rules a bump can break. The Upgrading row counts are the release commit's own
    // hand edit (the in-flight row is renamed to the version), so they are not judged here.
    shape: checkChangelog({ changelog: promoted.changelog, upgrading, taggedVersion: version })
      .map((gap) => gap.kind)
      .filter((kind) =>
        ['duplicate', 'empty', 'commits-only', 'unreleased-breaking'].includes(kind),
      ),
  };
}

const CLEAN = { highlights: [], index: [], changelog: [], page: [], shape: [] };

describe('the next major bump of the committed tree', () => {
  test('passes every stability rule and the changelog shape rules once promoted', async () => {
    expect(await bumpFindings((await readChangelogFiles(repoRoot())).index)).toEqual(CLEAN);
  });

  // Highlights are the release commit's to write: a contributor's Fixed entry under [Unreleased]
  // turned this red (X_CHANGELOG_HIGHLIGHTS_MISSING) for a gap no PR before the bump can owe.
  test('a contributor`s [Unreleased] with no Highlights is still a bump that passes', async () => {
    const index = withUnreleased(
      (await readChangelogFiles(repoRoot())).index,
      '### Fixed\n\n- `@ultimat3/core`: a contributor`s fix, seeded by this test.',
    );
    expect(index).not.toContain('### Highlights');
    expect(await bumpFindings(index)).toEqual(CLEAN);
  });
});
