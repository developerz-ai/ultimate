// One verdict, read by the pass, the CLI and a deploy container alike. What each test pins is the
// refusal — the gate that ALLOWS is the easy half, and a gate that allowed everything would have
// passed a suite that only asserted the happy path.

import { describe, expect, test } from 'bun:test';
import type { Environment } from '@ultimat3/core';
import { BackfillEnvironmentError } from './backfill-errors';
import { checkBackfillEnvironment, gateBackfill } from './backfill-gate';
import type { BackfillProgress } from './backfill-inspect';
import type { BackfillDeclaration } from './backfill-registry';

const declaration = (over: Partial<BackfillDeclaration> = {}): BackfillDeclaration => ({
  kind: 'backfill',
  name: 'rewrite-titles',
  checksum: 'aaaa1111',
  requires: null,
  environments: null,
  counts: false,
  ...over,
});

const completedRun = (over: Partial<BackfillProgress> = {}): BackfillProgress => ({
  runId: 'run-1',
  name: 'rewrite-titles',
  checksum: 'aaaa1111',
  status: 'completed',
  appVersion: '1.2.0',
  rows: 40,
  cursor: null,
  startedAt: new Date(1_000).toISOString(),
  completedAt: new Date(2_000).toISOString(),
  durationMs: 1_000,
  ...over,
});

const gate = (over: Partial<Parameters<typeof gateBackfill>[0]> = {}) =>
  gateBackfill({
    declaration: declaration(),
    environment: 'production',
    appliedMigrations: undefined,
    completed: undefined,
    force: false,
    ...over,
  });

describe('unit · the environment check', () => {
  test('an ABSENT environments list means every environment — never "production only"', () => {
    for (const environment of ['development', 'test', 'staging', 'production'] as const) {
      expect(checkBackfillEnvironment('rewrite-titles', null, environment)).toBeUndefined();
      expect(checkBackfillEnvironment('rewrite-titles', [], environment)).toBeUndefined();
    }
  });

  test('a declared list this environment is not in refuses, and names both sides', () => {
    const error = checkBackfillEnvironment('rewrite-titles', ['production'], 'development');
    expect(error?.code).toBe('X_BACKFILL_ENVIRONMENT');
    expect(error?.cause).toContain('production');
    expect(error?.cause).toContain('development');
    // ONE runnable line. A `fix:` is copied and run verbatim, so the alternative edit — adding this
    // environment to the declaration — is stated in `cause`, which is read and never executed.
    expect(error?.fix).toBe('ULTIMATE_ENV=production x db backfill rewrite-titles --write --json');
    expect(error?.cause).toContain('environments');
  });

  test('a public constructor handed no environments still answers with a runnable command', () => {
    // Unreachable through `checkBackfillEnvironment` — an empty list means every environment — but
    // the class is exported, and `ULTIMATE_ENV=undefined …` is not a command.
    const error = new BackfillEnvironmentError({
      backfill: 'rewrite-titles',
      environment: 'test',
      declared: [],
    });
    expect(error.fix).toBe('x db backfill --pending --json');
  });

  test('a staging rehearsal is a declaration, not an exception the framework grants', () => {
    const declared: readonly Environment[] = ['staging', 'production'];
    expect(checkBackfillEnvironment('rewrite-titles', declared, 'staging')).toBeUndefined();
    expect(checkBackfillEnvironment('rewrite-titles', declared, 'test')?.code).toBe(
      'X_BACKFILL_ENVIRONMENT',
    );
  });
});

describe('unit · the gate', () => {
  test('a fresh declaration in an allowed environment runs', () => {
    expect(gate()).toEqual({ run: true });
  });

  test('environment is judged FIRST — nothing else matters if this process may not run it', () => {
    const verdict = gate({
      declaration: declaration({ environments: ['production'], requires: 'm-1' }),
      environment: 'development',
      appliedMigrations: [],
      completed: completedRun(),
    });
    expect(verdict.run).toBe(false);
    expect(verdict.run === false ? verdict.error.code : undefined).toBe('X_BACKFILL_ENVIRONMENT');
  });

  test('a required migration the ledger has not applied refuses, and names x db migrate', () => {
    const verdict = gate({
      declaration: declaration({ requires: '20260814120000_add_publish_at' }),
      appliedMigrations: ['20260101000000_init'],
    });
    expect(verdict.run).toBe(false);
    expect(verdict.run === false ? verdict.error.code : undefined).toBe(
      'X_BACKFILL_MIGRATION_PENDING',
    );
    expect(verdict.run === false ? verdict.error.fix : '').toContain('x db migrate');
  });

  test('an UNREADABLE migration ledger is not a refusal — "I could not check" blocks nothing', () => {
    // A driver with no database would otherwise make every `requires:` an unrunnable backfill.
    const verdict = gate({
      declaration: declaration({ requires: '20260814120000_add_publish_at' }),
      appliedMigrations: undefined,
    });
    expect(verdict).toEqual({ run: true });
  });

  test('a completed pass refuses without --force, and the fix is one runnable line', () => {
    const verdict = gate({ completed: completedRun() });
    expect(verdict.run).toBe(false);
    expect(verdict.run === false ? verdict.error.code : undefined).toBe('X_BACKFILL_APPLIED');
    // No prose after the command: a trailing clause makes the copied line a syntax error.
    expect(verdict.run === false ? verdict.error.fix : '').toBe(
      'x db backfill rewrite-titles --write --force --json',
    );
    // The ISO the ledger's own projection would print — no zone to get wrong.
    expect(verdict.run === false ? verdict.error.cause : '').toContain(
      new Date(2_000).toISOString(),
    );
  });

  test('--force runs a completed name again, and the gate says nothing else', () => {
    expect(gate({ completed: completedRun(), force: true })).toEqual({ run: true });
  });

  test('--force does NOT override the environment or the missing migration', () => {
    // Force is "sweep this name a second time", never "ignore every rail".
    const wrongEnv = gate({
      declaration: declaration({ environments: ['production'] }),
      environment: 'test',
      force: true,
    });
    expect(wrongEnv.run === false ? wrongEnv.error.code : undefined).toBe('X_BACKFILL_ENVIRONMENT');
    const unmigrated = gate({
      declaration: declaration({ requires: 'm-1' }),
      appliedMigrations: [],
      force: true,
    });
    expect(unmigrated.run === false ? unmigrated.error.code : undefined).toBe(
      'X_BACKFILL_MIGRATION_PENDING',
    );
  });
});
