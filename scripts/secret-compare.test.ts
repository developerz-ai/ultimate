// The enforcement half of `scripts/secret-compare.ts`: this file IS the build error. The gate's
// `unit` step runs every `scripts/**/*.test.ts`, so a `===` on a secret re-entering the tree fails
// `bun run verify` with no extra wiring.
//
// The test that matters is the last one in the first block: `@ultimat3/auth`'s twelve real
// `timingSafeEqual` call sites, each rewritten to `===` exactly as the mutation run did, asserted
// to be REPORTED. That mutation left the package at 432 pass · 14 skip · 0 fail.

import { afterAll, describe, expect, setDefaultTimeout, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises'; // why: Bun has no mkdtemp.
// why: Bun exposes no tmpdir(), so only node:os answers the platform temp root.
import { tmpdir } from 'node:os';
// why: Bun exposes no path-join primitive; Bun.file and import() take one already joined.
import { join } from 'node:path';
import { applyUnpin } from './lib/ratchet';
import { REPO_SCAN_TIMEOUT_MS, repoRoot } from './lib/run';
import {
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
  secretCompareSiteKey,
  secretCompareUnpinRows,
} from './secret-compare';

/** Every temp dir this file makes, removed after it: a fixture that outlives its run is a leftover (#738). */
const madeDirs: string[] = [];
afterAll(async () => {
  for (const dir of madeDirs.splice(0)) await rm(dir, { recursive: true, force: true });
});
/** Records a directory `mkdtemp` made, for the removal above. */
const made = (dir: string): string => {
  madeDirs.push(dir);
  return dir;
};

// Reads the real tree, so it runs on the repo-scan backstop rather than Bun's 5000ms
// default — see `REPO_SCAN_TIMEOUT_MS`. A backstop, not an assertion: nothing here is meant
// to take minutes, and a test that does has hung.
setDefaultTimeout(REPO_SCAN_TIMEOUT_MS);

const names = (source: string): readonly string[] =>
  scanSecretCompares('packages/auth/src/a.ts', source).map((site) => site.name);

const A_SITE = 'packages/auth/src/a.ts: a.tokenHash === b.tokenHash';
const pin = (
  count: number,
  reason = 'a content hash this process computed, to detect a change',
) => ({
  count,
  reason,
});

describe('a secret compared with a short-circuiting operator', () => {
  test('a pin holds ITS site only: a second comparison in the same package is its own finding', () => {
    const gaps = checkSecretCompares({
      files: [
        { path: 'packages/auth/src/a.ts', source: 'if (a.tokenHash === b.tokenHash) return;' },
        { path: 'packages/auth/src/b.ts', source: 'if (x.apiSecret === y.apiSecret) return;' },
      ],
      pins: { [A_SITE]: pin(1) },
    });
    expect(gaps.map((gap) => gap.pkg)).toEqual([
      'packages/auth/src/b.ts: x.apiSecret === y.apiSecret',
    ]);
    const finding = secretCompareFindingFor(gaps[0] as never);
    expect(finding.cause).toContain('in 1 place(s), pinned at 0');
    expect(finding.cause).toContain('x.apiSecret === y.apiSecret');
    expect(finding.at).toBe('packages/auth/src/b.ts:1');
    expect(finding.fix).toContain(
      "add the row 'packages/auth/src/b.ts: x.apiSecret === y.apiSecret'",
    );
  });

  // Sweep 11 R4: per-package counts let a pinned false positive be swapped for a real one.
  test('a pinned comparison deleted and a real one added in its place is still reported', () => {
    const gaps = checkSecretCompares({
      files: [
        {
          path: 'packages/auth/src/a.ts',
          source: 'if (session.token === presented.token) return;',
        },
      ],
      pins: { [A_SITE]: pin(1) },
    });
    expect(gaps.map((gap) => [gap.kind, gap.pkg])).toEqual([
      ['stale', A_SITE],
      ['over', 'packages/auth/src/a.ts: session.token === presented.token'],
    ]);
    expect(secretCompareFindingFor(gaps[0] as never).fix).toBe(
      'bun run scripts/secret-compare.ts --unpin packages/auth/src/a.ts',
    );
  });

  test('a site key is the file and the comparison, whitespace squeezed — never the line', () => {
    const [site] = scanSecretCompares('packages/x/src/a.ts', '\n\nif (a.tokenHash ===\n    b) {}');
    if (site === undefined) expect.unreachable('the scan found the site');
    expect(secretCompareSiteKey(site)).toBe('packages/x/src/a.ts: a.tokenHash === b');
  });

  test('--unpin <path> names every row of that file and nothing of another', () => {
    const pins = { [A_SITE]: pin(1), 'packages/auth/src/a.tsx: x === tokenHash': pin(1) };
    expect(secretCompareUnpinRows('packages/auth/src/a.ts', pins)).toEqual([A_SITE]);
    expect(secretCompareUnpinRows(A_SITE, pins)).toEqual([A_SITE]);
  });

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

/**
 * `SECRET_WORDS`' own comment said "whole and case-insensitive" and the pattern carried no `i`, so
 * every SCREAMING_SNAKE credential in the tree read as an ordinary identifier — the spelling a
 * module-scope constant actually uses. `packages/storage/src/driver-local.ts` compares a
 * `DEV_SIGNING_SECRET` and `@ultimat3/storage` was absent from the pin table entirely.
 */
/**
 * `candidate` is in the vocabulary for `mfa.ts`, where it is a recovery code. As the PARAMETER of
 * an array predicate it is the element under test — a route, a table, a waiter — and 20 of the
 * tree's 22 `candidate` sites were exactly that, each needing a sentence in the pins table to say
 * so. The name is ignored THERE and nowhere else, and only the name: what it is compared WITH is
 * still read.
 */
describe('a predicate`s own parameter named candidate is the element under test, not a secret', () => {
  test('find, filter, some, every and the findIndex family, in every arrow spelling', () => {
    for (const source of [
      'const route = routes.find((candidate) => candidate.path === path);',
      'this.waiters = this.waiters.filter((candidate) => candidate !== waiter);',
      'return members.some(candidate => candidate === value);',
      'const at = tables.findIndex((candidate: Table, index) => candidate.name === table);',
      'const ok = names.every((candidate) => allowed.includes(candidate));',
      'const hit = rows.findLast((candidate) => {\n  return sidOf(candidate) === sid;\n});',
    ]) {
      expect(names(source)).toEqual([]);
    }
  });

  test('what the element is compared WITH is still read: a secret on the other side reports', () => {
    expect(names('codes.find((candidate) => candidate.hash === hash);')).toEqual(['hash']);
    expect(names('codes.some((candidate) => candidate === token);')).toEqual(['token']);
    expect(names('keys.find((candidate) => candidate.tokenHash === given);')).toEqual([
      'tokenHash',
    ]);
    expect(names('codes.some((candidate) => stored.includes(candidate.secret));')).toEqual([
      'secret',
    ]);
  });

  test('candidate anywhere else is still the recovery code it was added for', () => {
    // A loop variable, a function parameter, and a use AFTER the predicate has closed.
    expect(names('for (const candidate of codes) if (totp(step) !== candidate) continue;')).toEqual(
      ['candidate'],
    );
    expect(names('function verify(candidate) { return stored === candidate; }')).toEqual([
      'candidate',
    ]);
    expect(
      names('const hit = xs.find((candidate) => ok(candidate));\nif (candidate === stored) {}'),
    ).toEqual(['candidate']);
    // A callback that is not a predicate — `map` builds a value, it does not test one.
    expect(names('xs.map((candidate) => candidate === stored);')).toEqual(['candidate']);
    // A PROPERTY called candidate is not the parameter.
    expect(names('xs.find((candidate) => entry.candidate === given);')).toEqual(['candidate']);
  });

  test('only that one name: a predicate over tokens is a credential check', () => {
    expect(names('tokens.find((token) => token === presented);')).toEqual(['token']);
    expect(names('hashes.some((hash) => hash === computed);')).toEqual(['hash']);
  });
});

describe('the vocabulary reads the spelling a constant is really written in', () => {
  test('SCREAMING_SNAKE is the same word as camelCase', () => {
    expect(namesASecret('SESSION_SECRET')).toBe('SESSION_SECRET');
    expect(namesASecret('WEBHOOK_SECRET')).toBe('WEBHOOK_SECRET');
    expect(namesASecret('API_KEY')).toBe('API_KEY');
    expect(namesASecret('CSRF_TOKEN')).toBe('CSRF_TOKEN');
    expect(namesASecret('DEV_SIGNING_SECRET')).toBe('DEV_SIGNING_SECRET');
    expect(names('if (supplied === DEV_SIGNING_SECRET) return;')).toEqual(['DEV_SIGNING_SECRET']);
  });

  test('a password and a one-time code are credentials the list never named', () => {
    expect(namesASecret('password')).toBe('password');
    expect(namesASecret('PASSWORD')).toBe('PASSWORD');
    expect(namesASecret('input.userPassword')).toBe('userPassword');
    expect(namesASecret('otp')).toBe('otp');
    expect(namesASecret('OTP')).toBe('OTP');
  });

  test('an uppercase run before the suffix is still one name', () => {
    expect(namesASecret('CSRFToken')).toBe('CSRFToken');
  });

  /**
   * The bare-`key` exclusion is what keeps 362 `Map` keys out of the report, and case-insensitivity
   * must not reopen it: a suffix needs a BOUNDARY in front of it — a camelCase capital or the
   * SNAKE underscore — so `monkey` and a bare `Key` are still nothing.
   */
  test('and a bare key is still a Map key, in every spelling', () => {
    expect(namesASecret('key')).toBeUndefined();
    expect(namesASecret('Key')).toBeUndefined();
    expect(namesASecret('monkey')).toBeUndefined();
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
  const X_SITE = 'packages/x/src/a.ts: a.tokenHash === b.tokenHash';

  test('a site over its pin is a finding; at its pin it is not', () => {
    const files = [
      { path: 'packages/x/src/a.ts', source: 'if (a.tokenHash === b.tokenHash) return;' },
    ];
    expect(checkSecretCompares({ files, pins: {} })).toHaveLength(1);
    expect(checkSecretCompares({ files, pins: { [X_SITE]: pin(1) } })).toEqual([]);
    // A per-PACKAGE row holds nothing any more: the key names no site.
    expect(checkSecretCompares({ files, pins: { x: pin(1) } }).map((gap) => gap.kind)).toEqual([
      'over',
      'stale',
    ]);
  });

  test('a pin above what the tree holds is stale, with the command that lowers it', () => {
    const gaps = checkSecretCompares({
      files: [{ path: 'packages/x/src/a.ts', source: 'const a = 1;' }],
      pins: { [X_SITE]: pin(2) },
    });
    expect(gaps.map((gap) => gap.kind)).toEqual(['stale']);
    const finding = secretCompareFindingFor(gaps[0] as never);
    expect(finding.code).toBe('X_SECRET_COMPARE_PIN_STALE');
    expect(finding.fix).toBe('bun run scripts/secret-compare.ts --unpin packages/x/src/a.ts');
  });

  test('an empty corpus is UNSCANNED, never a clean tree', () => {
    const gaps = checkSecretCompares({ files: [], pins: {} });
    expect(secretCompareFindingFor(gaps[0] as never).code).toBe('X_SECRET_COMPARE_UNSCANNED');
  });

  test('every pin carries a sentence saying what the value is — a blank one is a waiver', () => {
    for (const [site, row] of Object.entries(SECRET_COMPARE_PINS)) {
      expect(row.reason.trim().length).toBeGreaterThan(40);
      expect(row.count).toBeGreaterThan(0);
      expect(site).toMatch(/^[\w./-]+\.tsx?: \S/);
    }
  });

  /** `@ultimat3/auth` is the package this rule was written for, and it is at zero. */
  test('auth holds no pin, because every comparison there goes through timingSafeEqual', () => {
    expect(
      Object.keys(SECRET_COMPARE_PINS).filter((site) => site.startsWith('packages/auth/')),
    ).toEqual([]);
  });

  test('--unpin lowers a site row to what is measured, deletes it at zero, refuses to raise', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ultimate-secret-pins-')).then(made);
    const path = join(dir, SECRET_PINS_FILE);
    await Bun.write(path, await Bun.file(join(repoRoot(), SECRET_PINS_FILE)).text());
    const triple = 'packages/manifest/src/docs-search.ts: !matched.includes(token)';
    const single = 'packages/time/src/cron-parse.ts: list.indexOf(token)';
    const fixture: Readonly<Record<string, SecretComparePin>> = {
      [triple]: pin(3),
      [single]: pin(1),
    };

    expect(await applyUnpin(dir, SECRET_PINS_FILE, [triple], { [triple]: 9 }, fixture)).toEqual([]);
    expect(await applyUnpin(dir, SECRET_PINS_FILE, [triple], { [triple]: 2 }, fixture)).toEqual([
      `${triple} -> 2`,
    ]);
    expect(await Bun.file(path).text()).toContain('count: 2,');

    // Zero deletes the whole entry — its `// why:`, count and reason — since a row claiming a
    // debt of zero reads as a rule still in force over nothing.
    expect(await applyUnpin(dir, SECRET_PINS_FILE, [single], {}, fixture)).toEqual([
      `${single} -> 0`,
    ]);
    const after = await Bun.file(path).text();
    expect(after).not.toContain(single);
    expect(after).toContain(triple);
    expect(after).not.toContain('cron field `token`');
  });
});

describe('against this repo', () => {
  test('the tree is on the ratchet — every site is pinned with a sentence', async () => {
    expect(await secretCompareGaps(repoRoot())).toEqual([]);
  });
});

// Finding 4, 2026-09-06: the operator set was `===` / `!==` / `.includes(` and nothing else, so
// five other short-circuiting comparisons of a secret-named value read green — including the two
// prefix tests, which leak MORE than `===` does: `startsWith` returns true on a partial match, so
// it hands back a length-independent oracle as well as a timing one.
describe('the other short-circuiting comparisons', () => {
  const kinds = (source: string): readonly string[] =>
    scanSecretCompares('packages/x/src/a.ts', source).map((site) => site.kind);

  test('startsWith is a prefix comparison, and the ARGUMENT is what is at stake', () => {
    expect(kinds('const ok = header.startsWith(sessionToken);')).toEqual(['prefix']);
  });

  test('endsWith the same', () => {
    expect(kinds('const ok = header.endsWith(csrfToken);')).toEqual(['prefix']);
  });

  test('but a prefix test against a LITERAL is inert, exactly as `token === null` is', () => {
    expect(kinds("const ok = authToken.startsWith('Bearer ');")).toEqual([]);
  });

  test('indexOf !== -1 is .includes() with the inert operand in front', () => {
    expect(kinds('const ok = known.indexOf(apiKeySecret) !== -1;')).toEqual(['includes']);
  });

  test('a switch on a secret compares each case with ===', () => {
    const source = 'switch (mfaSecret) {\n  case expectedSecret:\n    return true;\n}\n';
    expect(kinds(source)).toEqual(['switch']);
  });

  test('and a switch on a secret against a LITERAL case is inert', () => {
    const source = "switch (jobState) {\n  case 'running':\n    return true;\n}\n";
    expect(kinds(source)).toEqual([]);
  });

  test('Bun.deepEquals walks both values byte by byte and stops at the first difference', () => {
    expect(kinds('const ok = Bun.deepEquals(tokenHash, record.tokenHash);')).toEqual([
      'deep-equal',
    ]);
  });

  test('and the bare deepEquals import too — the receiver is not what is matched', () => {
    expect(kinds('const ok = deepEquals(a, b.signature);')).toEqual(['deep-equal']);
  });

  test('a deepEquals over two values neither of which names a secret is not this rule’s', () => {
    expect(kinds('const ok = Bun.deepEquals(left, right);')).toEqual([]);
  });
});

// Finding 5, 2026-09-06: `secretComparePinnedFor` answered `pin.count` without ever reading
// `reason`, so `{ count: 12, reason: '' }` held twelve sites on nothing — the waiver this table's
// own header says a count-plus-sentence exists to refuse.
describe('a pin with a blank reason waives nothing', () => {
  const file = {
    path: 'packages/x/src/a.ts',
    source: 'export const ok = (a: string, b: string) => a.tokenHash === b.tokenHash;\n',
  };

  const site = 'packages/x/src/a.ts: a.tokenHash === b.tokenHash';

  test('the count is not honoured, and the finding says the sentence is missing', () => {
    const gaps = checkSecretCompares({
      files: [file],
      pins: { [site]: { count: 1, reason: '  ' } },
    });
    expect(gaps.map((gap) => gap.kind)).toContain('unexplained');
    const finding = secretCompareFindingFor(
      gaps.find((gap) => gap.kind === 'unexplained') as never,
    );
    expect(finding.code).toBe('X_SECRET_COMPARE_PIN_UNEXPLAINED');
    expect(finding.fix).toContain('x');
  });

  test('and a reason that says something holds the count, as it always did', () => {
    const gaps = checkSecretCompares({
      files: [file],
      pins: {
        [site]: {
          count: 1,
          reason: 'a content hash this process computed, compared to detect a change',
        },
      },
    });
    expect(gaps).toEqual([]);
  });
});
