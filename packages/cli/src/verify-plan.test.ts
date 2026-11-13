// The CI plan is the gate, cut: every step in exactly one part or in every shard of one split, for
// any runner count — and the framework's own hand-written `ci.yml` matrix is the plan at seven.

import { describe, expect, test } from 'bun:test';
// why: Bun has no mkdtemp and no recursive remove; the dispatch test needs a throwaway app root.
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
// why: Bun exposes no tmpdir(), so only node:os answers the platform temp root.
import { tmpdir } from 'node:os';
// why: Bun ships no path-joining primitive; the repository's workflow is read from this file's dir.
import { join } from 'node:path';
import { UltimateError } from '@ultimat3/core';
import { YAML } from 'bun';
import { verifyCommand } from './cmd-verify';
import type { FlagValue, ParsedArgs } from './parse';
import { parseArgs } from './parse';
import { SPECS } from './registry';
import type { PlanPart } from './verify-plan';
import {
  DEFAULT_PLAN_PARTS,
  planMatrix,
  readPlanParts,
  verifyPlan,
  verifyPlanCommand,
} from './verify-plan';
import { SHARDABLE_STEPS } from './verify-shard';
import { VERIFY_STEP_NAMES } from './verify-step';

const args = (flags: Readonly<Record<string, FlagValue>> = {}): ParsedArgs => ({
  command: 'verify',
  subcommand: 'plan',
  positionals: [],
  flags: new Map(Object.entries(flags)),
  json: true,
  help: false,
  passthrough: [],
});

/** Every way a plan fails to be the gate, as sentences; empty when it is the gate exactly once. */
const gaps = (plan: readonly PlanPart[]): readonly string[] => {
  const out: string[] = [];
  const names = plan.map((part) => part.part);
  if (new Set(names).size !== names.length) out.push(`a part name repeats: ${names.join(', ')}`);
  for (const step of VERIFY_STEP_NAMES) {
    const owners = plan.filter((part) => part.only.includes(step));
    const whole = owners.filter((part) => part.shard === undefined);
    const sharded = owners.filter((part) => part.shard !== undefined);
    if (owners.length === 0) out.push(`${step} is in no part`);
    else if (whole.length > 1 || (whole.length === 1 && sharded.length > 0)) {
      out.push(`${step} is in ${String(owners.length)} parts`);
    } else if (sharded.length > 0) {
      if (!SHARDABLE_STEPS.includes(step)) out.push(`${step} is sharded and cannot be`);
      const total = sharded.length;
      const seen = sharded.map((part) => part.shard).sort();
      const want = Array.from({ length: total }, (_, at) => `${String(at + 1)}/${String(total)}`);
      if (JSON.stringify(seen) !== JSON.stringify(want.sort())) {
        out.push(`${step} shards ${seen.join(', ')}, not 1..${String(total)}`);
      }
    }
  }
  for (const part of plan) {
    const order = VERIFY_STEP_NAMES.filter((name) => part.only.includes(name));
    if (JSON.stringify(order) !== JSON.stringify(part.only))
      out.push(`${part.part} is out of order`);
  }
  return out;
};

describe('unit · x verify plan · the parts are the gate', () => {
  test.each([1, 4, 5, 6, 7, 12, 64])('%i runners: every step once, every split whole', (n) => {
    const plan = verifyPlan(n);
    expect(plan.length).toBe(n);
    expect(gaps(plan)).toEqual([]);
  });

  test('one runner is the whole gate with every service; the static part starts nothing', () => {
    expect(verifyPlan(1)).toEqual([{ part: 'gate', only: VERIFY_STEP_NAMES, needs: 'services' }]);
    expect(verifyPlan(4).find((part) => part.part === 'static')?.needs).toBe('none');
  });

  test('the matrix carries shard only where there is one, and only comma-joined', () => {
    const include = planMatrix(verifyPlan(4)).include as readonly Record<string, unknown>[];
    expect(include.map((row) => row['part'])).toEqual(['unit-1', 'live-1', 'static', 'e2e']);
    expect(include.find((row) => row['part'] === 'static')).not.toHaveProperty('shard');
    expect(include.find((row) => row['part'] === 'e2e')?.['only']).toBe('typecheck,e2e');
  });
});

describe('unit · x verify plan · --parts', () => {
  test(`absent is ${String(DEFAULT_PLAN_PARTS)}; 1 and 4..64 are accepted`, () => {
    expect(readPlanParts(args())).toBe(DEFAULT_PLAN_PARTS);
    expect(readPlanParts(args({ parts: '1' }))).toBe(1);
    expect(readPlanParts(args({ parts: '64' }))).toBe(64);
  });

  test.each(['0', '2', '3', '65', '4abc', '-4'])(
    '%s is X_CLI_BAD_FLAG with a runnable fix',
    (raw) => {
      try {
        readPlanParts(args({ parts: raw }));
        expect.unreachable(`--parts ${raw} was accepted`);
      } catch (error) {
        expect(error).toBeInstanceOf(UltimateError);
        expect((error as UltimateError).code).toBe('X_CLI_BAD_FLAG');
        expect((error as UltimateError).fix).toBe('x verify plan --parts 4 --json');
      }
    },
  );

  test('the document is the matrix, ok, under data.matrix', () => {
    const result = verifyPlanCommand(args({ parts: '7' }));
    expect(result.ok).toBe(true);
    expect(result.data).toEqual({ parts: 7, matrix: planMatrix(verifyPlan(7)) });
  });

  // The scaffolded workflow's first job runs `bun run verify plan --json`: the parser must take the
  // subcommand and its flag, and `x verify` must answer it — not start the gate.
  test('`x verify plan --parts 4` parses and dispatches to the plan, spawning nothing', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'x-verify-plan-'));
    try {
      writeFileSync(join(dir, 'app.config.ts'), 'export default {};\n');
      const result = await verifyCommand.run({
        cwd: dir,
        args: parseArgs(['verify', 'plan', '--parts', '4', '--json'], SPECS),
        env: {},
        runner: async () => expect.unreachable('the plan spawns nothing'),
      } as unknown as Parameters<typeof verifyCommand.run>[0]);
      expect(result.command).toBe('verify plan');
      expect(result.data).toEqual({ parts: 4, matrix: planMatrix(verifyPlan(4)) });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// The framework's own `ci.yml` stays hand-written — it carries per-part services and URLs only
// this repository has — and this holds it to the plan: a step added to the gate, or a part edited
// out of the matrix, is red here before it is `X_VERIFY_MERGE_INCOMPLETE` after a push.
describe('unit · x verify plan · the framework repository’s ci.yml is the plan at seven', () => {
  const workflow = join(import.meta.dir, '..', '..', '..', '.github', 'workflows', 'ci.yml');

  test('every gate part: the same name, steps and shard, and the services its level needs', async () => {
    const doc = YAML.parse(await Bun.file(workflow).text()) as {
      readonly jobs: { readonly gate: { readonly strategy: { readonly matrix: unknown } } };
    };
    const rows = (doc.jobs.gate.strategy.matrix as { include: readonly Record<string, unknown>[] })
      .include;
    const needsOf = (services: unknown): string =>
      services === undefined ? 'none' : services === 'postgres' ? 'database' : 'services';
    const repo = rows.map((row) => ({
      part: row['part'],
      only: row['only'],
      ...(row['shard'] === undefined ? {} : { shard: row['shard'] }),
      needs: needsOf(row['services']),
    }));
    const planned: readonly unknown[] = planMatrix(verifyPlan(rows.length)).include;
    expect(repo).toEqual(planned as typeof repo);
  });
});
