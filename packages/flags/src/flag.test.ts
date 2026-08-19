// The type rule and its runtime twin. `FlagExpiryIsMandatory` in `flag.ts` is what makes a
// temporary flag without an expiry a `tsc` failure; `toFlag` is what makes it a failure for a
// snapshot or a plain-JS caller, which have no types to be checked by.

import { describe, expect, test } from 'bun:test';
import { toFlag, withTargeting } from './flag';

const caught = (run: () => unknown): unknown => {
  try {
    run();
  } catch (thrown) {
    return thrown;
  }
  return undefined;
};

describe('unit · toFlag', () => {
  test('normalises a permanent flag to a null expiry and a null owner', () => {
    const flag = toFlag({
      kind: 'permanent',
      key: 'billing.dunning-emails',
      description: 'ops kill switch',
      targeting: { default: true },
    });
    expect(flag.expiresAt).toBeNull();
    expect(flag.expiresAtMs).toBeNull();
    expect(flag.owner).toBeNull();
  });

  test('precomputes the expiry so evaluation never parses a date', () => {
    const flag = toFlag({
      kind: 'temporary',
      key: 'checkout.new-tax-engine',
      description: 'scaffolding',
      owner: 'payments',
      expiresAt: '2026-01-01',
      targeting: { default: false },
    });
    expect(flag.expiresAtMs).toBe(Date.UTC(2026, 0, 1));
  });

  test('refuses an expiry that is not a date, whatever the types said', () => {
    const thrown = caught(() =>
      toFlag({
        kind: 'temporary',
        key: 'checkout.new-tax-engine',
        description: 'scaffolding',
        owner: 'payments',
        expiresAt: 'next sprint',
        targeting: { default: false },
      }),
    );
    expect(thrown).toBeUltimateError('X_FLAG_EXPIRY_INVALID');
  });

  test('refuses a missing expiry reaching it from untyped data', () => {
    const fromJson: unknown = {
      kind: 'temporary',
      key: 'checkout.new-tax-engine',
      description: 'scaffolding',
      owner: 'payments',
      targeting: { default: false },
    };
    // The cast is the whole point: this is the shape a store or a JS caller can still produce, and
    // the type-level rule cannot reach it. `X_FLAG_EXPIRY_INVALID` is what does.
    const thrown = caught(() => toFlag(fromJson as Parameters<typeof toFlag>[0]));
    expect(thrown).toBeUltimateError('X_FLAG_EXPIRY_INVALID');
  });

  test('validates targeting at declaration time, not at the first evaluation', () => {
    const thrown = caught(() =>
      toFlag({
        kind: 'permanent',
        key: 'search.rerank',
        description: 'switch',
        targeting: { default: false, rollout: 0.25 },
      }),
    );
    expect(thrown).toBeUltimateError('X_FLAG_TARGETING_INVALID');
  });
});

describe('unit · the type rule', () => {
  test('a temporary flag without an expiry does not typecheck', () => {
    const declare = (): unknown =>
      toFlag({
        kind: 'temporary',
        key: 'checkout.new-tax-engine',
        description: 'scaffolding',
        owner: 'payments',
        // @ts-expect-error — `expiresAt` is required on a temporary flag. Deleting this line is a
        // build error, which is the enforcement `FlagExpiryIsMandatory` pins in flag.ts.
        expiresAt: undefined,
        targeting: { default: false },
      });
    expect(caught(declare)).toBeUltimateError('X_FLAG_EXPIRY_INVALID');
  });
});

describe('unit · withTargeting', () => {
  test('replaces targeting and keeps the flag frozen', () => {
    const flag = toFlag({
      kind: 'permanent',
      key: 'search.rerank',
      description: 'switch',
      targeting: { default: false },
    });
    const retargeted = withTargeting(flag, { default: false, rollout: 10 });
    expect(retargeted.targeting.rollout).toBe(10);
    expect(flag.targeting.rollout).toBeUndefined();
    expect(Object.isFrozen(retargeted)).toBe(true);
  });

  test('refuses targeting that would silently switch the feature off for everyone', () => {
    const flag = toFlag({
      kind: 'permanent',
      key: 'search.rerank',
      description: 'switch',
      targeting: { default: false },
    });
    expect(caught(() => withTargeting(flag, { default: false, rollout: 0.5 }))).toBeUltimateError(
      'X_FLAG_TARGETING_INVALID',
    );
  });
});

// F5. The header above `Date.parse` claims the deadline is "the same instant on every node — no
// ambient zone". Only the bare-date form has that property: `Date.parse('2026-12-01T00:00:00')`
// resolves through the PROCESS's zone, which spreads one declared deadline across fourteen hours
// of a fleet, so `X_FLAG_EXPIRED` starts on different days on different pods.
describe('unit · toFlag refuses an expiry that has no zone in it', () => {
  const temporary = (expiresAt: string) => ({
    kind: 'temporary' as const,
    key: 'checkout.new-tax-engine',
    description: 'scaffolding',
    owner: 'payments',
    expiresAt,
    targeting: { default: false },
  });

  test('a bare local clock time is refused where it is declared', () => {
    expect(caught(() => toFlag(temporary('2026-12-01T00:00:00')))).toBeUltimateError(
      'X_FLAG_EXPIRY_INVALID',
    );
    expect(caught(() => toFlag(temporary('2026-12-01 09:30')))).toBeUltimateError(
      'X_FLAG_EXPIRY_INVALID',
    );
  });

  test('a bare date, a Z and an explicit offset all stay accepted', () => {
    expect(toFlag(temporary('2026-12-01')).expiresAtMs).toBe(Date.UTC(2026, 11, 1));
    expect(toFlag(temporary('2026-12-01T00:00:00Z')).expiresAtMs).toBe(Date.UTC(2026, 11, 1));
    expect(toFlag(temporary('2026-12-01T00:00:00+01:00')).expiresAtMs).toBe(
      Date.UTC(2026, 10, 30, 23),
    );
  });

  test('every accepted form answers the SAME instant in three process zones', () => {
    // `scripts/test-setup.ts` pins this process to UTC, so the whole failure is invisible in
    // process by construction — the zone has to come from outside the runner, exactly as
    // `packages/time/src/plain-date.test.ts` spawns one for the same reason.
    const source = [
      `import { toFlag } from '${import.meta.dir}/flag';`,
      "const forms = ['2026-12-01', '2026-12-01T00:00:00Z', '2026-12-01T00:00:00+01:00', '2026-12-01T00:00:00'];",
      'const answers = {};',
      'for (const expiresAt of forms) {',
      '  try {',
      "    answers[expiresAt] = toFlag({ kind: 'temporary', key: 'k', description: 'd', owner: 'o',",
      '      expiresAt, targeting: { default: false } }).expiresAtMs;',
      '  } catch { answers[expiresAt] = "refused"; }',
      '}',
      'console.log(JSON.stringify({ zone: Intl.DateTimeFormat().resolvedOptions().timeZone, answers }));',
    ].join('\n');
    const readIn = (zone: string): { zone: string; answers: Record<string, unknown> } => {
      const run = Bun.spawnSync(['bun', '-e', source], { env: { ...process.env, TZ: zone } });
      return JSON.parse(new TextDecoder().decode(run.stdout).trim()) as {
        zone: string;
        answers: Record<string, unknown>;
      };
    };

    const utc = readIn('UTC');
    const newYork = readIn('America/New_York');
    const tokyo = readIn('Asia/Tokyo');

    // The control: the subprocesses really do carry different zones, so a zone-sensitive parse
    // WOULD answer three different instants.
    expect([utc.zone, newYork.zone, tokyo.zone]).toEqual(['UTC', 'America/New_York', 'Asia/Tokyo']);
    expect(newYork.answers).toEqual(utc.answers);
    expect(tokyo.answers).toEqual(utc.answers);
    expect(utc.answers['2026-12-01T00:00:00']).toBe('refused');
  });
});
