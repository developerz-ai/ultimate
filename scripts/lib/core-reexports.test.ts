// The core re-export rule, one form at a time: a value `@ultimat3/core` exports, published again
// by another package — `export { x } from`, `import { x }; export { x }`, or `export const y = x`.
// The set of values is core's real module namespace, so a new core export is covered the day it ships.

import { describe, expect, test } from 'bun:test';
import {
  CORE_ENTRIES,
  CORE_REEXPORT_EXEMPT,
  CORE_VALUES,
  coreReexports,
  coreReexportViolations,
} from './core-reexports';

const names = (text: string): readonly string[] =>
  coreReexports(text).map((hit) => `${hit.name}${hit.alias === hit.name ? '' : `>${hit.alias}`}`);

describe('core values are read from core itself, never a hand list', () => {
  test('every entry core publishes is scanned, and only those', async () => {
    const manifest: unknown = await Bun.file('packages/core/package.json').json();
    const exportsMap = (manifest as { readonly exports: Readonly<Record<string, string>> }).exports;
    expect(Object.keys(exportsMap).sort()).toEqual(CORE_ENTRIES.map((entry) => entry.subpath));
  });

  test('values are in, types are not', () => {
    expect(CORE_VALUES.get('IDEMPOTENCY_HEADER')).toBe('@ultimat3/core');
    expect(CORE_VALUES.get('escapeHtml')).toBe('@ultimat3/core');
    expect(CORE_VALUES.has('UltimateError')).toBe(true);
    expect(CORE_VALUES.has('Page')).toBe(false);
    expect(CORE_VALUES.size).toBeGreaterThan(400);
  });
});

describe('every spelling of a re-export of a core value', () => {
  test('export { x } from, aliased or not, from either core entry', () => {
    expect(
      names(
        'export { escapeHtml, readCookie as cookie } from \'@ultimat3/core\';\nexport { pageClient } from "@ultimat3/core/page";',
      ),
    ).toEqual(['escapeHtml', 'readCookie>cookie', 'pageClient']);
  });

  test('import then export — a local export list naming an imported core value', () => {
    const source = [
      "import { IDEMPOTENCY_HEADER, fnv1a as hash, type Page } from '@ultimat3/core';",
      'const local = 1;',
      'export { IDEMPOTENCY_HEADER, hash as fnv, local };',
    ].join('\n');
    expect(names(source)).toEqual(['IDEMPOTENCY_HEADER', 'fnv1a>fnv']);
  });

  test('export const y = x — an alias binding is the same value under a second name', () => {
    const source =
      "import { formatBytes } from '@ultimat3/core';\nexport const humanBytes = formatBytes;\nexport const n = formatBytes(3);";
    expect(names(source)).toEqual(['formatBytes>humanBytes']);
  });

  test('a namespace import re-exported or aliased member-wise', () => {
    const source =
      "import * as core from '@ultimat3/core';\nexport const h = core.IDEMPOTENCY_HEADER;\nexport { core };";
    expect(names(source)).toEqual(['IDEMPOTENCY_HEADER>h', '*>core']);
  });

  test('a multi-line list and a trailing comma', () => {
    expect(names("export {\n  fnv1a,\n  escapeHtml,\n} from '@ultimat3/core';")).toEqual([
      'fnv1a',
      'escapeHtml',
    ]);
  });
});

describe('what is not a re-export of a core value', () => {
  test('types, imports used locally, other packages, prose and string templates', () => {
    const source = [
      "export type { Page, ClientFlight } from '@ultimat3/core';",
      "export { type Page as P } from '@ultimat3/core';",
      // A class is a value AND a type; `type` re-exports only the type, which is not a second path.
      "export { type UltimateError } from '@ultimat3/core';",
      "import { type UltimateError as E } from '@ultimat3/core';",
      'export type { E };',
      "import type { Clock } from '@ultimat3/core';",
      'export type { Clock };',
      "import { escapeHtml } from '@ultimat3/core';",
      'export const safe = (v: string) => escapeHtml(v);',
      "export { t } from '@ultimat3/schema';",
      "export { toBucket } from '@ultimat3/http';",
      "export { escapeHtml as e } from './html';",
      "// export { fnv1a } from '@ultimat3/core';",
      'const template = "export { fnv1a } from \'@ultimat3/core\';";',
      "export { notACoreValue } from '@ultimat3/core';",
    ].join('\n');
    expect(names(source)).toEqual([]);
  });

  test('a local binding SHADOWING nothing: an import from elsewhere with a core name', () => {
    expect(names("import { uuid } from './ids';\nexport { uuid };")).toEqual([]);
  });
});

describe('the violation', () => {
  test('names the file, the line, the core value and both halves of the fix', () => {
    const [one] = coreReexportViolations({
      at: 'packages/x/src/index.ts',
      text: "\nexport { fnv1a as hash } from '@ultimat3/core';",
    });
    expect(one?.code).toBe('X_HELPER_COPY');
    expect(one?.cause).toContain('packages/x/src/index.ts:2');
    expect(one?.cause).toContain('a second fnv1a');
    expect(one?.fix).toContain("import { fnv1a } from '@ultimat3/core'");
    expect(one?.fix).toContain('delete the re-export in packages/x/src/index.ts');
  });

  test('core itself is the one home and is never reported', () => {
    const text = "export { fnv1a } from '@ultimat3/core';";
    expect(coreReexportViolations({ at: 'packages/core/src/index.ts', text })).toEqual([]);
  });

  test('every exemption names a real core value and says why', () => {
    for (const [key, why] of CORE_REEXPORT_EXEMPT) {
      const [, name] = key.split('#');
      expect(CORE_VALUES.has(name ?? '')).toBe(true);
      expect(why.length).toBeGreaterThan(40);
    }
  });
});
