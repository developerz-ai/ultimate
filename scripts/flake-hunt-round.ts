// One flake-hunt round: `x test <suite>` with Bun shuffling file and test order from a recorded
// seed, read back into the failing tests, the seed and the exact rerun line. Bun's own
// `--randomize --seed` does the shuffle (Bun 1.4: file order AND test order, reproducible per
// seed), so no file list is reordered here and the suite is the one the gate selects.

import { type FailedTest, failedTests } from './flake-hunt-parse';
import { jsonDocument } from './lib/health-narrow';
import type { Finding } from './lib/log';
import type { RunResult } from './lib/run';
import { run } from './lib/run';

export const HUNT_SUITES = ['unit', 'live'] as const;
export type HuntSuite = (typeof HUNT_SUITES)[number];

/** A whole round of the slowest suite on one free runner, measured ~15 min; this is a hang. */
const ROUND_TIMEOUT_MS = 50 * 60_000;
/** What an unnamed red round quotes: the end of the output, where Bun and `x` say why. */
const TAIL_LINES = 40;
const MAX_SEED = 4_294_967_295;

/** One round's answer, the document the filing step reads back. */
export interface RoundDoc {
  readonly suite: HuntSuite;
  readonly seed: number;
  readonly round: number;
  readonly ok: boolean;
  readonly failures: readonly FailedTest[];
  readonly findings: readonly Finding[];
  /** The command that replays this round in this order. */
  readonly rerun: string;
  /** The output's last lines, for a red round that named no test. */
  readonly tail: string;
}

export type Runner = (command: readonly string[], cwd: string) => Promise<RunResult>;

export const isSeed = (value: number): boolean =>
  Number.isInteger(value) && value >= 1 && value <= MAX_SEED;

/** A fresh seed for a round nobody asked to replay. */
export const randomSeed = (): number =>
  ((crypto.getRandomValues(new Uint32Array(1))[0] ?? 0) % MAX_SEED) + 1;

/** `x test`'s reproduce line made pasteable at the repo root; live needs the services' URLs. */
export function rerunCommand(
  suite: HuntSuite,
  seed: number,
  reproduce: string | undefined,
): string {
  const x = reproduce?.startsWith('x ')
    ? `bun run x -- ${reproduce.slice(2)}`
    : `bun run x -- test ${suite} -- --randomize --seed=${seed}`;
  return suite === 'live' ? `set -a; . docker/test-services.env; set +a; ${x}` : x;
}

const rec = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;

const list = (value: unknown): readonly unknown[] => (Array.isArray(value) ? value : []);

const findingOf = (value: unknown): Finding[] => {
  const one = rec(value);
  const [code, cause, fix] = [one?.['code'], one?.['cause'], one?.['fix']];
  return typeof code === 'string' && typeof cause === 'string' && typeof fix === 'string'
    ? [{ code, cause, fix }]
    : [];
};

const runner: Runner = (command, cwd) => run(command, { cwd, timeoutMs: ROUND_TIMEOUT_MS });

export async function huntRound(input: {
  readonly root: string;
  readonly suite: HuntSuite;
  readonly seed: number;
  readonly round: number;
  readonly runner?: Runner;
}): Promise<RoundDoc> {
  const { suite, seed, round } = input;
  const command = ['bun', 'run', 'packages/cli/src/bin.ts', 'test', suite, '--json'];
  const spawned = await (input.runner ?? runner)(
    [...command, '--', '--randomize', `--seed=${seed}`],
    input.root,
  );
  const tail = spawned.output.split('\n').slice(-TAIL_LINES).join('\n');
  const doc = rec(jsonDocument(spawned.output));
  if (doc === undefined || typeof doc['ok'] !== 'boolean') {
    const unreadable: Finding = {
      code: 'X_FLAKE_HUNT_UNREADABLE',
      cause: `x test ${suite} exited ${spawned.code ?? 'at its deadline'} and printed no --json document`,
      fix: rerunCommand(suite, seed, undefined),
    };
    const rerun = rerunCommand(suite, seed, undefined);
    return { suite, seed, round, ok: false, failures: [], findings: [unreadable], rerun, tail };
  }
  const steps = list(doc['steps']).map(rec);
  const output = steps.map((step) => (step?.['ok'] === false ? step['output'] : undefined));
  const reproduce = rec(doc['data'])?.['reproduce'];
  return {
    suite,
    seed,
    round,
    ok: doc['ok'] && spawned.ok,
    failures: output.flatMap((text) => (typeof text === 'string' ? failedTests(text) : [])),
    findings: [
      ...list(doc['findings']).flatMap(findingOf),
      ...steps.flatMap((step) => list(step?.['findings']).flatMap(findingOf)),
    ],
    rerun: rerunCommand(suite, seed, typeof reproduce === 'string' ? reproduce : undefined),
    tail,
  };
}
