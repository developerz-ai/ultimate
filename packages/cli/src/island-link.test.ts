// `linkOutputs` on outputs written by hand: the issue's two byte strings, a chain linked leaves
// first, and the import cycle that has no byte-derived name. `island-chunk-names.test.ts` asks the
// same of real `Bun.build` output.

import { describe, expect, test } from 'bun:test';
import { contentHash } from '@ultimat3/render/server';
import type { BuiltOutput } from './island-link';
import { linkOutputs, sharedChunkName } from './island-link';

/** Issue #1075, in shape: one shared chunk, its two export names swapped between builds. */
const buildOf = (chunk: string): readonly BuiltOutput[] => [
  { path: 'chunk-50bf7646.js', code: chunk },
  {
    path: 'apps/web/app/logs.island.js',
    file: 'apps/web/app/logs.island.tsx',
    code: 'import{g as q}from"./chunk-50bf7646.js";export function mount(){q.runLog()}',
  },
];
const BUILD_A = 'var g=q({baseUrl:""}),y=Fe({baseUrl:""});export{g,y};';
const BUILD_B = 'var y=q({baseUrl:""}),g=Fe({baseUrl:""});export{y,g};';

describe('linkOutputs', () => {
  test('a chunk whose export names moved is a new name, and so is every importer (#1075)', () => {
    const [chunkA, entryA] = linkOutputs(buildOf(BUILD_A));
    const [chunkB, entryB] = linkOutputs(buildOf(BUILD_B));

    expect(chunkA?.identity).not.toBe(chunkB?.identity);
    expect(entryA?.identity).not.toBe(entryB?.identity);
    expect(entryB?.code).toContain(`"./${sharedChunkName(chunkB?.identity ?? '')}"`);
  });

  test('every name is the hash of the final code, linked leaves first', () => {
    const linked = linkOutputs([
      { path: 'a.island.js', file: 'a.island.tsx', code: 'import{x}from"./chunk-mid.js";x();' },
      { path: 'chunk-mid.js', code: 'import{y}from"./chunk-leaf.js";export const x=()=>y;' },
      { path: 'chunk-leaf.js', code: 'export const y=1;' },
    ]);
    const byPath = new Map(linked.map((one) => [one.path, one]));
    const leaf = byPath.get('chunk-leaf.js');
    const mid = byPath.get('chunk-mid.js');

    for (const one of linked) expect(one.identity).toBe(contentHash(one.code));
    expect(mid?.code).toContain(`"./${sharedChunkName(leaf?.identity ?? '')}"`);
    expect(byPath.get('a.island.js')?.imports).toEqual([sharedChunkName(mid?.identity ?? '')]);
  });

  test('two chunks importing each other are refused with X_BUILD_FAILED, never half-named', () => {
    const cyclic: readonly BuiltOutput[] = [
      { path: 'chunk-a.js', code: 'import"./chunk-b.js";export const a=1;' },
      { path: 'chunk-b.js', code: 'import"./chunk-a.js";export const b=1;' },
    ];
    expect(() => linkOutputs(cyclic)).toThrow(/X_BUILD_FAILED.*chunk import cycle/);
  });
});
