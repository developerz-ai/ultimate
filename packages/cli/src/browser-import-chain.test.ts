// The browser chain's pure parts: the shortest path an entry takes, what a module takes from a
// barrel, and what a browser entry publishes — each the fact a cut-or-swap decision rests on.

import { describe, expect, test } from 'bun:test';
import { exportedNames, importChain, namesFrom, specLine } from './browser-import-chain';

const host = (files: Record<string, string>) => {
  const map = new Map(Object.entries(files));
  return { read: (path: string) => map.get(path), alias: () => undefined };
};

describe('importChain', () => {
  const tree = host({
    'a.island.tsx': "// './far'\nimport { b } from './b';\nimport { far } from './far';\n",
    'b.ts': "import { c } from './c';\n",
    'c.ts': "import { d } from './d';\n",
    'far.ts': "import { d } from './d';\n",
    'd.ts': 'export const d = 1;\n',
  });

  test('is the shortest path, entry first, with the hop line past a comment naming it', () => {
    expect(importChain(tree, 'a.island.tsx', 'd.ts')).toEqual({
      chain: ['a.island.tsx', 'far.ts', 'd.ts'],
      hop: { spec: './far', line: 3 },
    });
  });

  test('the entry itself is a one-file chain with no hop; an unreached file is none', () => {
    expect(importChain(tree, 'd.ts', 'd.ts')).toEqual({ chain: ['d.ts'] });
    expect(importChain(tree, 'd.ts', 'b.ts')).toBeUndefined();
  });

  test('specLine falls back to line 1 for a specifier it cannot find', () => {
    expect(specLine("\nimport x from './x';\n", './x')).toBe(2);
    expect(specLine('', './x')).toBe(1);
  });
});

describe('namesFrom', () => {
  test('value names, type members dropped, re-exports included', () => {
    const source =
      "import { entity, type Row } from 'p';\nexport { money as cash } from 'p';\nimport { q } from 'other';\n";
    expect(namesFrom(source, 'p')).toEqual(['entity', 'money']);
  });

  test('a namespace, a side effect or a star is the whole module', () => {
    expect(namesFrom("import * as p from 'p';\n", 'p')).toBe('*');
    expect(namesFrom("import 'p';\n", 'p')).toBe('*');
    expect(namesFrom("export * from 'p';\n", 'p')).toBe('*');
  });
});

describe('exportedNames', () => {
  test('declared and listed exports, types included, the alias not the local', () => {
    const source =
      "export type { A } from './a';\nexport { b, c as d } from './b';\nexport const e = 1;\nexport async function f() {}\nexport interface G {}\n";
    expect([...(exportedNames(source) ?? [])].sort()).toEqual(['A', 'G', 'b', 'd', 'e', 'f']);
  });

  test('an export * makes the list unknowable', () => {
    expect(exportedNames("export * from './a';\n")).toBeUndefined();
  });
});
