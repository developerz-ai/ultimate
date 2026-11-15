// The one ordered list: every `codemods/<id>.ts` beside it is in it once, ids are unique, each
// `since` is a plain release, and the list is written in the order the engine runs it.

import { describe, expect, test } from 'bun:test';
// why: Bun exposes no path-join primitive.
import { join } from 'node:path';
import { releaseOf } from '../upgrade-plan';
import { pendingCodemods } from './engine';
import { CODEMODS } from './index';

/** The engine's own files and the contract: everything else here is one codemod. */
const NOT_A_CODEMOD = /^(?:codemod|index|engine(?:-[a-z]+)?)\.ts$/;

describe('unit · codemods, the list', () => {
  test('every module beside the list that exports a codemod is in it, exactly once', async () => {
    const files: string[] = [];
    const listed: number[] = [];
    for await (const file of new Bun.Glob('*.ts').scan({ cwd: import.meta.dir })) {
      if (file.endsWith('.test.ts') || NOT_A_CODEMOD.test(file)) continue;
      const module = (await import(join(import.meta.dir, file))) as { codemod?: unknown };
      // A helper a codemod imports (`runtime-pin-lines.ts`) exports none, and is no codemod.
      if (module.codemod === undefined) continue;
      files.push(file);
      listed.push(CODEMODS.filter((codemod) => module.codemod === codemod).length);
    }
    expect(files.length).toBeGreaterThan(0);
    expect(Object.fromEntries(files.map((file, i) => [file, listed[i]]))).toEqual(
      Object.fromEntries(files.map((file) => [file, 1])),
    );
  });

  test('ids are unique, each since a plain release, and the list is in run order', () => {
    expect(new Set(CODEMODS.map((codemod) => codemod.id)).size).toBe(CODEMODS.length);
    for (const codemod of CODEMODS) expect(releaseOf(codemod.since)).toBeDefined();
    expect(pendingCodemods(CODEMODS, '0.0.0', '999.0.0')).toEqual(CODEMODS);
  });
});
