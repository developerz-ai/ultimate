// Every boot warning declares the roles it concerns. Production logged the same warnings in all five
// roles on every boot: a worker said its idempotency store was per process, though no request with
// an `Idempotency-Key` ever reaches a worker.

import { describe, expect, test } from 'bun:test';
import type { Role } from '@ultimat3/core';
import { ROLES } from '@ultimat3/core';
import { roleLoadFor } from './role-load';
import {
  BOOT_WARNINGS,
  bootWarningConcerns,
  bootWarningConcernsAny,
  warnAtBoot,
} from './serve-boot-warnings';

const SERVING: readonly Role[] = ROLES.filter((role) => role !== 'migrate');

/** Probes that each answer "I warned", recording which ran. */
function probes(ran: string[]) {
  return {
    idempotency: () => {
      ran.push('idempotency-process-scoped');
      return true;
    },
    mfa: async () => {
      ran.push('mfa-secret-unsealed');
      return 1;
    },
  };
}

describe('unit · boot warnings are filtered by role', () => {
  test('a worker, scheduler, sync or replicator boot logs no web-only warning', async () => {
    for (const role of ['worker', 'scheduler', 'sync', 'replicator'] as const) {
      const ran: string[] = [];
      expect(await warnAtBoot(role, probes(ran))).toEqual([]);
      expect(ran).toEqual([]);
    }
  });

  test('the web boot runs both, and reports what it said', async () => {
    const ran: string[] = [];
    expect(await warnAtBoot('web', probes(ran))).toEqual([
      'idempotency-process-scoped',
      'mfa-secret-unsealed',
    ]);
    expect(ran).toEqual(['idempotency-process-scoped', 'mfa-secret-unsealed']);
  });

  test('a probe that had nothing to say is not reported', async () => {
    const said = await warnAtBoot('web', { idempotency: () => false, mfa: async () => 0 });
    expect(said).toEqual([]);
  });

  test('every warning names at least one serving role, and only real roles', () => {
    for (const [warning, roles] of BOOT_WARNINGS) {
      expect(roles.length, warning).toBeGreaterThan(0);
      for (const role of roles) expect(SERVING).toContain(role);
    }
  });

  test('the unstamped build id concerns exactly the roles that load the background subset', () => {
    for (const role of SERVING) {
      expect(bootWarningConcerns('build-id-unstamped', role)).toBe(
        roleLoadFor(role) === 'background',
      );
    }
  });

  test('only the web role serves a guarded route; no limit is spent by a scheduler', () => {
    expect(SERVING.filter((role) => bootWarningConcerns('auth-unconfigured', role))).toEqual([
      'web',
    ]);
    expect(bootWarningConcerns('rate-limit-process-scoped', 'scheduler')).toBe(false);
    expect(bootWarningConcernsAny('auth-unconfigured', ['worker', 'web'])).toBe(true);
    expect(bootWarningConcernsAny('auth-unconfigured', ['worker', 'sync'])).toBe(false);
  });

  test('a value that is no warning concerns no role', () => {
    expect(bootWarningConcerns('toString' as never, 'web')).toBe(false);
  });
});
