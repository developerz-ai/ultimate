// A withheld guard's measured count, merged into `x.verify.json` as `guardBaseline` so the hop can
// keep it on disk at that count (`verify-guard-baseline.ts` judges it). The app's own keys are never
// touched: a baseline it already wrote for that guard, or a file that is not a JSON object, refuses.

// why: Bun exposes no path-join primitive; `x.verify.json` sits at the app root.
import { join } from 'node:path';
import { isJsonObject } from '@ultimat3/core';
import { parseJson } from './upgrade-registry';
import { VERIFY_FLOOR_FILE } from './verify-floor';
import { GUARD_BASELINE_FIELD } from './verify-guard-baseline';

/** The floor's bytes before the write, or null when there was no file: what a rollback restores. */
export type FloorPrior = string | null;

/**
 * Writes `guardBaseline[name] = findings`; the prior bytes, or undefined when it refused. No file
 * is a floor requiring no step, so the one written changes nothing but the baseline.
 */
export async function writeGuardBaseline(
  root: string,
  name: string,
  findings: number,
): Promise<{ readonly prior: FloorPrior } | undefined> {
  const file = Bun.file(join(root, VERIFY_FLOOR_FILE));
  const prior = (await file.exists()) ? await file.text() : null;
  const payload = prior === null ? { steps: [] } : parseJson(prior);
  if (!isJsonObject(payload)) return undefined;
  const current = payload[GUARD_BASELINE_FIELD];
  if (current !== undefined && !isJsonObject(current)) return undefined;
  if (current !== undefined && Object.hasOwn(current, name)) return undefined;
  const next = { ...payload, [GUARD_BASELINE_FIELD]: { ...(current ?? {}), [name]: findings } };
  await Bun.write(file, `${JSON.stringify(next, null, 2)}\n`);
  return { prior };
}

/** Puts the floor back as it was: rewritten, or deleted when the write created it. */
export async function restoreFloor(root: string, prior: FloorPrior): Promise<void> {
  const file = Bun.file(join(root, VERIFY_FLOOR_FILE));
  if (prior !== null) await Bun.write(file, prior);
  else if (await file.exists()) await file.delete();
}
