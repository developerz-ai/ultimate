// One gate part on one compat cell: `scripts/verify.ts --only <step> --shard i/n --json`, the argv
// a `ci.yml` part runs, read back into the document `compat-file.ts` judges — the verdict, the
// failing tests (`flake-hunt-parse.ts`'s reader), the step findings and the line that replays it.

import type { CompatCell, CompatPart } from './compat-cells';
import { type FailedTest, failedTests } from './flake-hunt-parse';
import { jsonDocument } from './lib/health-narrow';
import type { Finding } from './lib/log';
import type { RunResult } from './lib/run';
import { run } from './lib/run';

/** Under the cell job's 15-minute kill switch: a part measured 150-276 s in the gate. */
const PART_TIMEOUT_MS = 13 * 60_000;
const TAIL_LINES = 40;

export type Runner = (command: readonly string[], cwd: string) => Promise<RunResult>;

/** What one part answered, as the filing job reads it back. */
export interface PartDoc {
  readonly cell: string;
  readonly part: string;
  /** The run attempt that wrote it: a re-run's newer document replaces the older. */
  readonly attempt: number;
  readonly ok: boolean;
  /** `Bun.version (Bun.revision)` the part ran on: a canary is named by its commit. */
  readonly bun: string;
  readonly failures: readonly FailedTest[];
  readonly findings: readonly Finding[];
  readonly rerun: string;
  readonly tail: string;
}

/** The commands that put a checkout on the cell's runtime and replay the part there. */
export function rerunOf(cell: CompatCell, part: CompatPart): string {
  const override = '/tmp/compat-compose.yml';
  const services = part.services.join(' ');
  const env = part.only === 'live' ? 'set -a; . docker/test-services.env; set +a; ' : '';
  const verify = `${env}bun run scripts/verify.ts --only ${part.only} --shard ${part.shard}`;
  if (cell.axis === 'postgres') {
    return [
      `bun run scripts/compat.ts prepare --cell ${cell.id} --compose-out ${override}`,
      `docker compose -f docker/docker-compose.test.yml -f ${override} up -d --wait --force-recreate ${services}`,
      verify,
    ].join(' && ');
  }
  if (cell.axis === 'solid')
    return `bun run scripts/compat.ts prepare --cell ${cell.id} && ${verify}`;
  const upgrade = cell.version === 'canary' ? 'bun upgrade --canary' : 'bun upgrade';
  return `${upgrade} && bun install --frozen-lockfile && ${verify}`;
}

const record = (value: unknown): Readonly<Record<string, unknown>> =>
  value !== null && typeof value === 'object' ? (value as Record<string, unknown>) : {};

const asFindings = (value: unknown): readonly Finding[] =>
  (Array.isArray(value) ? value : []).map(record).flatMap((one) => {
    const [code, cause, fix] = [one['code'], one['cause'], one['fix']];
    return typeof code === 'string' && typeof cause === 'string' && typeof fix === 'string'
      ? [{ code, cause, fix }]
      : [];
  });

const spawn: Runner = (command, cwd) => run(command, { cwd, timeoutMs: PART_TIMEOUT_MS });

export async function runPart(input: {
  readonly root: string;
  readonly cell: CompatCell;
  readonly part: CompatPart;
  readonly runner?: Runner;
  /** `GITHUB_RUN_ATTEMPT`; 1 off CI. */
  readonly attempt?: number;
}): Promise<PartDoc> {
  const { cell, part } = input;
  const command = ['bun', 'run', 'scripts/verify.ts', '--only', part.only];
  const spawned = await (input.runner ?? spawn)(
    [...command, '--shard', part.shard, '--json'],
    input.root,
  );
  const base = {
    cell: cell.id,
    part: part.name,
    attempt: input.attempt ?? 1,
    bun: `${Bun.version} (${Bun.revision})`,
    rerun: rerunOf(cell, part),
    tail: spawned.output.split('\n').slice(-TAIL_LINES).join('\n'),
  };
  const doc = jsonDocument(spawned.output);
  if (typeof record(doc)['ok'] !== 'boolean') {
    const finding: Finding = {
      code: 'X_COMPAT_UNREADABLE',
      cause: `scripts/verify.ts --only ${part.only} exited ${spawned.code ?? 'at its deadline'} on ${cell.id} and printed no --json document`,
      fix: base.rerun,
    };
    return { ...base, ok: false, failures: [], findings: [finding] };
  }
  const steps = (
    Array.isArray(record(doc)['steps']) ? (record(doc)['steps'] as unknown[]) : []
  ).map(record);
  const red = steps.filter((step) => step['ok'] === false);
  return {
    ...base,
    ok: record(doc)['ok'] === true && spawned.ok,
    failures: red.flatMap((step) =>
      typeof step['output'] === 'string' ? failedTests(step['output']) : [],
    ),
    findings: [
      ...asFindings(record(doc)['findings']),
      ...steps.flatMap((s) => asFindings(s['findings'])),
    ],
  };
}
