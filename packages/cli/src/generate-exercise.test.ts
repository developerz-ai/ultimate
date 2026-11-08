// `x g`'s follow-up for the one exercise declaration: a written contract test's entry lands in
// apps/web/exercise.ts — created from `x new`'s when absent, once, and a file it cannot edit is
// X_EXERCISE_FILE_UNEDITABLE with the entry in its fix, the file left as the author wrote it.

import { describe, expect, test } from 'bun:test';
import type { GenerateDisk } from './generate-disk';
import {
  declareGeneratedExercises,
  withDeclaredExercises,
  writtenExercises,
} from './generate-exercise';
import { generate } from './generate-files';
import { exerciseFiles } from './templates/scaffold-exercise';

const memoryDisk = (
  seed: Record<string, string> = {},
): GenerateDisk & { files: Map<string, string> } => {
  const files = new Map(Object.entries(seed));
  return {
    files,
    read: async (path) => files.get(path),
    async write(path, contents) {
      files.set(path, contents);
    },
  };
};

const FILE = 'apps/web/exercise.ts';
const planned = generate({ kind: 'action', name: 'send-invoice', feature: 'invoice' });
const entries = writtenExercises(
  planned,
  planned.map((file) => file.path),
);

describe('unit · x g declares the contract test’s exercise in apps/web/exercise.ts', () => {
  test('the action’s contract test carries one entry, and only a written file is owed it', () => {
    expect(entries.map((entry) => entry.name)).toEqual(['sendInvoice']);
    expect(writtenExercises(planned, [])).toEqual([]);
  });

  test('an app with no file gets x new’s, holding the entry and its import', async () => {
    const disk = memoryDisk();
    expect(await declareGeneratedExercises(entries, disk)).toEqual({
      edited: [FILE],
      findings: [],
    });
    const source = disk.files.get(FILE) ?? '';
    expect(source).toContain("import { userActor } from '@ultimat3/core';");
    expect(source).toContain('  sendInvoice: {');
  });

  test('a second run edits nothing', async () => {
    const disk = memoryDisk({ [FILE]: String(exerciseFiles()[0]?.contents) });
    await declareGeneratedExercises(entries, disk);
    const once = disk.files.get(FILE);
    expect(await declareGeneratedExercises(entries, disk)).toEqual({ edited: [], findings: [] });
    expect(disk.files.get(FILE)).toBe(once);
  });

  test('a file it cannot edit is refused, coded, with the entry to paste, and left as it is', async () => {
    const own = 'export const exercise = makeMine();\n';
    const disk = memoryDisk({ [FILE]: own });
    const { edited, findings } = await declareGeneratedExercises(entries, disk);
    expect(edited).toEqual([]);
    expect(findings.map((finding) => finding.code)).toEqual(['X_EXERCISE_FILE_UNEDITABLE']);
    expect(findings[0]?.cause).toContain('holds no defineExercise() call');
    expect(findings[0]?.fix).toContain(`edit ${FILE}`);
    expect(findings[0]?.fix).toContain("sendInvoice: { actor: userActor({ id: 'member',");
    expect(findings[0]?.fix).not.toContain('\n');
    expect(disk.files.get(FILE)).toBe(own);
  });

  test('x new’s file set carries every entry in its own exercise file', () => {
    const files = withDeclaredExercises([...exerciseFiles(), ...planned]);
    const file = files.find((one) => one.path === FILE);
    expect(typeof file?.contents === 'string' ? file.contents : '').toContain('  sendInvoice: {');
  });
});
