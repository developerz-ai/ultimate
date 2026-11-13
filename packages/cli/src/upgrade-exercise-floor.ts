// A hop's exercise ratchet: after the hop's `x exercise` wrote `.x/exercise.json`, an app whose
// `x.verify.json` states no `exercise.unprovenMax` / `statementsMax` gets the figures that pass
// measured, so the floor starts where the app is and only falls. A key the app already wrote is
// never touched. Written into the hop's diff and reported, never silently.

// why: Bun exposes no path-join primitive; `x.verify.json` sits at the app root.
import { join } from 'node:path';
import type { ExerciseFloor } from './exercise-floor';
import { readExerciseFloor } from './exercise-floor';
import {
  exerciseReportStamp,
  measuredExerciseFloor,
  withExerciseFloor,
} from './exercise-floor-report';
import { parseJson } from './upgrade-registry';
import { VERIFY_FLOOR_FILE } from './verify-floor';

/** What the report carries: the figures written, each one the hop's own pass measured. */
export interface HopExerciseFloor {
  readonly file: string;
  readonly written: ExerciseFloor;
}

/**
 * Writes the measured figure for each exercise key the floor file lacks; null when none. `before`
 * is the report's stamp ahead of the hop's `x exercise`: a report that pass did not rewrite (it
 * died, or is a CLI with no report) holds another pass's figures and is never ratcheted.
 */
export async function ratchetExerciseFloor(
  root: string,
  before: number | undefined,
): Promise<HopExerciseFloor | null> {
  const after = await exerciseReportStamp(root);
  if (after === undefined || after === before) return null;
  const file = Bun.file(join(root, VERIFY_FLOOR_FILE));
  if (!(await file.exists())) return null;
  const text = await file.text();
  const payload = parseJson(text);
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) return null;
  const stated = readExerciseFloor(payload as Record<string, unknown>);
  // A malformed key is the `manifest` step's finding; writing beside it would hide it.
  if (stated.problems.length > 0) return null;
  const measured = await measuredExerciseFloor(root);
  if (measured === undefined) return null;
  const written: { unprovenMax?: number; statementsMax?: number } = {};
  if (stated.floor?.unprovenMax === undefined) written.unprovenMax = measured.unprovenMax;
  if (stated.floor?.statementsMax === undefined) written.statementsMax = measured.statementsMax;
  if (Object.keys(written).length === 0) return null;
  const next = withExerciseFloor(text, written);
  if (next === text) return null;
  await Bun.write(join(root, VERIFY_FLOOR_FILE), next);
  return { file: VERIFY_FLOOR_FILE, written };
}
