// The enforcement half of `scripts/secret-compare.ts`: this file IS the build error. The gate's
// `unit` step runs every `scripts/**/*.test.ts`, so a `===` on a secret re-entering the tree fails
// `bun run verify` with no extra wiring.
//
// The test that matters is the last one in the first block: `@ultimat3/auth`'s twelve real
// `timingSafeEqual` call sites, each rewritten to `===` exactly as the mutation run did, asserted
// to be REPORTED. That mutation left the package at 432 pass · 14 skip · 0 fail.

import { describe, expect, test } from 'bun:test';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { repoRoot } from './lib/run';
import {
  applySecretCompareUnpin,
  SECRET_COMPARE_PINS,
  SECRET_PINS_FILE,
  type SecretComparePin,
} from './lib/secret-compare-pins';
import {
  checkSecretCompares,
  isInert,
  namesASecret,
  operandAfter,
  operandBefore,
  scanSecretCompares,
  secretCompareFindingFor,
  secretCompareGaps,
} from './secret-compare';

const names = (source: string): readonly string[] =>
  scanSecretCompares('packages/auth/src/a.ts', source).map((site) => site.name);

describe('a secret compared with a short-circuiting operator', () => {
  test('is reported, and the finding names timingSafeEqual', () => {
    const gaps = checkSecretCompares({
      files: [
        {
          path: 'packages/auth/src/session.ts',
          source: 'if (sha256Hex(parsed.secret) === session.tokenHash) return;',
        },
      ],
      pins: {},
    });
    expect(gaps).toHaveLength(1);
    const finding = secretCompareFindingFor(gaps[0] as never);
    expect(finding.code).toBe('X_SECRET_COMPARED_UNSAFELY');
    expect(finding.at).toBe('packages/auth/src/session.ts:1');
    expect(finding.fix).toContain('timingSafeEqual');
    expect(finding.fix).toContain(SECRET_PINS_FILE);
  });

  test('`.includes()` on a secret argument is reported too', () => {
    expect(names('if (usedCodes.includes(recoveryCandidate)) return false;')).toEqual([
      'recoveryCandidate',
    ]);
  });

  test('but not on a secret RECEIVER — a public list is what a membership test reads', () => {
    expect(names('if (KNOWN_ROLES.includes(role)) return true;')).toEqual([]);
  });

  /**
   * `grep -n timingSafeEqual packages/auth/src/*.ts`, each call rewritten to the `===` the
   * mutation run used. Eleven of the twelve are named; `oauth-cookie.ts:117` is the one this rule
   * cannot see, and it is asserted below rather than left as a surprise.
   */
  const MUTATED: readonly (readonly [string, string])[] = [
    ['tokens.ts', 'return sha256Hex(plaintext) === storedHash;'],
    ['memory-adapter.ts', 'if (tokenHash !== record.tokenHash) return null;'],
    ['id-token.ts', "if (provider.usesNonce && input.nonce !== claims.nonce) throw x('bad');"],
    ['mfa.ts', 'if (totpCode(input.secret, step) !== candidate) continue;'],
    ['mfa.ts', 'if (!matched && hash === candidate) {'],
    ['oauth.ts', 'if (handshake.state !== callback.state) {'],
    ['oauth.ts', 'if (handshake.nonce !== callback.nonce) {'],
    ['auth.ts', 'if (sha256Hex(parsed.secret) !== session.tokenHash) return false;'],
    ['verify.ts', 'if (tokenHash !== record.tokenHash) {'],
    ['session.ts', 'if (sha256Hex(parsed.secret) !== session.tokenHash) throw sessionUnknown();'],
    ['api-keys.ts', 'if (sha256Hex(parsed.secret) !== record.keyHash) throw apiKeyInvalid();'],
  ];

  test('every auth timingSafeEqual site the mutation degraded is reported', () => {
    for (const [file, source] of MUTATED) {
      expect(scanSecretCompares(`packages/auth/src/${file}`, source)).not.toEqual([]);
    }
  });

  /**
   * The honest gap, written down rather than discovered later: `oauth-cookie.ts:117` compares
   * `expected` against `sealed.slice(dot + 1)`, and neither name is in the vocabulary. Adding
   * `expected` would report a hundred ordinary comparisons; the miss is the cheaper of the two.
   */
  test('and the one it cannot see is the one whose operands are named nothing', () => {
    expect(
      scanSecretCompares(
        'packages/auth/src/oauth-cookie.ts',
        'if (expected !== sealed.slice(dot + 1)) {',
      ),
    ).toEqual([]);
  });
});

describe('what the rule stays silent about, and why', () => {
  test('a presence check leaks no byte, so it is not a comparison this rule has an opinion on', () => {
    expect(names('if (token === null) return;')).toEqual([]);
    expect(names('if (secret.length === 0) return;')).toEqual([]);
    expect(names('if (patch.passwordHash === undefined) return;')).toEqual([]);
    expect(names('if (user.mfaSecret !== null) return;')).toEqual([]);
  });

  test('a comparison against a string LITERAL reads a constant that is already in the source', () => {
    expect(names("if (record.state === 'running') return;")).toEqual([]);
    expect(names("if (typeof state !== 'string') throw x();")).toEqual([]);
  });

  test('a bare `key` is a Map key, and 362 sites in this tree prove it', () => {
    expect(namesASecret('key')).toBeUndefined();
    expect(namesASecret('keys')).toBeUndefined();
    expect(namesASecret('scope.key')).toBeUndefined();
    // The capital is what makes it a credential name.
    expect(namesASecret('record.keyHash')).toBe('keyHash');
    expect(namesASecret('input.apiKey')).toBe('apiKey');
  });

  test('a comparison inside a string literal is a scaffold template, not this file own code', () => {
    expect(names('const t = `if (tokenHash === stored) return;`;')).toEqual([]);
  });
});

describe('the operand walk', () => {
  test('reads back over a call and its arguments', () => {
    const code = 'if (sha256Hex(parsed.secret) === stored) {';
    expect(operandBefore(code, code.indexOf('===')).trim()).toBe('sha256Hex(parsed.secret)');
  });

  test('reads forward over a member chain and a call', () => {
    const code = 'a === sealed.slice(dot + 1);';
    expect(operandAfter(code, code.indexOf('===') + 3).trim()).toBe('sealed.slice(dot + 1)');
  });

  test('an unreadable operand is inert — the walk stopping is not evidence of a secret', () => {
    expect(isInert('')).toBe(true);
    expect(isInert('  ')).toBe(true);
    expect(isInert('record.tokenHash')).toBe(false);
  });
});

describe('the ratchet moves in one direction', () => {
  test('a package over its pin is a finding; at its pin it is not', () => {
    const files = [
      { path: 'packages/x/src/a.ts', source: 'if (a.tokenHash === b.tokenHash) return;' },
    ];
    expect(checkSecretCompares({ files, pins: {} })).toHaveLength(1);
    expect(checkSecretCompares({ files, pins: { x: { count: 1, reason: 'a fixture' } } })).toEqual(
      [],
    );
  });

  test('a pin above what the tree holds is stale, with the command that lowers it', () => {
    const gaps = checkSecretCompares({
      files: [{ path: 'packages/x/src/a.ts', source: 'const a = 1;' }],
      pins: { x: { count: 2, reason: 'a fixture' } },
    });
    expect(gaps.map((gap) => gap.kind)).toEqual(['stale']);
    const finding = secretCompareFindingFor(gaps[0] as never);
    expect(finding.code).toBe('X_SECRET_COMPARE_PIN_STALE');
    expect(finding.fix).toBe('bun run scripts/secret-compare.ts --unpin x');
  });

  test('an empty corpus is UNSCANNED, never a clean tree', () => {
    const gaps = checkSecretCompares({ files: [], pins: {} });
    expect(secretCompareFindingFor(gaps[0] as never).code).toBe('X_SECRET_COMPARE_UNSCANNED');
  });

  test('every pin carries a sentence saying what the value is — a blank one is a waiver', () => {
    for (const [pkg, pin] of Object.entries(SECRET_COMPARE_PINS)) {
      expect(`${pkg}: ${pin.reason}`.length).toBeGreaterThan(pkg.length + 60);
      expect(pin.count).toBeGreaterThan(0);
    }
  });

  /** `@ultimat3/auth` is the package this rule was written for, and it is at zero. */
  test('auth holds no pin, because every comparison there goes through timingSafeEqual', () => {
    expect(Object.hasOwn(SECRET_COMPARE_PINS, 'auth')).toBe(false);
  });

  test('--unpin lowers a count to what is measured and refuses to raise one', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ultimate-secret-pins-'));
    const path = join(dir, SECRET_PINS_FILE);
    await Bun.write(path, await Bun.file(join(repoRoot(), SECRET_PINS_FILE)).text());
    const fixture: Readonly<Record<string, SecretComparePin>> = {
      jobs: { count: 5, reason: 'a fixture' },
      time: { count: 1, reason: 'a fixture' },
    };

    expect(await applySecretCompareUnpin(dir, ['jobs'], { jobs: 9 }, fixture)).toEqual([]);
    expect(await applySecretCompareUnpin(dir, ['jobs'], { jobs: 2 }, fixture)).toEqual([
      'jobs -> 2',
    ]);
    expect(await Bun.file(path).text()).toContain('count: 2,');

    // Zero deletes the whole entry, reason and all — a row claiming a debt of zero reads as a
    // rule still in force over nothing.
    expect(await applySecretCompareUnpin(dir, ['time'], {}, fixture)).toEqual(['time -> 0']);
    const after = await Bun.file(path).text();
    expect(after).not.toContain('  time: {');
    expect(after).toContain('  jobs: {');
  });
});

describe('against this repo', () => {
  test('the tree is on the ratchet — every site is pinned with a sentence', async () => {
    expect(await secretCompareGaps(repoRoot())).toEqual([]);
  });
});
