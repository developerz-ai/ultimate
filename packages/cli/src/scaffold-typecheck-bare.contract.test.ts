// The scaffold drift gate's `x new --no-example` part: an empty `app/`, compiled by the real `tsc`.
// A file of its own so its compile runs beside the other parts (`SCAFFOLD_PARTS`).

import { describe, expect, test } from 'bun:test';
import {
  compileScaffoldPart,
  SCAFFOLD_PARTS,
  staleOf,
  surplusOf,
} from './scaffold-typecheck-parts-fixture';

const compiled = await compileScaffoldPart('bare');

describe('contract · generated code compiles', () => {
  test('no scaffold has a diagnostic outside KNOWN_GAPS', () => {
    expect(surplusOf(compiled)).toBe('');
  });

  test('every pinned gap still reproduces, in the variant that pinned it', () => {
    expect(staleOf(compiled)).toBe('');
  });

  test('every scaffold of the part is compiled', () => {
    expect(compiled.map(({ variant }) => variant.name)).toEqual([...SCAFFOLD_PARTS.bare]);
    for (const { report } of compiled) expect(report.fileCount).toBeGreaterThan(50);
  });

  test('the sandbox is removed once the gate has run', () => {
    for (const { report } of compiled) expect(Bun.file(`${report.dir}/app.config.ts`).size).toBe(0);
  });
});
