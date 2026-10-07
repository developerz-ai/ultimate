// What `factory-names-exports.ts` reads off an entry module: type exports, the local binding behind
// an alias, and the `export *` the guard must refuse to read as clean. Every rule in
// `factory-names.ts` that looks a name up in the package's declarations is only as good as this.

import { describe, expect, test } from 'bun:test';
import { exportsIn, ownLocal, stripComments } from './factory-names-exports';

const names = (text: string) =>
  exportsIn(text).names.map((one) => [one.name, one.local, one.type, one.from ?? null]);

describe('export clauses', () => {
  test('a re-export, an alias, a type-only clause and a type-marked specifier', () => {
    expect(
      names(
        [
          "export { a, b as c } from './x';",
          'export type { D, E as F } from "./y";',
          'export {',
          '  type G,',
          '  type H as I,',
          '  j,',
          "} from '@ultimat3/core';",
          'export { k };',
        ].join('\n'),
      ),
    ).toEqual([
      ['a', 'a', false, './x'],
      ['c', 'b', false, './x'],
      ['D', 'D', true, './y'],
      ['F', 'E', true, './y'],
      ['G', 'G', true, '@ultimat3/core'],
      ['I', 'H', true, '@ultimat3/core'],
      ['j', 'j', false, '@ultimat3/core'],
      ['k', 'k', false, null],
    ]);
  });

  test('a column-0 declaration is an export, an interface and a type alias are types', () => {
    expect(
      names(
        [
          'export interface McpServerInput {}',
          'export type Mode = "a";',
          'export class PostgresAuthAdapter {}',
          'export abstract class Base {}',
          'export async function memoryJobDriver() {}',
          'export const enum Flag { A }',
          'export const LIMIT = 1;',
        ].join('\n'),
      ),
    ).toEqual([
      ['McpServerInput', 'McpServerInput', true, null],
      ['Mode', 'Mode', true, null],
      ['PostgresAuthAdapter', 'PostgresAuthAdapter', false, null],
      ['Base', 'Base', false, null],
      ['memoryJobDriver', 'memoryJobDriver', false, null],
      ['Flag', 'Flag', false, null],
      ['LIMIT', 'LIMIT', false, null],
    ]);
  });

  test('a commented-out export is not an export; a `//` inside a specifier is not a comment', () => {
    expect(
      names("// export { gone } from './x';\n/* export { gone2 } */\nexport { kept } from '//x';"),
    ).toEqual([['kept', 'kept', false, '//x']]);
    expect(stripComments("const u = 'https://a'; // tail")).toBe("const u = 'https://a';  ");
  });
});

describe('star exports', () => {
  test('a bare `export *` is listed, an `export * as ns` names a value and is not', () => {
    const read = exportsIn("export * from './all';\nexport * as ns from './ns';");
    expect(read.stars).toEqual(['./all']);
  });
});

describe('which binding the package declares', () => {
  test('a relative re-export names its local, another package’s binding is none of ours', () => {
    const read = exportsIn(
      [
        "import { t as schemaT } from '@ultimat3/schema';",
        "import { helper } from './helper';",
        "export { Impl as Name } from './impl';",
        "export { ANY_HOST } from '@ultimat3/core';",
        'export { schemaT, helper, own };',
      ].join('\n'),
    );
    const local = (name: string) => {
      const one = read.names.find((candidate) => candidate.name === name);
      return one === undefined ? 'missing' : ownLocal(one, read.imported);
    };
    expect(local('Name')).toBe('Impl');
    expect(local('ANY_HOST')).toBeUndefined();
    expect(local('schemaT')).toBeUndefined();
    expect(local('helper')).toBe('helper');
    expect(local('own')).toBe('own');
  });
});
