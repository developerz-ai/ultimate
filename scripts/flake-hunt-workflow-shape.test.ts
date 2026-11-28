// The shape of `.github/workflows/flake-hunt.yml` that keeps the nightly hunt honest: off the gate,
// both suites shuffled twice, a red round's exit kept (`pipefail`) and its document uploaded,
// and `issues: write` held by the filing job alone. Reads the REAL workflow.

import { describe, expect, setDefaultTimeout, test } from 'bun:test';
import { REPO_SCAN_TIMEOUT_MS, repoRoot } from './lib/run';

setDefaultTimeout(REPO_SCAN_TIMEOUT_MS);

interface Step {
  readonly name?: string;
  readonly if?: string;
  readonly uses?: string;
  readonly run?: string;
  readonly shell?: string;
}

interface Job {
  readonly needs?: string;
  readonly if?: string;
  readonly permissions?: Readonly<Record<string, string>>;
  readonly strategy?: { readonly matrix?: Readonly<Record<string, readonly unknown[]>> };
  readonly steps?: readonly Step[];
}

interface Workflow {
  readonly on?: Readonly<Record<string, unknown>>;
  readonly permissions?: Readonly<Record<string, string>>;
  readonly jobs?: Readonly<Record<string, Job>>;
}

const text = await Bun.file(`${repoRoot()}/.github/workflows/flake-hunt.yml`).text();
const workflow = Bun.YAML.parse(text) as Workflow;
const round = workflow.jobs?.['round'];
const file = workflow.jobs?.['file'];
/** GitHub's expression for "after a red job too", spelt once: its `${` is not a template. */
const NOT_CANCELLED = ['$', '{{ !cancelled() }}'].join('');
const hunt = round?.steps?.find((step) => step.run?.includes('scripts/flake-hunt.ts run'));

describe('unit · flake-hunt.yml is nightly and never a gate', () => {
  test('a schedule and a manual dispatch, nothing a push or a PR starts', () => {
    expect(Object.keys(workflow.on ?? {}).sort()).toEqual(['schedule', 'workflow_dispatch']);
  });

  // Two, since 2026-11-27: a third `unit` round was ~20 of the night's ~83 billed minutes, and each
  // round shuffles under a fresh seed, so a night's coverage is rounds × nights — the seven-night
  // `tests-deterministic` row (`scripts/finished-github.ts`) still reads fourteen orders a suite.
  test('both suites, two rounds each', () => {
    expect(round?.strategy?.matrix?.['suite']).toEqual(['unit', 'live']);
    expect(round?.strategy?.matrix?.['round']).toEqual([1, 2]);
  });
});

describe('unit · a red round stays red and reaches the filing job', () => {
  test('the round step keeps its exit through tee', () => {
    expect(hunt?.shell).toBe('bash');
    expect(hunt?.run).toContain('set -o pipefail');
  });

  test('the round document is uploaded and filed after a red round too', () => {
    const upload = round?.steps?.find((step) => step.uses?.startsWith('actions/upload-artifact@'));
    expect(upload?.if).toBe(NOT_CANCELLED);
    expect(file?.needs).toBe('round');
    expect(file?.if).toBe(NOT_CANCELLED);
    expect(file?.steps?.some((step) => step.run?.includes('scripts/flake-hunt.ts file'))).toBe(
      true,
    );
  });
});

describe('unit · least privilege', () => {
  test('read-only at the top; issues: write on the filing job alone', () => {
    expect(workflow.permissions).toEqual({ contents: 'read' });
    expect(round?.permissions).toBeUndefined();
    expect(file?.permissions).toEqual({ contents: 'read', issues: 'write' });
  });
});
