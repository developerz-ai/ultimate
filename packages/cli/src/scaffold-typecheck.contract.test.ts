// The scaffold drift gate: every documented `x new`, plus every `x g` generator, written to a
// sandbox and compiled by the real `tsc` against the real workspace packages. A template is a
// string, and a string that parses has said nothing about whether it compiles — this is where
// that gets decided. This file compiles `x new`; the other parts (`SCAFFOLD_PARTS`) are siblings.

import { describe, expect, test } from 'bun:test';
// why: Bun ships no path-join primitive.
import { join } from 'node:path';
import { NEW_SHAPES } from './new-shapes';
import { scaffoldVariants } from './scaffold-fixture';
import {
  compileScaffoldPart,
  SCAFFOLD_PARTS,
  staleOf,
  surplusOf,
} from './scaffold-typecheck-parts-fixture';

const compiled = await compileScaffoldPart('example');

/** Each part's compile call, as the sibling files spell it. */
const partCalls = async (): Promise<readonly string[]> => {
  const calls: string[] = [];
  const glob = new Bun.Glob('scaffold-typecheck*.contract.test.ts');
  for await (const name of glob.scan({ cwd: import.meta.dir })) {
    const source = await Bun.file(join(import.meta.dir, name)).text();
    for (const match of source.matchAll(/compileScaffoldPart\('(\w+)'\)/g))
      calls.push(match[1] ?? '');
  }
  return calls.sort();
};

describe('contract · generated code compiles', () => {
  test('no scaffold has a diagnostic outside KNOWN_GAPS', () => {
    expect(surplusOf(compiled)).toBe('');
  });

  test('every pinned gap still reproduces, in the variant that pinned it', () => {
    expect(staleOf(compiled)).toBe('');
  });

  test('every documented scaffold is compiled, not just the one with an app in it', async () => {
    // `--no-example` shipped a `packages/db/src/schema.ts` importing the slice it does not write.
    // Compiling only the example app is exactly why nothing caught it.
    const documented = [
      'x new',
      'x new --no-example',
      ...NEW_SHAPES.map((shape) => `x new --shape ${shape}`),
    ];
    expect(scaffoldVariants().map((variant) => variant.name)).toEqual(documented);
    expect(Object.values(SCAFFOLD_PARTS).flat()).toEqual(documented);
    // Each part is compiled by exactly one file: a part with no file is a part never compiled.
    expect(await partCalls()).toEqual(Object.keys(SCAFFOLD_PARTS).sort());
    expect(compiled.map(({ variant }) => variant.name)).toEqual([...SCAFFOLD_PARTS.example]);
    for (const { report } of compiled) expect(report.fileCount).toBeGreaterThan(50);
  });

  test('the sandbox is removed once the gate has run', () => {
    for (const { report } of compiled) expect(Bun.file(`${report.dir}/app.config.ts`).size).toBe(0);
  });
});
