import { describe, expect, test } from 'bun:test';
// why: Bun ships no temp-directory primitive; the fixture app is a real tree on disk.
import { mkdtemp, rm } from 'node:fs/promises';
// why: Bun exposes no tmpdir(); only node:os answers the platform temp root.
import { tmpdir } from 'node:os';
// why: Bun ships no path-join primitive.
import { join } from 'node:path';
import { appSourceFiles, hasExecutableCode, readSource, unloadedWeight } from './coverage-source';

describe('whether a file emits anything at runtime', () => {
  test('a pure re-export barrel has no executable code — bun records none, correctly', () => {
    // `packages/money/src/index.ts` is exactly this shape. Flagging it would be noise.
    expect(
      hasExecutableCode(`/** Public surface. */
export { allocate, sum } from './arithmetic';
export type { Money } from './money';
export { type Currency, formatMoney } from './format';
`),
    ).toBe(false);
  });

  test('a module with a statement has executable code, however small', () => {
    expect(hasExecutableCode('export const ZERO = 0;\n')).toBe(true);
    expect(hasExecutableCode("import { a } from './a';\nexport const b = a();\n")).toBe(true);
  });

  test('an ambient module augmentation emits nothing', () => {
    // `packages/testing/src/matcher-surface.ts` is exactly this shape and nothing else. The inner
    // `interface` was stripped by the declaration loop, which left a bare `declare module '…' { }`
    // shell behind — non-empty, so the file read as a real module no test imports. It is the
    // opposite: an augmentation emits no runtime code, so bun writes no lcov record for it.
    expect(
      hasExecutableCode(`declare module 'bun:test' {
  interface Matchers<T> extends UltimateMatchers<T> {}
}
`),
    ).toBe(false);
    expect(
      hasExecutableCode(`declare global {
  interface Window { readonly x: number }
}
`),
    ).toBe(false);
  });

  test('an ambient block does not hide real code beside it', () => {
    // The strip must remove the block, never everything after it.
    expect(
      hasExecutableCode(`declare global {
  interface W { readonly x: 1 }
}
export const y = 2;
`),
    ).toBe(true);
  });

  test('comments alone are not executable code', () => {
    expect(hasExecutableCode('// just a note\n/* and a block */\n')).toBe(false);
  });

  test('a comment that LOOKS like a statement does not count', () => {
    // The strip runs before the check, so a commented-out export cannot resurrect a barrel.
    expect(hasExecutableCode("export { a } from './a';\n// export const x = 1;\n")).toBe(false);
  });

  test('a type alias containing an object literal is still types-only', () => {
    // The case that broke the first scanner: the `{ … }` inside the alias is not the end of the
    // declaration, so matching braces there left `, ] extends [Actor] … >;` behind — which then
    // read as executable code and reported `type-pins.ts` as an unimported module.
    expect(
      hasExecutableCode(
        'type _A = Assert<[FactKeysOf<{ a: 1 }>] extends [Actor] ? true : false>;\n',
      ),
    ).toBe(false);
  });

  test('a types-only module and a barrel are both invisible for the RIGHT reason', () => {
    expect(hasExecutableCode('export interface Counter {\n  add(n: number): void;\n}\n')).toBe(
      false,
    );
    expect(hasExecutableCode("export const COLUMN_KINDS = ['text'] as const;\n")).toBe(true);
  });
});

describe('a declaration that never closes', () => {
  test('an unbalanced interface or an unterminated alias is still not code', () => {
    // Mid-edit source reaches the scanner too: it must answer, not run off the end.
    expect(hasExecutableCode('export interface Open {\n  readonly a: number;\n')).toBe(false);
    expect(hasExecutableCode('type Alias = { a: 1 }')).toBe(false);
    expect(hasExecutableCode("declare module 'x' {\n  interface A {}\n")).toBe(false);
  });
});

describe('what a file no test loaded weighs', () => {
  test('its code lines — never its comments or blank lines — and a function per keyword or arrow', () => {
    const source = [
      '// a note',
      '/** docs',
      ' * more docs */',
      'export function a(): number {',
      '',
      '  return [1].map((n) => n + 1)[0] ?? 0;',
      '}',
      "export const b = '=> function';",
    ].join('\n');
    expect(unloadedWeight(source)).toEqual({ lines: 4, funcs: 2 });
  });

  test('never zero: it is only asked about a file that has executable code', () => {
    expect(unloadedWeight('')).toEqual({ lines: 1, funcs: 1 });
  });
});

describe("an app's own source", () => {
  test('apps/ and packages/, minus tests, declarations, output, installs and the excluded', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ultimate-coverage-source-'));
    try {
      for (const file of [
        'apps/web/app/posts/service.ts',
        'apps/web/app/posts/service.test.ts',
        'apps/web/app/posts/live.contract.test.ts',
        'apps/web/app/feed/feed.island.tsx',
        'apps/web/types/scss.d.ts',
        'apps/web/dist/server.ts',
        'apps/web/.x/islands/a.ts',
        'packages/db/src/client.ts',
        'packages/db/node_modules/pg/index.ts',
        'packages/db/build/out.ts',
        'scripts/seed.ts',
        'app.config.ts',
      ]) {
        await Bun.write(join(root, file), 'export const a = 1;\n');
      }
      expect(appSourceFiles(root)).toEqual([
        'apps/web/app/feed/feed.island.tsx',
        'apps/web/app/posts/service.ts',
        'packages/db/src/client.ts',
      ]);
      expect(appSourceFiles(root, ['apps/web/**/*.island.tsx', 'packages/db/**'])).toEqual([
        'apps/web/app/posts/service.ts',
      ]);
      expect(await readSource(root, 'packages/db/src/client.ts')).toBe('export const a = 1;\n');
      expect(await readSource(root, 'packages/db/src/gone.ts')).toBeUndefined();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
