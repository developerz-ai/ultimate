// Every brief `.dz/maintainer/maintainer.yml` schedules is one the platform can run: it fits the
// cap with the header the platform prepends (an over-cap brief is refused at every due firing,
// #1170), and a scout brief declares `## Rows` (a rowless one fires and can file nothing).

import { describe, expect, setDefaultTimeout, test } from 'bun:test';
// why: Bun ships no path-join primitive; Bun.file takes one already joined.
import { join } from 'node:path';
import { briefRowsOf, headedBrief } from './brief-rows';
import { REPO_SCAN_TIMEOUT_MS, repoRoot } from './run';

// Reads the maintainer schedule and every brief it names from the tree.
setDefaultTimeout(REPO_SCAN_TIMEOUT_MS);

/** The scheduled-checkup platform's ceiling, in characters (the refusal counts them, not bytes). */
const BRIEF_CAP = 10_000;

/** Room under the cap for an edit that does not re-run this test, or a longer header. */
const SPARE = 100;

/** The repository the header line names: the one whose policy holds the schedules. */
const REPO = 'developerz-ai/ultimate';

const MAINTAINER = '.dz/maintainer/maintainer.yml';

interface Schedule {
  readonly name: string;
  readonly brief_file: string;
  /** Absent = a scout checkup; `devops` files through its own PR and owes no rows. */
  readonly mode?: string;
}

const schedules = async (): Promise<readonly Schedule[]> => {
  const policy = Bun.YAML.parse(await Bun.file(join(repoRoot(), MAINTAINER)).text()) as {
    readonly schedules?: readonly Schedule[];
  };
  return policy.schedules ?? [];
};

const brief = (path: string): Promise<string> => Bun.file(join(repoRoot(), path)).text();

describe('unit · a scheduled brief is one the platform can run', () => {
  test('the schedule names its briefs, so the rules have subjects', async () => {
    const files = (await schedules()).map((schedule) => schedule.brief_file);
    expect(files).toContain('.dz/briefs/improve.md');
    expect(files).toContain('.dz/briefs/release-due.md');
  });

  // was: a flat 100-character header reserve; the header carries every row id, ~380 for health.
  test('every one is at most BRIEF_CAP - SPARE characters, its header included', async () => {
    const over: string[] = [];
    for (const { brief_file: path } of await schedules()) {
      // Characters, as the refusal counts them: a byte length overcounts every non-ASCII dash.
      const length = [...headedBrief(REPO, path, await brief(path))].length;
      if (length > BRIEF_CAP - SPARE)
        over.push(
          `${path}: ${String(length)} characters with its header, cap ${String(BRIEF_CAP - SPARE)}`,
        );
    }
    expect(over).toEqual([]);
  });

  test('every scout brief declares `## Rows`', async () => {
    const rowless: string[] = [];
    for (const schedule of await schedules()) {
      if (schedule.mode === 'devops') continue;
      if (briefRowsOf(await brief(schedule.brief_file)).length === 0)
        rowless.push(`${schedule.name}: ${schedule.brief_file}`);
    }
    expect(rowless).toEqual([]);
  });
});
