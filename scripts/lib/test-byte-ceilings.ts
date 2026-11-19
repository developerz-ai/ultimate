// The byte ceilings pinned inside TEST files — a bundle test's `const RPC_BYTES_MAX = 25_303` or its
// `toBeLessThan(16_186)` — read as one `pin-raises` table per file, so a raise without its own
// `why:` is `X_PIN_RAISE_UNSTATED` exactly as a `scripts/lib/*-pins.ts` row's is. They carried
// `measured:` / `why:` comments by convention alone, and nothing failed when one rose in silence.

import type { PinTableVersions } from '../pin-raises';

/** Every test that measures bytes: a bundle's, or a `*-bytes` encoder's. */
export const TEST_BYTE_PIN_GLOB = 'packages/*/src/**/*{bundle,bytes}*.test.ts';

/** Below this a literal bound is a count (`reads ≤ 8`), not a byte ceiling. */
const MIN_BYTES = 256;

const BOUND = /\.toBeLessThan(?:OrEqual)?\(\s*([A-Z][A-Z0-9_]*|\d[\d_]*)\s*\)/g;
const TEST_CALL = /\btest(?:\.\w+)?\(\s*(['"`])((?:(?!\1)[^\\]|\\.)*)\1/g;

export interface TestBytePin {
  /** The constant's name, or the title of the test the literal sits in. */
  readonly key: string;
  readonly value: number;
  /** The `const` line, or the enclosing `test(` line — where its `why:` is read from. */
  readonly line: number;
}

const lineAt = (source: string, index: number): number => source.slice(0, index).split('\n').length;
const numberOf = (text: string): number => Number(text.replaceAll('_', ''));

/** The last `test('<title>'` opened before `index`, or `undefined` at module scope. */
function enclosingTest(source: string, index: number): { title: string; at: number } | undefined {
  let found: { title: string; at: number } | undefined;
  for (const match of source.matchAll(TEST_CALL)) {
    const at = match.index ?? 0;
    if (at > index) break;
    found = { title: match[2] ?? '', at };
  }
  return found;
}

export function testBytePins(source: string): readonly TestBytePin[] {
  const pins: TestBytePin[] = [];
  const seen = new Map<string, number>();
  for (const match of source.matchAll(BOUND)) {
    const bound = match[1] ?? '';
    if (/^[A-Z]/.test(bound)) {
      const declared = new RegExp(`\\bconst ${bound}\\s*=\\s*(\\d[\\d_]*)\\s*;`).exec(source);
      if (declared === null || pins.some((pin) => pin.key === bound)) continue;
      const value = numberOf(declared[1] ?? '');
      if (value >= MIN_BYTES)
        pins.push({ key: bound, value, line: lineAt(source, declared.index) });
      continue;
    }
    const value = numberOf(bound);
    if (value < MIN_BYTES) continue;
    const at = match.index ?? 0;
    const test = enclosingTest(source, at);
    const title = test?.title ?? `line ${lineAt(source, at)}`;
    const nth = (seen.get(title) ?? 0) + 1;
    seen.set(title, nth);
    pins.push({
      key: nth === 1 ? title : `${title} #${nth}`,
      value,
      line: lineAt(source, test?.at ?? at),
    });
  }
  return pins;
}

const ROW = 'bytes.';

const rowsOf = (source: string): ReadonlyMap<string, number> =>
  new Map(testBytePins(source).map((pin) => [`${ROW}${pin.key}`, pin.value]));

/**
 * One test file as a `pin-raises` table. A file absent at the base has NO rows there — never an
 * `undefined` base, which `pin-raises` reads as a new table licensed by any `why:` above its first
 * export: a test file has no export, so its import comments' `why:`s would license every pin.
 */
export function testBytePinTable(
  path: string,
  source: string,
  baseSource: string | undefined,
): PinTableVersions {
  return {
    path,
    source,
    now: rowsOf(source),
    base: baseSource === undefined ? new Map() : rowsOf(baseSource),
    ...(baseSource === undefined ? {} : { baseSource }),
    line: (text, row) => testBytePins(text).find((pin) => `${ROW}${pin.key}` === row)?.line ?? 0,
  };
}
