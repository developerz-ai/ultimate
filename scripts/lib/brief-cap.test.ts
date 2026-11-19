// Every brief `.dz/maintainer/maintainer.yml` schedules fits the platform's cap: a brief over it is
// refused at every due firing, so its checkup runs nothing (#1170). `health.md` alone was held to
// it, and `release-due.md` drifted to 10,574 characters unseen.

import { describe, expect, setDefaultTimeout, test } from 'bun:test';
// why: Bun ships no path-join primitive; Bun.file takes one already joined.
import { join } from 'node:path';
import { REPO_SCAN_TIMEOUT_MS, repoRoot } from './run';

// Reads the maintainer schedule and every brief it names from the tree.
setDefaultTimeout(REPO_SCAN_TIMEOUT_MS);

/** The scheduled-checkup platform's ceiling, in characters (the refusal counts them, not bytes). */
const BRIEF_CAP = 10_000;

/**
 * The header the platform prepends before it counts: a 9,984-character `health.md` was measured at
 * 10,065 with it (PR #1274's review, 2026-11-19), so a brief that fits the bare cap could still be
 * refused on every tick. 100 holds that 81 with room.
 */
const HEADER_RESERVE = 100;

const MAINTAINER = '.dz/maintainer/maintainer.yml';

const scheduledBriefs = async (): Promise<readonly string[]> =>
  [
    ...(await Bun.file(join(repoRoot(), MAINTAINER)).text()).matchAll(
      /^\s*brief_file:\s*(\S+)\s*$/gm,
    ),
  ]
    .map((match) => match[1] ?? '')
    .sort();

describe('unit · a scheduled brief fits the platform cap', () => {
  test('the schedule names its briefs, so the rule has subjects', async () => {
    const briefs = await scheduledBriefs();
    expect(briefs).toContain('.dz/briefs/health.md');
    expect(briefs).toContain('.dz/briefs/release-due.md');
  });

  // was: "every one is at most BRIEF_CAP characters" — the platform's header counts too.
  test('every one is at most BRIEF_CAP characters, its header included', async () => {
    const over: string[] = [];
    for (const path of await scheduledBriefs()) {
      // Characters, as the refusal counts them: a byte length overcounts every non-ASCII dash.
      const length = [...(await Bun.file(join(repoRoot(), path)).text())].length;
      if (length > BRIEF_CAP - HEADER_RESERVE)
        over.push(
          `${path}: ${String(length)} characters, cap ${String(BRIEF_CAP - HEADER_RESERVE)} before the platform's header`,
        );
    }
    expect(over).toEqual([]);
  });
});
