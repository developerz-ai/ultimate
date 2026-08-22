// What a RUN means, as against what the gate means. Split from `cmd-verify.test.ts`, which had
// reached the 500-line ceiling: that file is about the step LIST — the contract — and this one is
// about the loop that executes one, including the narrowed run that is deliberately not a gate.

import { describe, expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
// Bun ships no temp-directory primitive, and `join` builds the host-separator path into it.
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { msg } from './messages';
import { exitCodeFor } from './output';
import { VERIFY_FLOOR_FILE } from './verify-floor';
import { runVerify } from './verify-run';
import type { VerifyContext, VerifyStep } from './verify-step';

/** The banner a narrowed run carries, from the catalog that renders it — never a second literal. */
const NOT_A_GATE_RUN = msg('cli.verify.notAGateRun', { summary: '' }).trim();

const runner: VerifyContext['runner'] = async () => ({
  command: ['true'],
  code: 0,
  ok: true,
  stdout: '',
  stderr: '',
  durationMs: 0,
});

const ran: string[] = [];

const stub = (name: VerifyStep['name'], ok: boolean): VerifyStep => ({
  name,
  summary: name,
  run: async () => {
    ran.push(name);
    return { ok, findings: ok ? [] : [{ code: 'X_DB_DRIFT', cause: 'c', fix: 'x db gen "f"' }] };
  },
});

const STEPS: readonly VerifyStep[] = [
  stub('typecheck', true),
  stub('lint', true),
  stub('drift', false),
];

interface RunJson {
  readonly failed: readonly string[];
  readonly skipped: readonly string[];
  readonly notAGateRun?: boolean;
  readonly only?: string;
}

const dataOf = (data: unknown): RunJson => data as RunJson;

/** The three-step fixture the moved block below runs against: one green, one red, one that does
 * not apply — every shape `runVerify` has to count differently. */
const ctx: VerifyContext = { root: '/nowhere', runner };

const stubs: readonly VerifyStep[] = [
  { name: 'typecheck', summary: 'tsc', run: async () => ({ ok: true, findings: [] }) },
  {
    name: 'drift',
    summary: 'schema vs migrations',
    run: async () => ({
      ok: false,
      findings: [
        {
          code: 'X_DB_DRIFT',
          cause: 'table "posts" has column "publish_at" not present in any migration',
          fix: 'x db gen "add publish_at"',
        },
      ],
    }),
  },
  {
    name: 'e2e',
    summary: 'playwright',
    applies: async () => false,
    run: async () => ({ ok: false, findings: [] }),
  },
];

describe('unit · x verify --only is an iteration loop, never the gate', () => {
  test('a narrowed run executes that step alone and says so twice', async () => {
    ran.length = 0;
    const result = await runVerify(STEPS, { root: '/nowhere', runner, only: 'lint' });
    expect(ran).toEqual(['lint']);
    expect(result.steps?.map((step) => step.name)).toEqual(['lint']);
    // The human line and the machine payload, because a caller reading only `--json` must not
    // mistake a narrowed run for a green gate. `summary` rides in the JSON body too.
    expect(result.summary.startsWith(NOT_A_GATE_RUN)).toBe(true);
    expect(dataOf(result.data).notAGateRun).toBe(true);
    expect(dataOf(result.data).only).toBe('lint');
  });

  test('it exits with the step own status, both ways', async () => {
    const green = await runVerify(STEPS, { root: '/nowhere', runner, only: 'typecheck' });
    expect([green.ok, exitCodeFor(green)]).toEqual([true, 0]);
    const red = await runVerify(STEPS, { root: '/nowhere', runner, only: 'drift' });
    expect([red.ok, exitCodeFor(red)]).toEqual([false, 1]);
    expect(red.steps?.[0]?.findings?.[0]?.code).toBe('X_DB_DRIFT');
  });

  test('the no-flag run is untouched: every step, and no banner', async () => {
    ran.length = 0;
    const result = await runVerify(STEPS, { root: '/nowhere', runner });
    expect(ran).toEqual(['typecheck', 'lint', 'drift']);
    expect(result.summary).not.toContain(NOT_A_GATE_RUN);
    expect(dataOf(result.data).notAGateRun).toBeUndefined();
    expect(dataOf(result.data).failed).toEqual(['drift']);
  });

  test('a narrowed run writes no floor file — the ratchet is the gate own', async () => {
    const root = await mkdtemp(join(tmpdir(), 'x-verify-only-'));
    try {
      await runVerify(STEPS, { root, runner, only: 'lint' });
      expect(existsSync(join(root, VERIFY_FLOOR_FILE))).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

// The summary is the line CI logs and the one a reader glances at, so it may not count a step
// that did not apply as one that passed. At the framework root `job` and `eval` have no suite of
// their own: "all 17 steps passed" over that is exactly the vacuous green the gate exists to
// prevent, and it is only visible if the summary itself says which steps had nothing to run.
describe('skips are counted apart from passes, and named', () => {
  const green: readonly VerifyStep[] = [
    { name: 'typecheck', summary: 'tsc', run: async () => ({ ok: true, findings: [] }) },
    { name: 'lint', summary: 'biome', run: async () => ({ ok: true, findings: [] }) },
  ];
  const inapplicable = (name: 'job' | 'eval'): VerifyStep => ({
    name,
    summary: 'no suite here',
    applies: async () => false,
    run: async () => ({ ok: false, findings: [] }),
  });

  test('nothing skipped: the line still claims every step, and says nothing about skips', async () => {
    const result = await runVerify(green, ctx);
    expect(result.summary).toContain('all 2 steps passed');
    expect(result.summary).not.toContain('skipped');
    expect(result.data).toMatchObject({ skipped: [] });
  });

  test('a green run with a skip reports the smaller pass count and names the step', async () => {
    const result = await runVerify([...green, inapplicable('job')], ctx);
    expect(result.ok).toBe(true);
    expect(result.summary).toContain('2 of 3 steps passed');
    expect(result.summary).toContain('1 skipped: job');
    expect(result.data).toMatchObject({ skipped: ['job'] });
  });

  test('every skipped step is named, in step order', async () => {
    const result = await runVerify([...green, inapplicable('job'), inapplicable('eval')], ctx);
    expect(result.summary).toContain('2 of 4 steps passed');
    expect(result.summary).toContain('2 skipped: job, eval');
    expect(result.data).toMatchObject({ skipped: ['job', 'eval'] });
  });

  // A red gate hides skips just as well as a green one: the reader fixes the failure, sees
  // green, and never learns two suites were never there.
  test('a red run carries the skips too', async () => {
    const result = await runVerify(stubs, ctx);
    expect(result.summary).toContain('1 of 3 steps failed');
    expect(result.summary).toContain('1 skipped: e2e');
    expect(result.data).toMatchObject({ failed: ['drift'], skipped: ['e2e'] });
  });
});
