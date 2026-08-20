// A `fix:` in this package may not tell the reader to edit `jobs.driver`.
//
// `JobsConfig.driver` is declared and read by NOTHING — boot always builds `createPgDriver`
// (`driver.ts`'s header states it, `dev-queue.ts` is where it happens). Six shipped `fix:` lines
// named that field as the repair for `X_NOT_IMPLEMENTED`, so six error paths handed an agent an
// instruction that changes nothing and returns it to the same throw. Axiom 4 asks for the exact
// command that repairs the failure; a no-op is the one thing a `fix:` may never be.
//
// The `errors` gate step cannot see this: it checks that a fix names a *command* that exists, and
// `set jobs: { driver: 'postgres' } in app.config.ts` names none. #223 deletes the field, which is
// breaking; this test is what stops the instruction coming back before then, and after.

import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const SRC = import.meta.dir;

/** `jobs: { driver: … }` or `jobs.driver`, in either quote style, anywhere in a fix string. */
const DEAD_FIELD = /jobs\s*[:.]\s*\{?\s*driver|jobs\.driver/;

/** Every `fix:` string literal in a source file, single- or double-quoted or a template. */
const FIX_LINE = /fix:\s*(['"`])((?:\\.|(?!\1).)*)\1/gs;

const sources = (): readonly string[] =>
  readdirSync(SRC).filter((name) => name.endsWith('.ts') && !name.endsWith('.test.ts'));

describe('fix lines', () => {
  test('no fix: instructs the reader to edit jobs.driver, which selects nothing', () => {
    const offenders: string[] = [];
    for (const name of sources()) {
      const text = readFileSync(join(SRC, name), 'utf8');
      for (const [, , body] of text.matchAll(FIX_LINE)) {
        if (body !== undefined && DEAD_FIELD.test(body)) offenders.push(`${name}: ${body}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  // Guards the guard: a regex that matched nothing would pass the test above forever. This is the
  // exact string that shipped in five places, and it must be caught.
  test('the rule catches the string that actually shipped', () => {
    expect(DEAD_FIELD.test("set jobs: { driver: 'postgres' } in app.config.ts")).toBe(true);
    expect(DEAD_FIELD.test('or set jobs.driver in app.config.ts and run `x dev`')).toBe(true);
    expect(DEAD_FIELD.test('call setJobDriver(createPgDriver()) at boot')).toBe(false);
  });

  test('every fix: in this package is non-empty', () => {
    for (const name of sources()) {
      const text = readFileSync(join(SRC, name), 'utf8');
      for (const [, , body] of text.matchAll(FIX_LINE)) {
        expect(body?.trim().length ?? 0).toBeGreaterThan(0);
      }
    }
  });
});
