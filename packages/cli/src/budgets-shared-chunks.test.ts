// A route's JS is the set of FILES its islands make the browser load, each counted once. Split
// from `budgets.test.ts` at the 500-line ceiling: one subject, the import graph between island
// files that `splitting` introduced — an entry that imports a shared chunk is charged for that
// chunk, and two entries importing it are charged for it once.

import { describe, expect, test } from 'bun:test';
// why: Bun exposes no tmpdir(), so only node:os answers the platform temp root.
import { tmpdir } from 'node:os';
// why: Bun exposes no path-join primitive; Bun.file and import() take one already joined.
import { join } from 'node:path';
import { measureDocumentJs } from './budgets';
import { processRoot } from './process-root-fixture';

const dirFor = (name: string): string =>
  processRoot(
    join(tmpdir(), `x-budget-shared-${Bun.hash(`${import.meta.path}:${name}`).toString(16)}`),
  );

const SHARED = `var p="${'u'.repeat(20_000)}";export{p as a};`;
const entry = (label: string): string =>
  `import{a as o}from"./chunk-aaaaaaaa.js";export const mount=(e)=>{e.textContent="${label}"+o};`;

const island = (url: string): string => `<div data-x-entry="${url}"></div>`;

describe('unit · measureDocumentJs follows an island into the chunks it imports', () => {
  test('two islands sharing a module: the shared chunk is counted once', async () => {
    const dir = dirFor('two');
    await Bun.write(join(dir, 'islands/chunk-aaaaaaaa.js'), SHARED);
    await Bun.write(join(dir, 'islands/kyc-11111111.js'), entry('kyc'));
    await Bun.write(join(dir, 'islands/einvoice-22222222.js'), entry('einvoice'));

    const measured = await measureDocumentJs(
      island('/islands/kyc-11111111.js') + island('/islands/einvoice-22222222.js'),
      dir,
    );

    expect(measured.jsBytes).toBe(SHARED.length + entry('kyc').length + entry('einvoice').length);
    expect(measured.entries.map((one) => one.url).sort()).toEqual([
      '/islands/chunk-aaaaaaaa.js',
      '/islands/einvoice-22222222.js',
      '/islands/kyc-11111111.js',
    ]);
  });

  test('one island importing a chunk is charged for both files', async () => {
    const dir = dirFor('one');
    await Bun.write(join(dir, 'islands/chunk-aaaaaaaa.js'), SHARED);
    await Bun.write(join(dir, 'islands/kyc-11111111.js'), entry('kyc'));

    const measured = await measureDocumentJs(island('/islands/kyc-11111111.js'), dir);
    expect(measured.jsBytes).toBe(SHARED.length + entry('kyc').length);
  });

  test('an island that imports nothing is charged exactly its own bytes, as before', async () => {
    const dir = dirFor('alone');
    const code = 'export const mount=(e)=>{e.textContent="solo"};';
    await Bun.write(join(dir, 'islands/solo-33333333.js'), code);

    const measured = await measureDocumentJs(island('/islands/solo-33333333.js'), dir);
    expect(measured.jsBytes).toBe(code.length);
    expect(measured.entries).toEqual([{ url: '/islands/solo-33333333.js', bytes: code.length }]);
  });

  test('a chunk reached by import() is charged too — it was inlined before splitting', async () => {
    const dir = dirFor('lazy');
    const lazy = 'export const z=1;';
    const code = 'export const mount=()=>import("./chunk-bbbbbbbb.js");';
    await Bun.write(join(dir, 'islands/chunk-bbbbbbbb.js'), lazy);
    await Bun.write(join(dir, 'islands/lazy-44444444.js'), code);

    const measured = await measureDocumentJs(island('/islands/lazy-44444444.js'), dir);
    expect(measured.jsBytes).toBe(code.length + lazy.length);
  });

  test('chunks importing each other in a cycle are each weighed once, and the walk ends', async () => {
    const dir = dirFor('cycle');
    const a = 'import"./chunk-cccccccc.js";export const a=1;';
    const c = 'import"./chunk-aaaaaaaa.js";export const c=1;';
    await Bun.write(join(dir, 'islands/chunk-aaaaaaaa.js'), a);
    await Bun.write(join(dir, 'islands/chunk-cccccccc.js'), c);

    const measured = await measureDocumentJs(island('/islands/chunk-aaaaaaaa.js'), dir);
    expect(measured.jsBytes).toBe(a.length + c.length);
  });
});
