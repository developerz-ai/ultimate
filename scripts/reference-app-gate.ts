#!/usr/bin/env bun
// The reference app's own `x verify`, run as a BLOCKING check on this repo. Postly is not green
// yet, so the check is a ratchet rather than a pass/fail: every step passing today must keep
// passing, every step pinned as failing must still be failing, and the moment `typecheck` comes
// off the pin the app has to join the root `tsc -b` solution. Red never becomes the resting state.
//
//   bun run scripts/reference-app-gate.ts [--json]

// `join` builds the host-separator paths to the app root and the CLI entry point; Bun ships no
// equivalent, and both must be absolute so the subprocess's cwd cannot change what runs.
import { join } from 'node:path';
import type { Runner, VerifyStepName } from '@ultimat3/cli';
import { exec, VERIFY_STEP_NAMES } from '@ultimat3/cli';
import { parseScriptArgs } from './lib/args';
import type { Finding } from './lib/log';
import { renderFinding, report } from './lib/log';
import { repoRoot } from './lib/run';

export const REFERENCE_APP = 'examples/dummy';
export const ROOT_TSCONFIG = 'tsconfig.json';
export const GATE_FILE = 'scripts/reference-app-gate.ts';

/** The `references` entry that puts the app in the root `tsc -b` solution. */
export const REFERENCE_ENTRY = './examples/dummy';

/** Runnable from the repo root, and the same gate this script runs — just rendered for a human. */
export const REPRODUCE = `cd ${REFERENCE_APP} && bun run ../../packages/cli/src/bin.ts verify`;

/**
 * Steps of the app's gate allowed to fail today, each naming the work that owns it. A step absent
 * from this table MUST pass — that is what makes the reference app blocking while it is still
 * being repaired. Lines are only ever deleted: a new red step is a regression, and a pinned step
 * that turns green fails this check until its line goes. An empty table means 17 of 17.
 *
 * `satisfies` against the gate's own step names, so a pin for a step that does not exist is a
 * compile error rather than a line that quietly excuses nothing.
 */
export const EXPECTED_RED: Readonly<Record<string, string>> = {
  typecheck:
    "database()'s EntitySet constraint rejects a real Entity, so every db.<table> degrades to " +
    'Table<unknown> | undefined and 277 errors follow — the data-substrate work owns it',
  boundaries:
    'three site/ routes read @postly/db directly; they need the bounded queries the ' +
    'data-substrate work adds',
  contract: 'X_TENANCY_UNSCOPED on every post write — data substrate',
  live: 'the live suite reads through the same unscoped repo — data substrate',
  job: 'the digest job writes through the same unscoped repo — data substrate',
  e2e: 'the built output serves pages backed by the same repo — data substrate',
  drift: 'migrations predate the current entity set; regenerated with the schema',
} satisfies Partial<Record<VerifyStepName, string>>;

export interface GateStep {
  readonly name: string;
  readonly ok: boolean;
  readonly skipped: boolean;
  readonly findings: readonly Finding[];
}

const asFinding = (value: unknown): Finding | undefined => {
  if (typeof value !== 'object' || value === null) return undefined;
  const { code, cause, fix, at } = value as Record<string, unknown>;
  if (typeof code !== 'string' || typeof cause !== 'string' || typeof fix !== 'string') {
    return undefined;
  }
  return typeof at === 'string' ? { code, cause, fix, at } : { code, cause, fix };
};

const asStep = (value: unknown): GateStep | undefined => {
  if (typeof value !== 'object' || value === null) return undefined;
  const { name, ok, skipped, findings } = value as Record<string, unknown>;
  if (typeof name !== 'string' || typeof ok !== 'boolean') return undefined;
  return {
    name,
    ok,
    skipped: skipped === true,
    findings: (Array.isArray(findings) ? findings : [])
      .map(asFinding)
      .filter((f) => f !== undefined),
  };
};

/**
 * `x verify --json` prints one object on its own line. The last `{`-line is taken rather than the
 * whole stream so a stray write from a step's subprocess cannot make the gate unreadable — and
 * `undefined` (no table at all) is treated as the worst outcome, not as "nothing failed".
 */
export const parseSteps = (stdout: string): readonly GateStep[] | undefined => {
  const line = stdout
    .split('\n')
    .map((part) => part.trim())
    .findLast((part) => part.startsWith('{'));
  if (line === undefined) return undefined;
  let payload: unknown;
  try {
    payload = JSON.parse(line);
  } catch {
    return undefined;
  }
  // Guarded the same way `asStep`/`asFinding` guard their own input: `payload` is `unknown` from
  // here on, so a shape this parser cannot use — `null`, an array, a bare number — reads as "no
  // table" rather than a thrown TypeError reading `.steps` off it.
  const steps =
    typeof payload === 'object' && payload !== null
      ? (payload as { readonly steps?: unknown }).steps
      : undefined;
  if (!Array.isArray(steps)) return undefined;
  const parsed = steps.map(asStep);
  return parsed.every((step) => step !== undefined) ? parsed : undefined;
};

export const redSteps = (steps: readonly GateStep[]): readonly string[] =>
  steps.filter((step) => !(step.ok || step.skipped)).map((step) => step.name);

/**
 * The red/stale-pin checks below only ever look at the steps the table actually contains — a step
 * `verify --json` silently dropped (a crash mid-run, a future step wired into the CLI but never
 * into its own JSON output) is invisible to both, and a passing gate would not mean "17 steps
 * checked", it would mean "however many the process happened to print". Comparing the received
 * names against the full declared set is what makes a missing step a finding instead of a step
 * nobody was checking.
 */
export const declaredStepIssues = (
  steps: readonly GateStep[],
  declaredSteps: readonly string[],
): readonly string[] => {
  const names = steps.map((step) => step.name);
  const missing = declaredSteps.filter((name) => !names.includes(name));
  const unknown = [...new Set(names.filter((name) => !declaredSteps.includes(name)))];
  const seen = new Set<string>();
  const duplicate = new Set<string>();
  for (const name of names) {
    if (seen.has(name)) duplicate.add(name);
    seen.add(name);
  }
  return [
    ...missing.map((name) => `${name} is declared but missing from the step table`),
    ...unknown.map((name) => `${name} is in the step table but not a declared step`),
    ...[...duplicate].map((name) => `${name} appears more than once in the step table`),
  ];
};

export interface GateInput {
  readonly steps: readonly GateStep[] | undefined;
  readonly expectedRed: Readonly<Record<string, string>>;
  readonly referenced: boolean;
  /** The complete step set a real run reports against — `VERIFY_STEP_NAMES` at the real call
   * site. A parameter, not a hardcoded import, so a test can pin a small closed world instead of
   * asserting against every step this repo happens to declare today. */
  readonly declaredSteps: readonly string[];
}

/** The whole decision, separated from running anything so it can be tested both ways round. */
export const gateFindings = (input: GateInput): readonly Finding[] => {
  const { steps, expectedRed, referenced, declaredSteps } = input;
  if (steps === undefined || steps.length === 0) {
    return [
      {
        code: 'X_REFERENCE_APP_REGRESSED',
        cause: `${REFERENCE_APP} printed no step table, so not one step could be checked`,
        fix: REPRODUCE,
        at: REFERENCE_APP,
      },
    ];
  }
  const findings: Finding[] = [];

  // Before red/stale-pin even get a say: a step missing from the table entirely is neither red
  // nor a stale pin, it is a step nobody checked — and a duplicate or unknown name means the table
  // itself cannot be trusted to answer either question correctly.
  const shapeIssues = declaredStepIssues(steps, declaredSteps);
  if (shapeIssues.length > 0) {
    findings.push({
      code: 'X_REFERENCE_APP_REGRESSED',
      cause: `${REFERENCE_APP}'s step table does not match the declared steps: ${shapeIssues.join('; ')}`,
      fix: REPRODUCE,
      at: REFERENCE_APP,
    });
  }

  const red = redSteps(steps);

  const regressed = red.filter((name) => !(name in expectedRed));
  if (regressed.length > 0) {
    findings.push({
      code: 'X_REFERENCE_APP_REGRESSED',
      cause: `${regressed.join(', ')} passed for the reference app and now ${regressed.length === 1 ? 'fails' : 'fail'}`,
      fix: REPRODUCE,
      at: REFERENCE_APP,
    });
  }

  const stale = Object.keys(expectedRed).filter((name) => !red.includes(name));
  if (stale.length > 0) {
    findings.push({
      code: 'X_REFERENCE_APP_PIN_STALE',
      cause: `${stale.join(', ')} now ${stale.length === 1 ? 'passes' : 'pass'} but ${stale.length === 1 ? 'is' : 'are'} still pinned as failing`,
      fix: `delete the ${stale.join(', ')} entr${stale.length === 1 ? 'y' : 'ies'} from EXPECTED_RED in ${GATE_FILE}`,
      at: GATE_FILE,
    });
  }

  // The build-graph half of the same promise: a reference app that compiles has no excuse for
  // sitting outside `tsc -b`, and only the root solution proves the packages' emitted .d.ts are
  // consumable by a real app rather than only their own sources.
  if (!(red.includes('typecheck') || referenced)) {
    findings.push({
      code: 'X_REFERENCE_APP_UNREFERENCED',
      cause: `${REFERENCE_APP} typechecks but is not a project the root ${ROOT_TSCONFIG} references`,
      fix: `add { "path": "${REFERENCE_ENTRY}" } to the "references" array in ${ROOT_TSCONFIG}`,
      at: ROOT_TSCONFIG,
    });
  }
  return findings;
};

/** Whether the app is in the root build graph. An unreadable root config counts as "not in it". */
export const referencesApp = async (root: string): Promise<boolean> => {
  const parsed: unknown = await Bun.file(join(root, ROOT_TSCONFIG))
    .json()
    .catch(() => undefined);
  const references = (parsed as { readonly references?: unknown } | undefined)?.references;
  if (!Array.isArray(references)) return false;
  // A malformed entry (`null`, a bare string, a number) is a non-reference, not a crash: reading
  // `.path` off it without this guard throws before the real entries ever get a chance to match.
  return references.some(
    (entry) =>
      typeof entry === 'object' &&
      entry !== null &&
      (entry as { readonly path?: unknown }).path === REFERENCE_ENTRY,
  );
};

/** The step table, so a CI reader sees the whole gate and not only what this check rejected. */
export const stepLines = (
  steps: readonly GateStep[],
  expectedRed: Readonly<Record<string, string>>,
): readonly string[] => {
  const lines: string[] = [];
  for (const step of steps) {
    const mark = step.skipped ? '-' : step.ok ? '✓' : '✗';
    const pinned = step.name in expectedRed ? '  pinned' : '';
    lines.push(`  ${mark} ${step.name.padEnd(14)}${pinned}`);
    for (const finding of step.findings) lines.push(renderFinding(finding, '      '));
  }
  return lines;
};

export const runReferenceAppGate = async (
  root: string,
  runner: Runner,
): Promise<readonly GateStep[] | undefined> => {
  const result = await runner(
    ['bun', 'run', join(root, 'packages/cli/src/bin.ts'), 'verify', '--json'],
    { cwd: join(root, REFERENCE_APP) },
  );
  return parseSteps(result.stdout);
};

if (import.meta.main) {
  const args = parseScriptArgs(Bun.argv.slice(2));
  const root = repoRoot();
  const steps = await runReferenceAppGate(root, exec);
  const referenced = await referencesApp(root);
  const findings = gateFindings({
    steps,
    expectedRed: EXPECTED_RED,
    referenced,
    declaredSteps: VERIFY_STEP_NAMES,
  });
  const red = steps === undefined ? [] : redSteps(steps);
  const total = steps?.length ?? 0;
  report(
    {
      ok: findings.length === 0,
      script: 'reference-app-gate',
      summary:
        findings.length === 0
          ? `${REFERENCE_APP}: ${total - red.length} of ${total} steps pass, ${red.length} pinned`
          : `${findings.length} reference-app finding(s) across ${total} steps`,
      findings,
      lines: steps === undefined ? [] : stepLines(steps, EXPECTED_RED),
      data: { app: REFERENCE_APP, red, pinned: Object.keys(EXPECTED_RED), referenced },
    },
    args.json,
  );
}
