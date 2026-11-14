// `bootWarning`: an app's role-scoped boot line. Said only where a booting role can act on it, once
// per process or once per build through the injected store, and refused when misdeclared.

import { afterEach, describe, expect, test } from 'bun:test';
import type { BootWarningLog, BuildOnceStore } from './boot-warning';
import {
  bootRolesConcerned,
  bootWarning,
  installBootWarnings,
  resetBootWarnings,
} from './boot-warning';
import { isUltimateError } from './errors';

afterEach(resetBootWarnings);

const recorder = () => {
  const lines: { message: string; fields: Readonly<Record<string, unknown>> }[] = [];
  const log: BootWarningLog = { warn: (message, fields) => void lines.push({ message, fields }) };
  return { lines, log };
};

const SPEC = {
  code: 'X_APP_CACHE_LOCAL',
  roles: ['web', 'worker'],
  message: 'the cache is process-local',
  fields: { driver: 'memory' },
} as const;

describe('unit · bootWarning', () => {
  test('said where a booting role is named, with the code and fields; silent elsewhere', async () => {
    const { lines, log } = recorder();
    expect(await bootWarning(SPEC, { roles: ['scheduler'], log })).toBe(false);
    expect(lines).toEqual([]);
    expect(await bootWarning(SPEC, { roles: ['sync', 'worker'], log })).toBe(true);
    expect(lines).toEqual([
      {
        message: 'the cache is process-local',
        fields: { code: 'X_APP_CACHE_LOCAL', driver: 'memory' },
      },
    ]);
  });

  test('a field named code never replaces the warning’s own code', async () => {
    const { lines, log } = recorder();
    await bootWarning({ ...SPEC, fields: { code: 'X_OTHER' } }, { roles: ['web'], log });
    expect(lines[0]?.fields).toEqual({ code: 'X_APP_CACHE_LOCAL' });
  });

  test('without once it is said every call; once: process says it once per process', async () => {
    const { lines, log } = recorder();
    await bootWarning(SPEC, { roles: ['web'], log });
    await bootWarning(SPEC, { roles: ['web'], log });
    expect(lines).toHaveLength(2);
    const once = { ...SPEC, once: 'process' } as const;
    expect(await bootWarning(once, { roles: ['web'], log })).toBe(true);
    expect(await bootWarning(once, { roles: ['web'], log })).toBe(false);
    expect(lines).toHaveLength(3);
    resetBootWarnings();
    expect(await bootWarning(once, { roles: ['web'], log })).toBe(true);
  });

  test('a role it does not concern leaves the process mark unspent', async () => {
    const { lines, log } = recorder();
    const once = { ...SPEC, once: 'process' } as const;
    await bootWarning(once, { roles: ['migrate'], log });
    await bootWarning(once, { roles: ['web'], log });
    expect(lines).toHaveLength(1);
  });

  test('once: build asks the injected store, for the first concerned role', async () => {
    const { lines, log } = recorder();
    const claims: unknown[] = [];
    let spent = false;
    const buildOnce: BuildOnceStore = async (claim, say) => {
      claims.push(claim);
      if (!spent) say();
      spent = true;
    };
    const build = { ...SPEC, once: 'build' } as const;
    expect(await bootWarning(build, { roles: ['sync', 'worker', 'web'], log, buildOnce })).toBe(
      true,
    );
    expect(await bootWarning(build, { roles: ['worker'], log, buildOnce })).toBe(false);
    expect(claims).toEqual([
      { code: 'X_APP_CACHE_LOCAL', role: 'worker' },
      { code: 'X_APP_CACHE_LOCAL', role: 'worker' },
    ]);
    expect(lines).toHaveLength(1);
  });

  test('once: build with no store installed falls back to once per process', async () => {
    const { lines, log } = recorder();
    const build = { ...SPEC, once: 'build' } as const;
    await bootWarning(build, { roles: ['web'], log });
    await bootWarning(build, { roles: ['web'], log });
    expect(lines).toHaveLength(1);
  });

  test('the installed context is the default, a call overrides it, and the release restores', async () => {
    const installed = recorder();
    const release = installBootWarnings({ roles: ['worker'], log: installed.log });
    try {
      expect(await bootWarning({ ...SPEC, roles: ['worker'] })).toBe(true);
      expect(await bootWarning({ ...SPEC, roles: ['web'] })).toBe(false);
      const own = recorder();
      expect(await bootWarning({ ...SPEC, roles: ['web'] }, { roles: ['web'], log: own.log })).toBe(
        true,
      );
      expect([installed.lines.length, own.lines.length]).toEqual([1, 1]);
    } finally {
      release();
    }
    const after = recorder();
    // Released: the role is the environment's again (`ROLE`, `web` when unset in a test run).
    await bootWarning({ ...SPEC, roles: ['worker'] }, { log: after.log, roles: ['web'] });
    expect(after.lines).toEqual([]);
  });

  const refused: readonly [string, Readonly<Record<string, unknown>>][] = [
    ['a code that is not X_SCREAMING_SNAKE', { code: 'cache-local' }],
    ['no roles', { roles: [] }],
    ['an unknown role', { roles: ['web', 'cron'] }],
    ['an empty message', { message: '' }],
    ['an unknown once', { once: 'deploy' }],
  ];
  for (const [what, override] of refused) {
    test(`${what} is refused with an instruction, before anything is said`, async () => {
      const { lines, log } = recorder();
      let caught: unknown;
      try {
        await bootWarning({ ...SPEC, ...override } as never, { roles: ['web'], log });
      } catch (error) {
        caught = error;
      }
      if (!isUltimateError(caught)) return expect.unreachable('the declaration was accepted');
      expect(caught.code).toBe('X_INVARIANT');
      expect(caught.fix).toContain('bootWarning({');
      expect(lines).toEqual([]);
    });
  }

  test('bootRolesConcerned is any-of, and an empty booting set concerns nobody', () => {
    expect(bootRolesConcerned(['web'], ['worker', 'web'])).toBe(true);
    expect(bootRolesConcerned(['web'], ['worker'])).toBe(false);
    expect(bootRolesConcerned(['web'], [])).toBe(false);
  });
});
