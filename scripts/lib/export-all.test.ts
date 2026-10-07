// `export *` in shipped package source, refused in every spelling — and a template that WRITES one
// into a generated app (a string) left alone, which is why this is a scan and not Biome's
// `noReExportAll`: an override scoped to `packages/*/src/**` is inherited by an app's nested
// `biome.json` (`"extends": "//"`) and re-anchored at the app, refusing the scaffold's own output.

import { describe, expect, test } from 'bun:test';
import { exportAllViolations } from './export-all';

const at = 'packages/x/src/index.ts';
const lines = (text: string): readonly string[] =>
  exportAllViolations({ at, text }).map((one) => one.cause.split(' ')[0] ?? '');

describe('a blind re-export is refused', () => {
  test('export *, export * as ns and export type *, each at its line', () => {
    const source = [
      "export * from './a';",
      "export * as ns from '@ultimat3/core';",
      "export type * from './types';",
      "export type * as T from './types';",
    ].join('\n');
    expect(lines(source)).toEqual([`${at}:1`, `${at}:2`, `${at}:3`, `${at}:4`]);
  });

  test('the finding names what to write instead', () => {
    const [one] = exportAllViolations({ at, text: "export*from'./a';" });
    expect(one?.code).toBe('X_HELPER_COPY');
    expect(one?.fix).toContain("export { … } from './a'");
  });
});

describe('what is not one', () => {
  test('a template string, a comment, a named list and a namespace import', () => {
    const source = [
      "const template = `export * as schema from './schema';\\n`;",
      "// export * from './a';",
      "export { a, b } from './a';",
      "import * as ns from './a';",
      'const product = 2 * 3;',
    ].join('\n');
    expect(lines(source)).toEqual([]);
  });
});
