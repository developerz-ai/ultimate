// The suite ratchet: the steps this repo has already proved it can run, committed as a floor.
// `applies` answers "is there anything to check here?", and a deleted suite answers "no" — which
// reads as a skip and keeps the gate green. The floor turns that skip back into a failure. Read
// here and written by nothing: a gate that edits its own floor ratchets both ways, which is none.

// Bun ships no equivalent for either: `existsSync` answers whether this root committed a floor at
// all, and `join` builds the host-separator path to it.
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { ERROR_DOCS_URL, renderThrowable } from '@ultimat3/core';
import { AGENTS_MD_MAX_BYTES } from '@ultimat3/manifest';
import type { Finding } from './output';
import { VERIFY_STEP_NAMES } from './verify-step';

/** Hand-written and committed, beside the generated `x.manifest.json` the same gate reads. */
export const VERIFY_FLOOR_FILE = 'x.verify.json';

export interface VerifyFloor {
  /** Declared step names this run may not report as skipped. */
  readonly steps: readonly string[];
  /**
   * This repository's `AGENTS.md` budget, in bytes, when it declares one. `@ultimat3/manifest`
   * has always taken a `maxBytes` and the gate never passed one, so the 12kB default was the only
   * budget an app could have — and an app whose conventions genuinely need more had no move left
   * but to delete a rule to make room, which is the opposite of what the budget is for.
   *
   * It is here rather than in `x.config.ts` because this is the file that configures the GATE,
   * and it is read by the very step that enforces the budget. Raising it is a commit a reviewer
   * sees, which is the whole safeguard: the number is small, visible, and argued for in one place.
   */
  readonly agentsMdMaxBytes?: number;
  /**
   * The binary the `typecheck` step invokes in place of `tsc` — `bunx <typecheckBin> -b --pretty
   * false`, unchanged otherwise. Absent means `tsc`, which is the only binary every app already
   * has: `typescript` is a framework dependency, not one this file can assume an app added.
   *
   * Here for the same reason `agentsMdMaxBytes` is: this is the file that configures the GATE,
   * and it is read by the very step the key names. A drop-in `tsc -b` compatible checker (Microsoft's
   * `tsgo`, `@typescript/native-preview`) is a devDependency + a one-line commit here, never a
   * hardcoded default — an app that has not installed the binary this names gets `command not
   * found` from its own shell, not a framework opinion about which compiler is correct.
   */
  readonly typecheckBin?: string;
  /** Why part of the file is not a floor. The `manifest` step reports these; nothing swallows them. */
  readonly problems: readonly string[];
}

/** The floor's budget key. Named once: the problem quotes it and the fix repairs it. */
export const BUDGET_FIELD = 'agentsMdMaxBytes';

/** The floor's typecheck-binary key. Named once: the problem quotes it and the fix repairs it. */
export const TYPECHECK_BIN_FIELD = 'typecheckBin';

/**
 * `agentsMdMaxBytes`, or a reason it is not one. A budget that is not a positive whole number is
 * the caller's bug and must not silently fall back to the default: a floor file that says
 * `"agentsMdMaxBytes": "16kb"` and is quietly ignored is a repository that believes it raised a
 * budget it did not, and finds out when the gate goes red on a commit that changed nothing.
 */
function readBudget(payload: Record<string, unknown> | undefined): {
  budget?: number;
  problems: readonly string[];
} {
  const raw = payload?.[BUDGET_FIELD];
  if (raw === undefined) return { problems: [] };
  if (typeof raw !== 'number' || !Number.isSafeInteger(raw) || raw <= 0)
    return {
      problems: [
        `"${BUDGET_FIELD}" is ${JSON.stringify(raw)}, which is not a positive whole number of bytes`,
      ],
    };
  return { budget: raw, problems: [] };
}

/**
 * `typecheckBin`, or a reason it is not one. A non-string value must not silently fall back to
 * `tsc`: a floor that names `"typecheckBin": 7` and gets `tsc` anyway is a repository that
 * believes the `typecheck` step is running a checker it is not, which is the same false green
 * `readBudget` above already refuses for the byte count. An empty string is refused for the same
 * reason `-b`'s own project argument may not be empty — `bunx '' -b …` is not a step that failed
 * to typecheck, it is a step that never ran a compiler at all.
 */
function readTypecheckBin(payload: Record<string, unknown> | undefined): {
  bin?: string;
  problems: readonly string[];
} {
  const raw = payload?.[TYPECHECK_BIN_FIELD];
  if (raw === undefined) return { problems: [] };
  if (typeof raw !== 'string' || raw.trim().length === 0)
    return {
      problems: [`"${TYPECHECK_BIN_FIELD}" is ${JSON.stringify(raw)}, which is not a binary name`],
    };
  return { bin: raw, problems: [] };
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
    // `renderThrowable`, never `error instanceof Error ? error.message : String(error)`: both halves
    // run on a value this process did not build, and either can throw one line before the guard that
    // was meant to make the path safe (`metrics-endpoint.ts` states the same rule over `stringField`).
    return { steps: [], problems: [`it does not parse as JSON (${renderThrowable(error)})`] };
  }
  const record = asRecord(payload);
  const budget = readBudget(record);
  const typecheckBin = readTypecheckBin(record);
  const steps = record?.['steps'];
  if (!Array.isArray(steps)) {
    return {
      steps: [],
      ...(budget.budget === undefined ? {} : { agentsMdMaxBytes: budget.budget }),
      ...(typecheckBin.bin === undefined ? {} : { typecheckBin: typecheckBin.bin }),
      problems: [
        'it has no "steps" array of step names',
        ...budget.problems,
        ...typecheckBin.problems,
      ],
    };
  }
  const named = steps.filter((step): step is string => typeof step === 'string');
  const unknown = named.filter((step) => !declared.includes(step));
  return {
    steps: named.filter((step) => declared.includes(step)),
    ...(budget.budget === undefined ? {} : { agentsMdMaxBytes: budget.budget }),
    ...(typecheckBin.bin === undefined ? {} : { typecheckBin: typecheckBin.bin }),
    problems: [
      ...(named.length === steps.length ? [] : ['"steps" holds an entry that is not a string']),
      ...typecheckBin.problems,
      ...(unknown.length === 0
        ? []
        : [`"steps" names ${unknown.join(', ')}, which x verify does not run`]),
      ...budget.problems,
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
 *
 * Command first, alternatives behind a `#`, so the line runs verbatim and the shell drops the rest
 * (the shape `mcp-errors.ts` gives this same code). Neither edit is scripted here on purpose: a
 * command that rewrites the floor is the gate editing its own ratchet, which is the false green the
 * floor exists to close — so the run that proves the step is back is what this offers to repeat.
 */
export const vanishedSuiteFinding = (step: string): Finding => ({
  code: 'X_VERIFY_SUITE_VANISHED',
  cause: `${VERIFY_FLOOR_FILE} requires the ${step} step and this run found nothing for it to check`,
  fix: `x verify --json   # restore the ${step} suite, or drop "${step}" from ${VERIFY_FLOOR_FILE} in the commit that says why`,
  docs: ERROR_DOCS_URL,
  at: VERIFY_FLOOR_FILE,
});

/**
 * The second way a suite vanishes, and the reason this is the same code rather than a new one: a
 * step whose files are all still there and whose every test skipped itself found exactly as much
 * for the floor to stand on as a step with no files — nothing. `applies` cannot see it, because
 * `describe.skipIf` is decided inside the run, so this is read back out of what bun reported.
 *
 * The fix names the suite's own command first: what an author has to change is the environment the
 * tests skip without (`TEST_DATABASE_URL` for `live`), and running the type alone is how they find
 * out which one. Dropping the step from the floor stays the alternative, behind the `#`, because
 * either can be the right answer and neither may be performed by the gate on its own ratchet.
 */
export const skippedSuiteFinding = (step: string, skipped: number): Finding => ({
  code: 'X_VERIFY_SUITE_VANISHED',
  cause: `${VERIFY_FLOOR_FILE} requires the ${step} step and all ${skipped} test(s) it found skipped themselves, so nothing ran`,
  fix: `x test ${step} --json   # then set what the suite skips without, or drop "${step}" from ${VERIFY_FLOOR_FILE} in the commit that says why`,
  docs: ERROR_DOCS_URL,
  at: VERIFY_FLOOR_FILE,
});

/**
 * The floor file's own integrity, as findings. `X_CONFIG_INVALID` rather than a second code of this
 * package's own: a committed file the framework reads and cannot use is exactly what core already
 * named, and a floor that enforces nothing is not a vanished suite.
 *
 * The command runs first because it is what the edit needs: the step table it prints is the closed
 * set of names the floor may hold, so an author fixing a typo reads the answer instead of guessing.
 */
export const floorProblemFindings = (floor: VerifyFloor | undefined): readonly Finding[] =>
  (floor?.problems ?? []).map((problem) => ({
    code: 'X_CONFIG_INVALID',
    cause: `${VERIFY_FLOOR_FILE} is not a suite floor: ${problem}`,
    fix: fixFor(problem),
    docs: ERROR_DOCS_URL,
    at: VERIFY_FLOOR_FILE,
  }));

/**
 * The edit that repairs THIS problem, not the file in general. The steps-shaped fix is useless
 * against a bad budget — it prints a `{"steps":[…]}` example with no `agentsMdMaxBytes` in it, so
 * an author who followed it verbatim would still have the value that failed. A finding whose fix
 * does not fix it is the failure `packages/cli/CLAUDE.md` names, and the budget is the first
 * problem this file can report that is not about `steps` at all.
 */
const fixFor = (problem: string): string => {
  if (problem.includes(`"${BUDGET_FIELD}"`))
    return `x verify --json   # then set "${BUDGET_FIELD}" in ${VERIFY_FLOOR_FILE} to a positive whole number of bytes, or drop the key for the ${AGENTS_MD_MAX_BYTES}B default`;
  if (problem.includes(`"${TYPECHECK_BIN_FIELD}"`))
    return `x verify --json   # then set "${TYPECHECK_BIN_FIELD}" in ${VERIFY_FLOOR_FILE} to a non-empty binary name, or drop the key to run tsc`;
  return `x verify --json   # then write ${VERIFY_FLOOR_FILE} as {"steps":["unit","contract"]}, naming only steps it ran`;
};
