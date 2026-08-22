#!/usr/bin/env bun
// Every tracked app's own `x verify`, run as a BLOCKING check on this repo — `examples/dummy` and
// the deployed `dummy/social-media-clone`. Neither is green yet, so the check is a ratchet rather
// than a pass/fail: every step passing today must keep passing, every step pinned in that app's
// `expectedRed` must still be failing, and the moment an app's `typecheck` comes off the pin it
// has to join the root `tsc -b` solution. Red never becomes the resting state.
//
//   bun run scripts/reference-app-gate.ts [--json]
//   bun run scripts/reference-app-gate.ts --unpin <app>:<step>[,<step>]   # shrink the ratchet
//
// The pins live in scripts/lib/gated-apps.ts; this file owns only what the ratchet does with them.

// `join` builds the host-separator paths to each app root and the CLI entry point; Bun ships no
// equivalent, and both must be absolute so the subprocess's cwd cannot change what runs.
import { join } from 'node:path';
import type { Runner } from '@ultimat3/cli';
import {
  exec,
  normalizeReferencePath,
  readVerifyFloor,
  VERIFY_FLOOR_FILE,
  VERIFY_STEP_NAMES,
} from '@ultimat3/cli';
import { flagString, parseScriptArgs } from './lib/args';
import type { GatedApp } from './lib/gated-apps';
import { GATED_APPS, PINS_FILE } from './lib/gated-apps';
import type { Finding, ScriptResult } from './lib/log';
import { renderFinding, report } from './lib/log';
import { repoRoot } from './lib/run';
import { parseUnpin, pinnedSteps, removePins } from './lib/unpin';

export const ROOT_TSCONFIG = 'tsconfig.json';

/** The command that performs the stale-pin edit, so the finding can hand over a runnable line. */
export const unpinCommand = (app: GatedApp, steps: readonly string[]): string =>
  `bun run scripts/reference-app-gate.ts --unpin ${app.dir}:${steps.join(',')}`;

/** Runnable from the repo root, and the same gate this script runs — just rendered for a human. */
export const reproduce = (app: GatedApp): string => {
  const up = '../'.repeat(app.dir.split('/').length);
  return `cd ${app.dir} && bun run ${up}packages/cli/src/bin.ts verify`;
};

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
  readonly app: GatedApp;
  readonly steps: readonly GateStep[] | undefined;
  readonly referenced: boolean;
  /** The complete step set a real run reports against — `VERIFY_STEP_NAMES` at the real call
   * site. A parameter, not a hardcoded import, so a test can pin a small closed world instead of
   * asserting against every step this repo happens to declare today. */
  readonly declaredSteps: readonly string[];
}

/**
 * The whole decision for ONE app, separated from running anything so it can be tested both ways
 * round. Every finding names the app: with more than one gated app, "typecheck regressed" with no
 * directory is a finding the reader has to reproduce twice to place.
 */
export const gateFindings = (input: GateInput): readonly Finding[] => {
  const { app, steps, referenced, declaredSteps } = input;
  const expectedRed = app.expectedRed;
  if (steps === undefined || steps.length === 0) {
    return [
      {
        code: 'X_REFERENCE_APP_REGRESSED',
        cause: `${app.dir} printed no step table, so not one step could be checked`,
        fix: reproduce(app),
        at: app.dir,
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
      cause: `${app.dir}'s step table does not match the declared steps: ${shapeIssues.join('; ')}`,
      fix: reproduce(app),
      at: app.dir,
    });
  }

  const red = redSteps(steps);

  const regressed = red.filter((name) => !(name in expectedRed));
  if (regressed.length > 0) {
    findings.push({
      code: 'X_REFERENCE_APP_REGRESSED',
      cause: `${regressed.join(', ')} passed for ${app.dir} and now ${regressed.length === 1 ? 'fails' : 'fail'}`,
      fix: reproduce(app),
      at: app.dir,
    });
  }

  // A pinned step that came back SKIPPED is still pinned, never stale. "Not red" and "passes" were
  // the same branch, so deleting the suite behind a pinned step reported it as repaired and handed
  // over an `--unpin` line — after which the step is neither red nor pinned and the gate is green
  // over a suite that no longer exists. `floorFindings` is the half that says so out loud.
  const skipped = steps.filter((step) => step.skipped).map((step) => step.name);
  const stale = Object.keys(expectedRed).filter(
    (name) => !(red.includes(name) || skipped.includes(name)),
  );
  if (stale.length > 0) {
    findings.push({
      code: 'X_REFERENCE_APP_PIN_STALE',
      cause: `${stale.join(', ')} now ${stale.length === 1 ? 'passes' : 'pass'} for ${app.dir} but ${stale.length === 1 ? 'is' : 'are'} still pinned as failing`,
      // Runnable, not prose: this is the edit every landed fix makes, and `at` still names the
      // file for a reader who would rather delete the lines themselves.
      fix: unpinCommand(app, stale),
      at: PINS_FILE,
    });
  }

  // The build-graph half of the same promise: an app that compiles has no excuse for sitting
  // outside `tsc -b`, and only the root solution proves the packages' emitted .d.ts are consumable
  // by a real app rather than only their own sources.
  if (!(red.includes('typecheck') || referenced)) {
    findings.push({
      code: 'X_REFERENCE_APP_UNREFERENCED',
      cause: `${app.dir} typechecks but is not a project the root ${ROOT_TSCONFIG} references`,
      fix: `add { "path": "${app.reference}" } to the "references" array in ${ROOT_TSCONFIG}`,
      at: ROOT_TSCONFIG,
    });
  }
  return findings;
};

export interface FloorInput {
  readonly app: GatedApp;
  readonly steps: readonly GateStep[];
  /** The step names the app's committed `x.verify.json` holds; `undefined` when it commits none. */
  readonly floor: readonly string[] | undefined;
}

/**
 * The suite floor, judged from OUTSIDE the app. `x verify` already turns a floor-named step that
 * finds nothing into a failure — but only for a floor that exists, and neither tracked app had one,
 * so deleting a whole `contract`/`live`/`job`/`e2e` suite turned its step from red-and-pinned into
 * skipped-and-green: not a regression, not a stale pin, and both gates stayed green over a suite
 * that had ceased to exist. Two rules, mirror images, and the pair is what makes the floor a
 * ratchet rather than a note:
 *
 *   - a step this run PROVED applies that the floor does not name — the floor is behind, and every
 *     step it omits is one whose deletion nothing would catch;
 *   - a step the floor names that this run SKIPPED — the suite is gone, or the floor drops the line
 *     in the commit that says why.
 *
 * Pure, like `gateFindings`: the caller reads the file.
 */
export const floorFindings = (input: FloorInput): readonly Finding[] => {
  const { app, steps, floor } = input;
  if (steps.length === 0) return [];
  const applied = steps.filter((step) => !step.skipped).map((step) => step.name);
  const floorPath = `${app.dir}/${VERIFY_FLOOR_FILE}`;
  if (floor === undefined || floor.length === 0) {
    return [
      {
        code: 'X_REFERENCE_APP_NO_FLOOR',
        cause:
          `${app.dir} commits no usable ${VERIFY_FLOOR_FILE}, so a deleted suite turns its step ` +
          'from red into skipped and neither this gate nor the app’s own reports it',
        fix: `write ${floorPath} as {"steps":${JSON.stringify(applied)}}`,
        at: floorPath,
      },
    ];
  }
  const findings: Finding[] = [];
  const missing = applied.filter((name) => !floor.includes(name));
  if (missing.length > 0) {
    findings.push({
      code: 'X_REFERENCE_APP_NO_FLOOR',
      cause: `${app.dir} ran ${missing.join(', ')} and its ${VERIFY_FLOOR_FILE} does not name ${missing.length === 1 ? 'it' : 'them'}, so deleting ${missing.length === 1 ? 'that suite' : 'those suites'} would read as a skip`,
      fix: `add ${missing.map((name) => `"${name}"`).join(', ')} to the "steps" array in ${floorPath}`,
      at: floorPath,
    });
  }
  const vanished = steps.filter((step) => step.skipped && floor.includes(step.name));
  if (vanished.length > 0) {
    const names = vanished.map((step) => step.name);
    findings.push({
      code: 'X_REFERENCE_APP_REGRESSED',
      cause: `${names.join(', ')} ran for ${app.dir} when its ${VERIFY_FLOOR_FILE} was written and now ${names.length === 1 ? 'finds' : 'find'} nothing to check`,
      fix: reproduce(app),
      at: floorPath,
    });
  }
  return findings;
};

/** Whether an app is in the root build graph. An unreadable root config counts as "not in it". */
export const referencesApp = async (root: string, entry: string): Promise<boolean> => {
  const parsed: unknown = await Bun.file(join(root, ROOT_TSCONFIG))
    .json()
    .catch(() => undefined);
  const references = (parsed as { readonly references?: unknown } | undefined)?.references;
  if (!Array.isArray(references)) return false;
  // A malformed entry (`null`, a bare string, a number) is a non-reference, not a crash: reading
  // `.path` off it without this guard throws before the real entries ever get a chance to match.
  // Compared through the CLI's own spelling rule, so `./examples/dummy`, `examples/dummy` and
  // `examples/dummy/` answer the same here as they do in `package-shape`'s build-graph check.
  const wanted = normalizeReferencePath(entry);
  return references.some((ref) => {
    if (typeof ref !== 'object' || ref === null) return false;
    const path = (ref as { readonly path?: unknown }).path;
    return typeof path === 'string' && normalizeReferencePath(path) === wanted;
  });
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

/** The red steps this app's table pins. The rest of `red` is a regression, never a held pin. */
export const pinnedRedSteps = (app: GatedApp, red: readonly string[]): readonly string[] =>
  red.filter((name) => name in app.expectedRed);

/**
 * One app's line in the summary. Red and pinned-red are separate numbers because they are separate
 * facts: reporting every red step as "pinned red" described the failing run — the one this line
 * exists to explain — as if the ratchet were holding.
 */
export const tally = (app: GatedApp, red: readonly string[], total: number): string =>
  `${app.dir} ${total - red.length}/${total}, ${red.length} red (${pinnedRedSteps(app, red).length} pinned)`;

export const runAppGate = async (
  root: string,
  runner: Runner,
  dir: string,
): Promise<readonly GateStep[] | undefined> => {
  const result = await runner(
    ['bun', 'run', join(root, 'packages/cli/src/bin.ts'), 'verify', '--json'],
    { cwd: join(root, dir) },
  );
  return parseSteps(result.stdout);
};

const SCRIPT = 'reference-app-gate';

const badFlag = (cause: string, fix: string): ScriptResult => ({
  ok: false,
  script: SCRIPT,
  summary: cause,
  findings: [{ code: 'X_CLI_BAD_FLAG', cause, fix, at: PINS_FILE }],
});

/**
 * `--unpin <app>:<step>[,<step>]`, performed: the edit `X_REFERENCE_APP_PIN_STALE` names, so an
 * agent shrinks the ratchet with the line the gate printed instead of hand-editing a table.
 *
 * Fails closed at every disagreement. The steps must be pinned for that app, and the entries the
 * text parser finds must be exactly the keys the gate's own import sees — a pins file this cannot
 * read is a hand edit, never a guess at which lines to delete.
 */
export const unpin = async (root: string, token: string): Promise<ScriptResult> => {
  const request = parseUnpin(token);
  const shape = `bun run scripts/reference-app-gate.ts --unpin ${GATED_APPS[0]?.dir ?? '<app>'}:drift`;
  if (request === undefined)
    return badFlag(`--unpin "${token}" is not <app>:<step>[,<step>]`, shape);
  const app = GATED_APPS.find((candidate) => candidate.dir === request.app);
  if (app === undefined) {
    return badFlag(
      `--unpin names ${request.app}, which is not a gated app`,
      `bun run scripts/reference-app-gate.ts --unpin <${GATED_APPS.map((a) => a.dir).join('|')}>:<step>`,
    );
  }
  const declared = Object.keys(app.expectedRed);
  const unknown = request.steps.filter((step) => !declared.includes(step));
  if (unknown.length > 0) {
    return badFlag(
      `${unknown.join(', ')} is not pinned for ${app.dir}${declared.length === 0 ? ' — its table is already empty' : `; it pins ${declared.join(', ')}`}`,
      `bun run scripts/reference-app-gate.ts --json   # the pins each app still carries`,
    );
  }
  const path = join(root, PINS_FILE);
  const source = await Bun.file(path).text();
  const onFile = pinnedSteps(source, app.dir);
  const next = removePins(source, app.dir, request.steps);
  if (next === undefined || onFile === undefined || onFile.join() !== declared.join()) {
    const cause = `${PINS_FILE} no longer reads as the table this edit understands, so ${app.dir}'s pins were left alone`;
    return {
      ok: false,
      script: SCRIPT,
      summary: cause,
      findings: [
        {
          code: 'X_REFERENCE_APP_PIN_STALE',
          cause,
          fix: `delete the ${request.steps.join(', ')} entr${request.steps.length === 1 ? 'y' : 'ies'} from ${app.dir}'s expectedRed in ${PINS_FILE}`,
          at: PINS_FILE,
        },
      ],
    };
  }
  await Bun.write(path, next);
  const left = pinnedSteps(next, app.dir) ?? [];
  return {
    ok: true,
    script: SCRIPT,
    summary: `${app.dir}: unpinned ${request.steps.join(', ')} — ${left.length === 0 ? `no pins left, the app is asserting ${VERIFY_STEP_NAMES.length} of ${VERIFY_STEP_NAMES.length}` : `${left.join(', ')} still pinned`}`,
    lines: [`  ${PINS_FILE} rewritten`, '  now run: bun run scripts/reference-app-gate.ts'],
    data: { app: app.dir, removed: request.steps, pinned: left },
  };
};

if (import.meta.main) {
  const args = parseScriptArgs(Bun.argv.slice(2));
  const root = repoRoot();
  const requested = flagString(args, 'unpin');
  // The edit, not the gate: running both would report the ratchet as it was a moment ago.
  if (requested !== undefined) report(await unpin(root, requested), args.json);
  const findings: Finding[] = [];
  const lines: string[] = [];
  const data: Record<string, unknown>[] = [];
  // Per-app, and in the summary rather than only in `lines`: `--json` drops `lines` entirely, and
  // "the apps hold" without the counts tells a CI reader nothing about which way they are moving.
  const tallies: string[] = [];

  // Sequentially, not `Promise.all`: each app's `x verify` runs its own test workers, boots an
  // embedded Postgres and binds the e2e server's port. Two at once would race for all three, and
  // the shared runner has two cores to give them anyway.
  for (const app of GATED_APPS) {
    const steps = await runAppGate(root, exec, app.dir);
    const referenced = await referencesApp(root, app.reference);
    findings.push(...gateFindings({ app, steps, referenced, declaredSteps: VERIFY_STEP_NAMES }));
    // Read here rather than inside `gateFindings` for the same reason `referenced` is: the decision
    // stays pure and testable, and the one thing that touches the disk is this loop.
    const floor = await readVerifyFloor(join(root, app.dir));
    findings.push(...floorFindings({ app, steps: steps ?? [], floor: floor?.steps }));
    const red = steps === undefined ? [] : redSteps(steps);
    const total = steps?.length ?? 0;
    tallies.push(tally(app, red, total));
    lines.push(`${app.dir}: ${total - red.length} of ${total} pass, ${red.length} red`);
    lines.push(...(steps === undefined ? [] : stepLines(steps, app.expectedRed)));
    data.push({
      app: app.dir,
      red,
      pinnedRed: pinnedRedSteps(app, red),
      pinned: Object.keys(app.expectedRed),
      referenced,
    });
  }

  report(
    {
      ok: findings.length === 0,
      script: 'reference-app-gate',
      summary:
        findings.length === 0
          ? `every pin holds — ${tallies.join('; ')}`
          : `${findings.length} app finding(s) — ${tallies.join('; ')}`,
      findings,
      lines,
      data: { apps: data },
    },
    args.json,
  );
}
