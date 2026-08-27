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

  test('it reads a real, non-empty file set — a scan over nothing passes everything', () => {
    expect(shippedSources().length).toBeGreaterThan(100);
  });

  // ZERO, and the number may only stay zero. `stringField(error, '<key>')` from `@ultimat3/core`
  // is the one form; `metrics-endpoint.ts`'s `isAddressInUse` is the worked example.
  test('no shipped CLI source does it', async () => {
    expect(await castReadsOfCaughtValues()).toEqual([]);
  });
});
