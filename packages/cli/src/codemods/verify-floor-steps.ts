// 31.28.0: x.verify.json floors every step the scaffold floors for an app like this one (the list
// is `floorSteps`, never restated here), so none is `X_VERIFY_STEP_UNFLOORED`; and once the floor
// names every gate step — required or excused — `strict` goes on. Short of that, `strict: false`
// is written once with a note: a decision recorded, not a question asked on every upgrade.

import { isJsonObject } from '@ultimat3/core';
import { floorSteps } from '../templates/scaffold-verify-floor';
import { VERIFY_FLOOR_FILE } from '../verify-floor';
import { VERIFY_STEP_NAMES } from '../verify-step';
import type { Codemod, CodemodResult } from './codemod';
import { unifiedDiff } from './engine-diff';
import type { Floor } from './verify-floor-skips';
import { floorSuites, renderFloor } from './verify-floor-skips';

const NOTHING: CodemodResult = { changed: [], skipped: [] };

/** The scaffold's order for every step it floors, then the app's own steps in theirs. */
const ordered = (
  held: readonly unknown[],
  wanted: readonly string[],
  added: readonly string[],
): readonly unknown[] => [
  ...wanted.filter((step) => held.includes(step) || added.includes(step)),
  ...held.filter((step) => typeof step !== 'string' || !wanted.includes(step)),
];

/** `floor` with `strict` set, placed after `skip` (or `steps`) as the scaffold writes it. */
function withStrict(floor: Floor, strict: boolean): Floor {
  const anchor = 'skip' in floor ? 'skip' : 'steps';
  const out: Floor = {};
  for (const [key, value] of Object.entries(floor)) {
    if (key === 'strict') continue;
    out[key] = value;
    if (key === anchor) out['strict'] = strict;
  }
  if (!('strict' in out)) out['strict'] = strict;
  return out;
}

export const codemod: Codemod = {
  id: 'verify-floor-steps',
  since: '31.28.0',
  summary: `${VERIFY_FLOOR_FILE} floors every step the scaffold floors, and is strict once it names the whole gate`,
  async run(app) {
    const source = await app.read(VERIFY_FLOOR_FILE);
    if (source === undefined) return NOTHING;
    let floor: unknown;
    try {
      floor = JSON.parse(source);
    } catch {
      return NOTHING;
    }
    // `verify-floor-skips` already reports a floor that is not a JSON object.
    if (!isJsonObject(floor) || !Array.isArray(floor['steps'])) return NOTHING;
    const held: unknown[] = floor['steps'];
    const skip = isJsonObject(floor['skip']) ? floor['skip'] : {};
    const wanted = floorSteps(await floorSuites(app)).steps;
    const added = wanted.filter((step) => !held.includes(step) && !(step in skip));
    // `steps` replaced where it stands: the app's key order kept.
    let next: Floor =
      added.length === 0
        ? floor
        : Object.fromEntries(
            Object.entries(floor).map(([key, value]) => [
              key,
              key === 'steps' ? ordered(held, wanted, added) : value,
            ]),
          );
    const skipped: CodemodResult['skipped'][number][] = [];
    if (next['strict'] === undefined) {
      const named = new Set([...(next['steps'] as unknown[]), ...Object.keys(skip)]);
      const unnamed = VERIFY_STEP_NAMES.filter((step) => !named.has(step));
      next = withStrict(next, unnamed.length === 0);
      if (unnamed.length > 0) {
        skipped.push({
          path: VERIFY_FLOOR_FILE,
          reason: `"strict": false recorded, once: ${unnamed.join(', ')} is in neither "steps" nor "skip", so strict would be red where those run nothing. Run x verify --json, give each its place, then set "strict": true`,
          diff: unifiedDiff(
            VERIFY_FLOOR_FILE,
            renderFloor(next),
            renderFloor(withStrict(next, true)),
          ),
        });
      }
    }
    const text = renderFloor(next);
    if (text === source) return { changed: [], skipped };
    await app.write(VERIFY_FLOOR_FILE, text);
    return { changed: [VERIFY_FLOOR_FILE], skipped };
  },
};
