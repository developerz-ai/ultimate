// The re-export parser, one spelling at a time: `export { x } from`, `import { x }; export { x }`,
// `export const y = x [as T]`, `const h = x; export { h }` and a namespace re-exported or aliased
// member-wise — and what reads like one and is not (types, uses, strings, comments).

import { describe, expect, test } from 'bun:test';
import { reexportsIn } from './reexport-scan';

const WANTED = new Set(['escapeHtml', 'readCookie', 'pageClient', 'fnv1a', 'formatBytes', 'X']);
const isValue = (from: string, name: string): boolean =>
  from.startsWith('@ultimat3/') && (name === '*' || WANTED.has(name));

const names = (text: string): readonly string[] =>
  reexportsIn(text, isValue).map(
    (hit) => `${hit.from}:${hit.name}${hit.alias === hit.name ? '' : `>${hit.alias}`}`,
  );

describe('every spelling of a re-export', () => {
  test('export { x } from, aliased or not, root entry or subpath', () => {
    const source =
      'export { escapeHtml, readCookie as cookie } from \'@ultimat3/core\';\nexport { pageClient } from "@ultimat3/core/page";';
    expect(names(source)).toEqual([
      '@ultimat3/core:escapeHtml',
      '@ultimat3/core:readCookie>cookie',
      '@ultimat3/core/page:pageClient',
    ]);
  });

  test('import then export — a local export list naming an imported value', () => {
    const source = [
      "import { X, fnv1a as hash, type Page } from '@ultimat3/core';",
      'const local = 1;',
      'export { X, hash as fnv, local };',
    ].join('\n');
    expect(names(source)).toEqual(['@ultimat3/core:X', '@ultimat3/core:fnv1a>fnv']);
  });

  test('export const y = x, annotated or cast — one value under a second name', () => {
    const source = [
      "import { formatBytes, X } from '@ultimat3/money';",
      'export const humanBytes = formatBytes;',
      'export const n = formatBytes(3);',
      'export const typed: () => string = formatBytes;',
      'export const cast = X as unknown as number;',
      'export const checked = X satisfies number;',
    ].join('\n');
    expect(names(source)).toEqual([
      '@ultimat3/money:formatBytes>humanBytes',
      '@ultimat3/money:formatBytes>typed',
      '@ultimat3/money:X>cast',
      '@ultimat3/money:X>checked',
    ]);
  });

  test('two steps — const h = x; export { h }, and a chain of them', () => {
    const source = [
      "import { fnv1a } from '@ultimat3/core';",
      'const h = fnv1a;',
      'const g = h;',
      'export { h, g as hash };',
    ].join('\n');
    expect(names(source)).toEqual(['@ultimat3/core:fnv1a>h', '@ultimat3/core:fnv1a>hash']);
  });

  test('a namespace import re-exported whole or aliased member-wise', () => {
    const source =
      "import * as core from '@ultimat3/core';\nexport const h = core.X;\nconst f = core.fnv1a;\nexport { core, f };";
    expect(names(source)).toEqual([
      '@ultimat3/core:X>h',
      '@ultimat3/core:*>core',
      '@ultimat3/core:fnv1a>f',
    ]);
  });

  test('a multi-line list and a trailing comma', () => {
    expect(names("export {\n  fnv1a,\n  escapeHtml,\n} from '@ultimat3/schema';")).toEqual([
      '@ultimat3/schema:fnv1a',
      '@ultimat3/schema:escapeHtml',
    ]);
  });
});

describe('what is not a re-export', () => {
  test('types, imports used locally, unwanted modules, prose and string templates', () => {
    const source = [
      "export type { Page, ClientFlight } from '@ultimat3/core';",
      "export { type Page as P } from '@ultimat3/core';",
      // A class is a value AND a type; `type` re-exports only the type, which is not a second path.
      "export { type X } from '@ultimat3/core';",
      "import { type X as E } from '@ultimat3/core';",
      'export type { E };',
      "import { escapeHtml } from '@ultimat3/core';",
      'export const safe = (v: string) => escapeHtml(v);',
      'const local = escapeHtml("a");',
      'export { local };',
      "export { escapeHtml as e } from './html';",
      "// export { fnv1a } from '@ultimat3/core';",
      'const template = "export { fnv1a } from \'@ultimat3/core\';";',
      "export { notWanted } from '@ultimat3/core';",
    ].join('\n');
    expect(names(source)).toEqual([]);
  });

  test('a type-only import list re-exported is a type, whatever the export spells', () => {
    expect(names("import type { fnv1a } from '@ultimat3/core';\nexport { fnv1a };")).toEqual([]);
  });

  test('an import from elsewhere under a wanted name', () => {
    expect(names("import { fnv1a } from './ids';\nexport { fnv1a };")).toEqual([]);
  });
});
