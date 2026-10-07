// The two pin lists under the status-table gate, held to what each one means: `OFF_SOCKET` is a
// decision and may grow, `UNDECIDED` is debt and may only shrink. The gate itself, over the real
// tree, is `error-map.test.ts`.

import { describe, expect, test } from 'bun:test';
import {
  backlogCodes,
  backlogGroupOf,
  ERROR_STATUS_BACKLOG,
  OFF_SOCKET,
  UNDECIDED,
} from './error-map-backlog';
import { BASE_REF, baseRef, textAt } from './lib/base-ref';
import { tableDeclaration } from './lib/pin-tables';
import { REPO_SCAN_TIMEOUT_MS, repoRoot } from './lib/run';

/**
 * THE RATCHET. The undecided count as of this edit. A count alone admits a SWAP — decide one code,
 * add another, the number holds — so `every code in it was undecided at origin/main` below closes
 * that per code, against the base's own `UNDECIDED` literal. A smaller count is the goal — lower this number
 * to match in the same diff, so the debt cannot regrow into the room it left. A larger one is the
 * failure this test exists for: decide the new code instead (`--status <n>` or `--off-socket`).
 */
const UNDECIDED_CEILING = 157;

const flat = (pins: Readonly<Record<string, readonly string[]>>): readonly string[] =>
  Object.values(pins).flat();

describe('UNDECIDED only shrinks', () => {
  test('never grows past the ceiling', () => {
    const count = flat(UNDECIDED).length;
    if (count > UNDECIDED_CEILING) {
      expect.unreachable(
        `UNDECIDED grew to ${count} from ${UNDECIDED_CEILING}: decide the new code — a row in its packages/http/src/error-map-tier-<n>.ts slice, or bun run new-error-code … --off-socket — never a pin in UNDECIDED`,
      );
    }
  });

  test('and the ceiling follows it down', () => {
    const count = flat(UNDECIDED).length;
    if (count < UNDECIDED_CEILING) {
      expect.unreachable(
        `UNDECIDED shrank to ${count}: set UNDECIDED_CEILING = ${count} in scripts/error-map-backlog.test.ts, so the room it left cannot be refilled`,
      );
    }
  });
});

/** The codes a source text's `UNDECIDED` literal lists, comments dropped. */
const undecidedIn = (source: string): ReadonlySet<string> =>
  new Set(
    [
      ...(tableDeclaration(source, 'UNDECIDED') ?? '')
        .replace(/\/\/[^\n]*/g, '')
        .matchAll(/'(X_[A-Z0-9_]+)'/g),
    ].map((match) => match[1] as string),
  );

/** Codes undecided now that the base did not list: each is a new undecided code, never allowed. */
const newlyUndecided = (now: readonly string[], base: ReadonlySet<string>): readonly string[] =>
  now.filter((code) => !base.has(code));

describe('UNDECIDED only shrinks, code by code', () => {
  test('a decided code swapped for a new one at an equal count is caught', () => {
    const base = undecidedIn(
      "export const UNDECIDED: Pins = {\n  // 'X_IN_A_COMMENT'\n  db: ['X_DB_A', 'X_DB_B'],\n};\n",
    );
    expect([...base]).toEqual(['X_DB_A', 'X_DB_B']);
    expect(newlyUndecided(['X_DB_A', 'X_DB_C'], base)).toEqual(['X_DB_C']);
    expect(newlyUndecided(['X_DB_A'], base)).toEqual([]);
  });

  test(
    'every code in it was undecided at origin/main',
    async () => {
      const root = repoRoot();
      expect(await baseRef(root)).toBe(BASE_REF);
      const then = await textAt(root, BASE_REF, 'scripts/error-map-backlog.ts');
      if (then === undefined)
        expect.unreachable(`scripts/error-map-backlog.ts is not at ${BASE_REF}`);
      const base = undecidedIn(then);
      // Non-vacuity: the base literal was found and read.
      expect(base.size).toBeGreaterThan(0);
      // A new code here is a code nobody decided: give it a status row or `--off-socket` instead.
      expect(newlyUndecided(flat(UNDECIDED), base)).toEqual([]);
    },
    REPO_SCAN_TIMEOUT_MS,
  );
});

describe('two lists, one meaning each', () => {
  test('a code is in one list, once', () => {
    const all = [...flat(OFF_SOCKET), ...flat(UNDECIDED)];
    const seen = new Set<string>();
    const twice = all.filter((code) => seen.has(code) || !seen.add(code));
    expect(twice).toEqual([]);
  });

  test('the gate reads both, per owner', () => {
    expect(backlogCodes()).toEqual(new Set([...flat(OFF_SOCKET), ...flat(UNDECIDED)]));
    expect(flat(ERROR_STATUS_BACKLOG)).toHaveLength(backlogCodes().size);
    for (const [owner, codes] of Object.entries(UNDECIDED)) {
      for (const code of codes) expect(backlogGroupOf(code)).toBe(owner);
    }
    for (const [owner, codes] of Object.entries(OFF_SOCKET)) {
      for (const code of codes) expect(backlogGroupOf(code)).toBe(owner);
    }
  });

  test('OFF_SOCKET is the first literal in the file — the one --off-socket writes', async () => {
    const text = await Bun.file(new URL('./error-map-backlog.ts', import.meta.url)).text();
    const off = text.indexOf('export const OFF_SOCKET');
    expect(off).toBeGreaterThan(-1);
    expect(off).toBeLessThan(text.indexOf('export const UNDECIDED'));
  });
});
