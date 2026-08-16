// The step tables and gated-app values every `reference-app-gate*.test.ts` builds its world from.
// One declaration rather than one per file: four suites assert about the same ratchet from four
// angles, and a `step()` that means something slightly different in each of them is a suite that
// agrees with itself by accident.

import type { GatedApp } from './lib/gated-apps';
import type { GateStep } from './reference-app-gate';

export const step = (name: string, ok: boolean, skipped = false): GateStep => ({
  name,
  ok,
  skipped,
  findings: [],
});

/** Two pinned steps, so a test can tell "the pin held" from "nothing was pinned at all". */
export const pin = { typecheck: 'owned elsewhere', drift: 'owned elsewhere' } as const;

export const appWith = (
  expectedRed: Readonly<Record<string, string>>,
  dir = 'examples/dummy',
): GatedApp => ({ dir, reference: `./${dir}`, expectedRed }) satisfies GatedApp;

export const app = appWith(pin);

/** Each test's `steps` array IS its declared world — deriving `declaredSteps` from it rather than
 * hand-listing a second copy means it can never drift from what the test actually constructs. */
export const namesOf = (steps: readonly GateStep[]): readonly string[] =>
  steps.map((entry) => entry.name);
