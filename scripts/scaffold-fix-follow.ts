// A scaffolded app's own `x verify`, red, then REPAIRED BY ITS OWN `fix:` LINES — the assertion
// axiom 4 has never had. "Errors are instructions" is checked today only for shape (a fix cell is
// runnable, a fix names a command this build ships); nothing has ever run one and asked whether the
// gate then goes green. A scaffold lint loop — `x verify` red on `lint`, whose `fix:` reintroduces
// the same red — passes every check in this repo and fails the first minute of a new app.
//
// Pure over an injected `Runner`, like `scaffoldFindings` is pure over a step table: the loop is
// tested with a fake runner and nothing is spawned to prove it terminates, reports the right round
// and refuses a `fix:` that is prose.
//
// THREE ROUNDS, not "until green": a fix that reintroduces its own red is the defect this exists to
// catch, and an unbounded loop reports it as a hung job instead of as a finding.

import type { Runner } from '@ultimat3/cli';
import type { Finding } from './lib/log';
import type { GateStep } from './reference-app-gate';
import { parseSteps, redSteps } from './reference-app-gate';

/** The rounds a scaffolded app gets to repair itself before the loop calls it a loop. */
export const MAX_ROUNDS = 3;

/**
 * Programs a `fix:` may name for this loop to run it. Everything else is an EDIT — "delete `driver:`
 * from `jobs`", "add a row to …" — which is a legitimate fix line and simply not one a gate can
 * perform. Reported, never executed: a scaffolded app whose only route to green is a hand edit is a
 * finding about the scaffold, which is what this whole check is for.
 */
const RUNNABLE_HEADS: ReadonlySet<string> = new Set(['bun', 'bunx', 'x']);

/** Shell syntax means the line is a pipeline, not an argv — running it verbatim needs a shell. */
const SHELL_SYNTAX = /[|&;<>$`\\]|\)\s*$/;

export interface FixFollowRound {
  readonly round: number;
  readonly red: readonly string[];
  /** The `fix:` lines this round ran, exactly as the gate printed them. */
  readonly ran: readonly string[];
  /** The `fix:` lines this round could not run, with the reason. */
  readonly skipped: readonly { readonly fix: string; readonly reason: string }[];
}

export interface FixFollowResult {
  readonly green: boolean;
  readonly rounds: readonly FixFollowRound[];
  /** The steps still red when the loop gave up; empty when `green`. */
  readonly red: readonly string[];
  /** The final step table, so a caller can hold it to `declaredStepIssues` too. */
  readonly steps: readonly GateStep[] | undefined;
}

/**
 * A `fix:` as an argv, or the reason it is not one. Quoted arguments are honoured because a real
 * fix line carries them — `expect.unreachable('<what was expected>')` is not runnable at all, but
 * `bun test -t 'formats the fix line'` is.
 */
export function runnableFix(
  fix: string,
): { readonly argv: readonly string[] } | { readonly reason: string } {
  const text = fix.trim();
  if (SHELL_SYNTAX.test(text)) {
    return { reason: 'it is a shell pipeline, not a single command — this loop spawns an argv' };
  }
  const argv = [...text.matchAll(/'([^']*)'|"([^"]*)"|(\S+)/g)].map(
    (match) => match[1] ?? match[2] ?? (match[3] as string),
  );
  const head = argv[0];
  if (head === undefined) return { reason: 'it is empty' };
  if (!RUNNABLE_HEADS.has(head)) {
    return {
      reason: `it starts with "${head}", which is an edit to perform rather than a command`,
    };
  }
  return { argv };
}

/** One `x verify --json` in the scaffolded app. `bun run verify` is the script `x new` writes. */
const verifyOnce = async (dir: string, runner: Runner): Promise<readonly GateStep[] | undefined> =>
  parseSteps((await runner(['bun', 'run', 'verify', '--json'], { cwd: dir })).stdout);

/**
 * Red → run every fix → re-run, at most `MAX_ROUNDS` times. Each round's fixes come from THAT
 * round's table, so a fix that unblocks a later step is followed in the round after it.
 *
 * A round that runs nothing stops the loop immediately: re-running a gate whose state nothing
 * touched can only produce the same table, and three identical rounds would report the round count
 * as the finding rather than the fix line that could not be followed.
 */
export async function followFixes(dir: string, runner: Runner): Promise<FixFollowResult> {
  const rounds: FixFollowRound[] = [];
  let steps = await verifyOnce(dir, runner);
  for (let round = 1; round <= MAX_ROUNDS; round += 1) {
    const red = steps === undefined ? [] : redSteps(steps);
    if (steps !== undefined && red.length === 0) {
      return { green: true, rounds, red: [], steps };
    }
    const fixes = (steps ?? [])
      .filter((step) => !(step.ok || step.skipped))
      .flatMap((step) => step.findings.map((finding) => finding.fix));
    const ran: string[] = [];
    const skipped: { fix: string; reason: string }[] = [];
    for (const fix of new Set(fixes)) {
      const parsed = runnableFix(fix);
      if ('reason' in parsed) {
        skipped.push({ fix, reason: parsed.reason });
        continue;
      }
      await runner(parsed.argv, { cwd: dir });
      ran.push(fix);
    }
    rounds.push({ round, red, ran, skipped });
    if (ran.length === 0) return { green: false, rounds, red, steps };
    steps = await verifyOnce(dir, runner);
  }
  const red = steps === undefined ? [] : redSteps(steps);
  return { green: red.length === 0 && steps !== undefined, rounds, red, steps };
}

const roundLine = (round: FixFollowRound): string =>
  `round ${String(round.round)}: ${round.red.join(', ') || 'none'} red, ${String(round.ran.length)} fix line(s) run`;

/** Where a scaffolded app is reproduced, so every finding below is one paste away from a repeat. */
export const reproduceFollow = (dir: string): string =>
  `cd ${dir} && bun run verify --json && bun run ../../scripts/scaffold-gate.ts ${dir} --fix-follow`;

/**
 * What the loop contributes to `scaffold-smoke`. Three separate failures, because they are three
 * different bugs: a fix line that is prose, a gate still red after its own instructions, and a
 * table that stopped being readable mid-loop.
 */
export function fixFollowFindings(dir: string, result: FixFollowResult): readonly Finding[] {
  const findings: Finding[] = [];
  const unfollowable = result.rounds.flatMap((round) => round.skipped);
  if (!result.green && unfollowable.length > 0) {
    const first = unfollowable[0] as { fix: string; reason: string };
    findings.push({
      code: 'X_SCAFFOLD_FIX_UNFOLLOWED',
      cause: `the scaffolded app at ${dir} is red and the fix for it cannot be run: "${first.fix}" — ${first.reason}`,
      fix: `make that fix line a command a fresh app can run, or fix the scaffold so the step is green without it; reproduce with: ${reproduceFollow(dir)}`,
      at: dir,
    });
  }
  if (!result.green && unfollowable.length === 0) {
    findings.push({
      code: 'X_SCAFFOLD_FIX_LOOP',
      cause: `the scaffolded app at ${dir} is still red on ${result.red.join(', ') || 'a step it did not print'} after following its own fix lines for ${String(result.rounds.length)} round(s) — ${result.rounds.map(roundLine).join('; ')}`,
      fix: `run the last round's fix line by hand in ${dir} and read what it changes — a fix that reintroduces its own red is the defect; reproduce with: ${reproduceFollow(dir)}`,
      at: dir,
    });
  }
  return findings;
}

/**
 * The second half of the same claim, and the one that would have caught the scaffold lint loop:
 * a green gate that goes red the moment the app builds. `x build --target static` writes files into
 * the app — a prerender output, an island bundle, a CSS artifact — and `lint` reads the tree, so a
 * build that emits something Biome refuses turns a shippable app into a red one on the next
 * command an author runs.
 *
 * `lint` specifically, not "still green": every other step legitimately changes answer after a
 * build (`budgets` measures the artifact that did not exist before it). The one that must not is
 * the one that reads files the build wrote.
 */
export async function staticBuildFindings(
  dir: string,
  runner: Runner,
  step = 'lint',
): Promise<readonly Finding[]> {
  const built = await runner(['bun', 'run', 'x', 'build', '--target', 'static'], { cwd: dir });
  if (!built.ok) {
    return [
      {
        code: 'X_SCAFFOLD_BUILD_FAILED',
        cause: `x build --target static failed in the scaffolded app at ${dir}, so nothing downstream of a build is under test: ${built.stderr.trim().split('\n').at(-1) ?? `exit ${String(built.code)}`}`,
        fix: `cd ${dir} && bun run x build --target static`,
        at: dir,
      },
    ];
  }
  const steps = await verifyOnce(dir, runner);
  const red = steps === undefined ? [step] : redSteps(steps);
  if (!red.includes(step)) return [];
  return [
    {
      code: 'X_SCAFFOLD_BUILD_REGRESSED',
      cause: `${step} was green in the scaffolded app at ${dir} and is red after x build --target static — the build writes files the ${step} step then reads, so a fresh app is shippable only until its first build`,
      fix: `cd ${dir} && bun run x build --target static && bun run verify --json, then exclude what the build writes in that app's biome.json`,
      at: dir,
    },
  ];
}
