// 31.27.0: a scaffold's x.verify.json names every gate step — required in `steps`, or excused in
// `skip` with its why — and sets `strict`. An older app gains the `skip` rows that hold for it
// (roadmap; job with no job suite; e2e with no page); `strict` it opts into itself, after a run.

import { floorSteps } from '../templates/scaffold-verify-floor';
import { VERIFY_FLOOR_FILE } from '../verify-floor';
import type { Codemod, CodemodApp } from './codemod';
import { unifiedDiff } from './engine-diff';

type Floor = Record<string, unknown>;

const isObject = (value: unknown): value is Floor =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const any = async (app: CodemodApp, pattern: string): Promise<boolean> =>
  (await app.glob(pattern)).length > 0;

/** The steps that cannot run in this app, each with the scaffold's own why. */
async function excused(app: CodemodApp): Promise<Readonly<Record<string, string>>> {
  const jobs = await any(app, '{apps,packages}/**/*.job.test.ts');
  const pages = await any(app, 'apps/*/{site,app}/**/page.tsx');
  const why = floorSteps({ jobs: false, pages: false }).skip;
  const out: Record<string, string> = {};
  if (!jobs && why.job !== undefined) out['job'] = why.job;
  if (!pages && why.e2e !== undefined) out['e2e'] = why.e2e;
  if (!(await app.exists('docs/idea/14-roadmap.md')) && why.roadmap !== undefined) {
    out['roadmap'] = why.roadmap;
  }
  return out;
}

/** `floor` with `skip` merged in, placed right after `steps` as the scaffold writes it. */
function withSkip(floor: Floor, skip: Readonly<Record<string, string>>): Floor {
  const merged = { ...(isObject(floor['skip']) ? floor['skip'] : {}), ...skip };
  const out: Floor = {};
  for (const [key, value] of Object.entries(floor)) {
    if (key === 'skip') continue;
    out[key] = value;
    if (key === 'steps') out['skip'] = merged;
  }
  if (!('skip' in out)) out['skip'] = merged;
  return out;
}

const render = (floor: Floor): string => `${JSON.stringify(floor, null, 2)}\n`;

export const codemod: Codemod = {
  id: 'verify-floor-skips',
  since: '31.27.0',
  summary: `${VERIFY_FLOOR_FILE} excuses the gate steps this app cannot run (roadmap; job, e2e where it has none), each with its why`,
  async run(app) {
    const source = await app.read(VERIFY_FLOOR_FILE);
    if (source === undefined) return { changed: [], skipped: [] };
    let floor: unknown;
    try {
      floor = JSON.parse(source);
    } catch {
      floor = undefined;
    }
    if (!isObject(floor)) {
      return {
        changed: [],
        skipped: [
          { path: VERIFY_FLOOR_FILE, reason: 'it is not a JSON object, so no row was added to it' },
        ],
      };
    }
    const steps = Array.isArray(floor['steps']) ? floor['steps'] : [];
    const held = isObject(floor['skip']) ? floor['skip'] : {};
    const add = Object.fromEntries(
      Object.entries(await excused(app)).filter(
        ([step]) => !steps.includes(step) && !(step in held),
      ),
    );
    const next = Object.keys(add).length === 0 ? floor : withSkip(floor, add);
    const changed: string[] = [];
    if (Object.keys(add).length > 0) {
      await app.write(VERIFY_FLOOR_FILE, render(next));
      changed.push(VERIFY_FLOOR_FILE);
    }
    if (floor['strict'] !== undefined) return { changed, skipped: [] };
    // Never flipped here: a step that ran nothing would be red on the very next gate. Said instead.
    return {
      changed,
      skipped: [
        {
          path: VERIFY_FLOOR_FILE,
          reason:
            'strict left off: a step that runs nothing would turn red under it. Run x verify --json, add each step it reports skipped to "skip" with its why, then set "strict": true',
          diff: unifiedDiff(VERIFY_FLOOR_FILE, render(next), render({ ...next, strict: true })),
        },
      ],
    };
  },
};
