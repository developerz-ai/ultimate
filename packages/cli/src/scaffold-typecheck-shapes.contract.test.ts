// The scaffold drift gate's `x new --shape <shape>` part: each overlay over the scaffold it starts
// from, compiled by the real `tsc`. A file of its own so its compiles run beside the other parts.

import { describe, expect, test } from 'bun:test';
import {
  compileScaffoldPart,
  SCAFFOLD_PARTS,
  staleOf,
  surplusOf,
} from './scaffold-typecheck-parts-fixture';

const compiled = await compileScaffoldPart('shapes');

describe('contract · generated code compiles', () => {
  test('no scaffold has a diagnostic outside KNOWN_GAPS', () => {
    expect(surplusOf(compiled)).toBe('');
  });

  test('every pinned gap still reproduces, in the variant that pinned it', () => {
    expect(staleOf(compiled)).toBe('');
  });

  test('every scaffold of the part is compiled', () => {
    expect(compiled.map(({ variant }) => variant.name)).toEqual([...SCAFFOLD_PARTS.shapes]);
    for (const { report } of compiled) expect(report.fileCount).toBeGreaterThan(50);
  });

  test('the sandbox is removed once the gate has run', () => {
    for (const { report } of compiled) expect(Bun.file(`${report.dir}/app.config.ts`).size).toBe(0);
  });
});
