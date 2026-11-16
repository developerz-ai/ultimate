#!/usr/bin/env bun

// The nightly flake hunt's two commands: `run` one shuffled round of a suite under a recorded seed,
// and `file` the rounds' failures as one GitHub issue per test. `.github/workflows/flake-hunt.yml`
// runs both; never a gate step — a red night is a lead to read, not a merge to block.
//
//   bun run scripts/flake-hunt.ts run --suite unit|live [--seed N] [--round N] [--json]
//   bun run scripts/flake-hunt.ts file <round.json…> [--json]

import { renderFixShellArg } from '../packages/core/src/error-render';
import type { Gh } from './flake-hunt-file';
import { fileIssues, issuesFor } from './flake-hunt-file';
import type { HuntSuite, RoundDoc, Runner } from './flake-hunt-round';
import { HUNT_SUITES, huntRound, isSeed, randomSeed } from './flake-hunt-round';
import { flagString, parseScriptArgs } from './lib/args';
import type { Finding, ScriptResult } from './lib/log';
import { report } from './lib/log';
import { repoRoot } from './lib/run';
import { ScriptError } from './lib/script-error';

const SCRIPT = 'flake-hunt';
const USAGE = 'bun run scripts/flake-hunt.ts run --suite unit --round 1 --json';

const badArgs = (cause: string): ScriptError =>
  new ScriptError({ code: 'X_CLI_BAD_FLAG', cause, fix: USAGE });

const isSuite = (value: string | undefined): value is HuntSuite =>
  HUNT_SUITES.some((suite) => suite === value);

const roundResult = (doc: RoundDoc): ScriptResult => ({
  ok: doc.ok,
  script: SCRIPT,
  summary: `${doc.suite} round ${doc.round}, seed ${doc.seed}: ${doc.ok ? 'green' : `${doc.failures.length} failing test(s)`}`,
  findings: doc.failures.map(
    (failure): Finding => ({
      code: 'X_FLAKE_HUNT_TEST_FAILED',
      cause: `${failure.file} > ${failure.test} failed under --randomize --seed=${doc.seed}`,
      fix: doc.rerun,
      at: failure.file,
    }),
  ),
  lines: [`  rerun: ${doc.rerun}`],
  data: doc,
});

/** A round's `--json` document read back: its `data` is the RoundDoc this script wrote. */
const roundOf = (text: string): RoundDoc | undefined => {
  try {
    const parsed: unknown = JSON.parse(text);
    const data = (parsed as { data?: unknown } | null)?.data;
    const doc = data as Partial<RoundDoc> | undefined;
    return doc !== undefined &&
      isSuite(doc.suite) &&
      typeof doc.seed === 'number' &&
      Array.isArray(doc.failures)
      ? (doc as RoundDoc)
      : undefined;
  } catch {
    return undefined;
  }
};

async function fileCommand(
  paths: readonly string[],
  root: string,
  gh: Gh | undefined,
): Promise<ScriptResult> {
  if (paths.length === 0) throw badArgs('file names no round document to read');
  const rounds: RoundDoc[] = [];
  const unreadable: Finding[] = [];
  for (const path of paths) {
    const doc = roundOf(await Bun.file(path).text());
    if (doc !== undefined) rounds.push(doc);
    else {
      unreadable.push({
        code: 'X_FLAKE_HUNT_UNREADABLE',
        cause: `${path} is not a flake-hunt round document`,
        fix: `bun run scripts/flake-hunt.ts run --suite unit --json > ${renderFixShellArg(path, '<round.json>')}`,
      });
    }
  }
  const server = Bun.env['GITHUB_SERVER_URL'];
  const repo = Bun.env['GITHUB_REPOSITORY'];
  const id = Bun.env['GITHUB_RUN_ID'];
  const url = server && repo && id ? `${server}/${repo}/actions/runs/${id}` : undefined;
  const plans = issuesFor(rounds, url);
  const { filed, findings } = await fileIssues(plans, root, gh);
  return {
    ok: unreadable.length === 0 && findings.length === 0,
    script: SCRIPT,
    summary: `${rounds.length} round(s) read, ${plans.length} issue(s) to file, ${filed.length} filed`,
    findings: [...unreadable, ...findings],
    lines: filed.map((line) => `  ${line}`),
    data: { rounds: rounds.length, filed },
  };
}

const integerFlag = (raw: string | undefined, name: string): number | undefined => {
  if (raw === undefined) return undefined;
  const value = Number(raw);
  if (!/^\d+$/.test(raw) || !isSeed(value)) {
    throw badArgs(`--${name} takes a whole number from 1 to 4294967295`);
  }
  return value;
};

/** The command line, answered; the round's spawn and `gh` are injected by the tests. */
export async function flakeHunt(
  argv: readonly string[],
  root: string,
  deps: { readonly runner?: Runner; readonly gh?: Gh } = {},
): Promise<ScriptResult> {
  const args = parseScriptArgs(argv);
  const [command, ...rest] = args.positionals;
  if (command === 'file') return fileCommand(rest, root, deps.gh);
  if (command !== 'run') throw badArgs(`unknown command ${command ?? '(none)'}: run or file`);
  const suite = flagString(args, 'suite');
  if (!isSuite(suite)) throw badArgs(`--suite takes ${HUNT_SUITES.join(' or ')}`);
  const seed = integerFlag(flagString(args, 'seed'), 'seed') ?? randomSeed();
  const round = integerFlag(flagString(args, 'round'), 'round') ?? 1;
  return roundResult(
    await huntRound({ root, suite, seed, round, ...(deps.runner ? { runner: deps.runner } : {}) }),
  );
}

if (import.meta.main) {
  const argv = Bun.argv.slice(2);
  const json = argv.includes('--json');
  try {
    report(await flakeHunt(argv, repoRoot()), json);
  } catch (cause) {
    if (!(cause instanceof ScriptError)) throw cause;
    report({ ok: false, script: SCRIPT, summary: 'refused', findings: [cause.toFinding()] }, json);
  }
}
