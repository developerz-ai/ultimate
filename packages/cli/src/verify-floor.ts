// The suite ratchet: the steps this repo has already proved it can run, committed as a floor.
// `applies` answers "is there anything to check here?", and a deleted suite answers "no" — which
// reads as a skip and keeps the gate green. The floor turns that skip back into a failure. Read
// here and written by nothing: a gate that edits its own floor ratchets both ways, which is none.

// Bun ships no equivalent for either: `existsSync` answers whether this root committed a floor at
// all, and `join` builds the host-separator path to it.
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { docsFor } from './error-codes';
import type { Finding } from './output';
import { VERIFY_STEP_NAMES } from './verify-step';

/** Hand-written and committed, beside the generated `x.manifest.json` the same gate reads. */
export const VERIFY_FLOOR_FILE = 'x.verify.json';

export interface VerifyFloor {
  /** Declared step names this run may not report as skipped. */
  readonly steps: readonly string[];
  /** Why part of the file is not a floor. The `manifest` step reports these; nothing swallows them. */
  readonly problems: readonly string[];
}

const asRecord = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;

/**
 * The file's names, split into the ones the ratchet can enforce and the reasons the rest cannot be.
 * A name no step declares is dropped rather than enforced — it can never apply, so enforcing it
 * would pin the gate red forever — and it is returned as a problem, because a floor with a typo in
 * it silently covers nothing, which is the same false green the floor exists to close.
 *
 * `declared` is a parameter rather than the imported constant at the call site, so a test can pin a
 * closed world instead of asserting against every step this build happens to ship.
 */
export function parseVerifyFloor(
  text: string,
  declared: readonly string[] = VERIFY_STEP_NAMES,
): VerifyFloor {
  let payload: unknown;
  try {
    payload = JSON.parse(text);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return { steps: [], problems: [`it does not parse as JSON (${reason})`] };
  }
  const steps = asRecord(payload)?.['steps'];
  if (!Array.isArray(steps)) {
    return { steps: [], problems: ['it has no "steps" array of step names'] };
  }
  const named = steps.filter((step): step is string => typeof step === 'string');
  const unknown = named.filter((step) => !declared.includes(step));
  return {
    steps: named.filter((step) => declared.includes(step)),
    problems: [
      ...(named.length === steps.length ? [] : ['"steps" holds an entry that is not a string']),
      ...(unknown.length === 0
        ? []
        : [`"steps" names ${unknown.join(', ')}, which x verify does not run`]),
    ],
  };
}

/** No file is no floor: a repo that never committed one is not ratcheted, and reports nothing. */
export async function readVerifyFloor(root: string): Promise<VerifyFloor | undefined> {
  const path = join(root, VERIFY_FLOOR_FILE);
  if (!existsSync(path)) return undefined;
  const text = await Bun.file(path)
    .text()
    .catch(() => undefined);
  if (text === undefined) return { steps: [], problems: ['it could not be read as a file'] };
  return parseVerifyFloor(text);
}

/** Whether the floor already claims this step has something to check in this repo. */
export const floorRequires = (floor: VerifyFloor | undefined, step: string): boolean =>
  floor?.steps.includes(step) === true;

/**
 * A step the floor requires that found nothing to run. Named for what happened rather than for the
 * file — the suite is what vanished — and the fix carries both edits that resolve it, because
 * either can be right: the suite comes back, or the floor drops a line in a commit that says why.
 */
export const vanishedSuiteFinding = (step: string): Finding => ({
  code: 'X_VERIFY_SUITE_VANISHED',
  cause: `${VERIFY_FLOOR_FILE} requires the ${step} step and this run found nothing for it to check`,
  fix: `restore the ${step} suite, or delete "${step}" from ${VERIFY_FLOOR_FILE} in the commit that says why — then: x verify --json`,
  docs: docsFor('X_VERIFY_SUITE_VANISHED'),
  at: VERIFY_FLOOR_FILE,
});

/**
 * The floor file's own integrity, as findings. `X_CONFIG_INVALID` rather than a second code of this
 * package's own: a committed file the framework reads and cannot use is exactly what core already
 * named, and a floor that enforces nothing is not a vanished suite.
 */
export const floorProblemFindings = (floor: VerifyFloor | undefined): readonly Finding[] =>
  (floor?.problems ?? []).map((problem) => ({
    code: 'X_CONFIG_INVALID',
    cause: `${VERIFY_FLOOR_FILE} is not a suite floor: ${problem}`,
    fix: `write ${VERIFY_FLOOR_FILE} as {"steps":["unit","contract"]}, naming only steps the gate runs — x verify --json lists every one`,
    docs: docsFor('X_CONFIG_INVALID'),
    at: VERIFY_FLOOR_FILE,
  }));
