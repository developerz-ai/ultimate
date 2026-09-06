// One rule over this package's own shipped source: a `catch` binding is never cast and then read.
//
// `metrics-endpoint.ts` states it where it obeys it — "never `error instanceof Error` plus a
// property access: both run on a value this process did not build, and either can throw one line
// before the guard that was meant to make the path safe." That was prose, and three sites broke it
// (`dev-lock.ts` twice, `write-line.ts` once), each reading `.code` off a cast. `stringField(value,
// 'code')` is the total form: it narrows, reads inside a `try`, and answers `undefined` for
// anything that is not a string.
//
// A ratchet at ZERO. `scripts/error-render.ts` reads a parameter annotated `unknown` and
// `scripts/catch-render.ts` reads what reaches a `cause:`/`fix:`/`detail:`; neither can see a
// property read whose result is compared to a string and thrown away, which is what all three of
// these were.

import { describe, expect, test } from 'bun:test';
// why: Bun exposes no path-join primitive; Bun.file and import() take one already joined.
import { join } from 'node:path';
import { stripComments } from './ts-scan';

const SRC = import.meta.dir;

/** Shipped source only: a test file's fixture may deliberately build a hostile throwable. */
const shippedSources = (): readonly string[] =>
  [...new Bun.Glob('**/*.ts').scanSync({ cwd: SRC, absolute: false })]
    .filter((path) => !path.endsWith('.test.ts') && !path.endsWith('.d.ts'))
    .sort();

const CAUGHT_BINDING = /\bcatch\s*\((?<name>[A-Za-z_$][\w$]*)\)/g;

/** `(error as X).code` and `(error as X)['code']` alike — the read is what makes it unsafe. */
const castReadOf = (name: string): RegExp => new RegExp(`\\(\\s*${name}\\s+as\\s+[^)]*\\)\\s*[.[]`);

/**
 * The SECOND spelling of the same read, and the one the cast rule cannot see: `'code' in error &&
 * error.code === 'EEXIST'`. `in` narrows for the compiler and promises the runtime nothing — the
 * property is still read off a value this process did not build, so a throwing getter takes the
 * command down one line after the guard written to make it safe. Two sites shipped it
 * (`cmd-i18n.ts` deciding whether a catalog already existed, `error-catalog.ts` deciding whether a
 * package failed to resolve), and both were the exact shape `dev-lock.ts` had been repaired for.
 *
 * A read with no `in` guard at all is not this rule's: TypeScript refuses it on an `unknown`, so
 * it cannot ship.
 *
 * `g`, because the scan is TOTAL — a file with two guarded reads of one binding must report both.
 * Freshly constructed on every call, so no caller inherits another's `lastIndex` and a bare
 * `.test(…)` still answers from position 0.
 */
const guardedReadOf = (name: string): RegExp =>
  new RegExp(`\\bin\\s+${name}\\b[\\s\\S]{0,120}?\\b${name}\\s*[.[]`, 'g');

/**
 * The values this rule is about: a `catch` binding, and a parameter annotated `unknown` — which is
 * the same value one function call along, and how both `in`-guarded reads reached shipped source.
 */
const UNKNOWN_PARAMETER = /(?<name>[A-Za-z_$][\w$]*)\s*:\s*unknown\b/g;

const lineOf = (source: string, index: number): number => source.slice(0, index).split('\n').length;

/** Every `<file>: <line>` in this package that casts a caught value and then reads off it. */
export async function castReadsOfCaughtValues(): Promise<readonly string[]> {
  const hits: string[] = [];
  for (const path of shippedSources()) {
    // Comments blanked first: this file's own doc block spells the pattern out, and a scanner that
    // read prose as code would report findings nobody can fix.
    const source = stripComments(await Bun.file(join(SRC, path)).text());
    const names = new Set(
      [...source.matchAll(CAUGHT_BINDING)].map((match) => match.groups?.['name'] ?? ''),
    );
    for (const name of names) {
      if (name === '') continue;
      const pattern = castReadOf(name);
      source.split('\n').forEach((line, index) => {
        if (pattern.test(line)) hits.push(`${path}:${index + 1}`);
      });
    }
    const foreign = new Set([
      ...names,
      ...[...source.matchAll(UNKNOWN_PARAMETER)].map((match) => match.groups?.['name'] ?? ''),
    ]);
    for (const name of foreign) {
      if (name === '') continue;
      // `matchAll`, never `exec`: one `exec` answers the FIRST guarded read and stops, so a file
      // with two of them contributed one entry — the second appeared as a NEW failure the moment
      // the first was repaired, and the count this check prints was never the true one. The cast
      // rule above already scans every line; these two now answer the same question the same way.
      for (const match of source.matchAll(guardedReadOf(name))) {
        hits.push(`${path}:${lineOf(source, match.index)}`);
      }
    }
  }
  return hits;
}

describe('unit · a caught value is never cast and then read', () => {
  test('the scan can see the shape it exists for', () => {
    // The rule proving it can fail, on the exact text that shipped in `dev-lock.ts`.
    const guilty =
      "try { a(); } catch (error) {\n  if ((error as { code?: string }).code === 'EPERM') return true;\n}";
    const innocent =
      "try { a(); } catch (error) {\n  if (stringField(error, 'code') === 'EPERM') return true;\n}";
    const names = [...guilty.matchAll(CAUGHT_BINDING)].map((m) => m.groups?.['name']);
    expect(names).toEqual(['error']);
    expect(castReadOf('error').test(guilty)).toBe(true);
    expect(castReadOf('error').test(innocent)).toBe(false);
  });

  test('and the shape the cast rule cannot see — an `in` guard, then the read', () => {
    // Verbatim from `cmd-i18n.ts`, which passed the rule above through every gate it ever ran in.
    const guilty =
      "const isAlreadyExists = (error: unknown): boolean =>\n  typeof error === 'object' && error !== null && 'code' in error && error.code === 'EEXIST';";
    const innocent =
      "const isAlreadyExists = (error: unknown): boolean =>\n  stringField(error, 'code') === 'EEXIST';";
    expect(guardedReadOf('error').test(guilty)).toBe(true);
    expect(guardedReadOf('error').test(innocent)).toBe(false);
    // An `in` that only ASKS is a type guard and reads nothing: `app-mcp.ts` does exactly this.
    expect(guardedReadOf('value').test("'server' in value && 'tools' in value")).toBe(false);
  });

  // TOTAL, and it was not: one `exec` answered the first site and stopped, so a file holding two
  // guarded reads of one binding contributed ONE entry — the second surfaced as a new failure only
  // after the first was repaired, and the number this check prints was never the true count.
  test('and it reports every site in a file, not the first', () => {
    const twice = [
      "if ('code' in error && error.code === 'EEXIST') return true;",
      "if ('errno' in error && error.errno === -17) return false;",
    ].join('\n');
    expect([...twice.matchAll(guardedReadOf('error'))]).toHaveLength(2);
  });

  test('it reads a real, non-empty file set — a scan over nothing passes everything', () => {
    expect(shippedSources().length).toBeGreaterThan(100);
  });

  // ZERO, and the number may only stay zero. `stringField(error, '<key>')` from `@ultimat3/core`
  // is the one form; `metrics-endpoint.ts`'s `isAddressInUse` is the worked example.
  test('no shipped CLI source does it', async () => {
    expect(await castReadsOfCaughtValues()).toEqual([]);
  });
});
