// The next major bump, simulated on the committed files: [Unreleased] promoted to the next major
// on the day its window allows, wiki/Stability.md rewritten as the bump rewrites it, and every
// stability rule run over the result. The audit found the v30 bump red on its own gate; this is
// the test that would have said so before the release PR did.

import { describe, expect, setDefaultTimeout, test } from 'bun:test';
import { checkChangelog } from './changelog-check';
import { highlightFindings } from './lib/changelog-highlights';
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

function seeded(changelog: string): string {
  return changelog.replace(/^## \[Unreleased\]\n+Nothing yet\.\n/m, `## [Unreleased]\n\n${SEED}\n`);
}

describe('the next major bump of the committed tree', () => {
  test('passes every stability rule and the changelog shape rules once promoted', async () => {
    const root = repoRoot();
    const changelog = seeded(await Bun.file(`${root}/CHANGELOG.md`).text());
    const upgrading = await Bun.file(`${root}/wiki/Upgrading.md`).text();
    const page = await Bun.file(`${root}/${STABILITY_PATH}`).text();
    const current = publishOrder(await listWorkspaces(root))[0]?.version ?? '0.0.0';
    const version = nextVersion(current, 'major');
    const opensOn = nextMajorWindow(changelog)?.opensOn;
    const today = todayUtc();
    const date = opensOn !== undefined && opensOn > today ? opensOn : today;

    expect(bumpWindowFindings({ version, changelog, today: date, security: undefined })).toEqual(
      [],
    );
    const promoted = promoteUnreleased({ changelog, version, date, subjects: [] });
    if ('findings' in promoted) expect.unreachable('[Unreleased] could not be promoted');
    const written = withNextWindowLine(page, promoted.changelog);
    expect({
      highlights: highlightFindings(promoted.changelog),
      changelog: stabilityChangelogFindings(promoted.changelog, {}, date),
      page: stabilityPageFindings(written, promoted.changelog),
      // The shape rules a bump can break. The Upgrading row counts are the release commit's own
      // hand edit (the in-flight row is renamed to the version), so they are not judged here.
      shape: checkChangelog({ changelog: promoted.changelog, upgrading, taggedVersion: version })
        .map((gap) => gap.kind)
        .filter((kind) =>
          ['duplicate', 'empty', 'commits-only', 'unreleased-breaking'].includes(kind),
        ),
    }).toEqual({ highlights: [], changelog: [], page: [], shape: [] });
  });
});
