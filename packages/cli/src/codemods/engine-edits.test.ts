// The edit every template codemod makes: exact snippets of the old template swapped for the new
// ones. All there: applied, the app's other edits kept. All done: nothing. Anything else is the
// app's own file, reported with the template's change as a diff and never overwritten.

import { describe, expect, test } from 'bun:test';
import { memoryCodemodApp } from './codemod';
import { editSnippets, writeIfAbsent } from './engine-edits';

const EDITS = [
  { from: 'return token;', to: 'return token ?? null;' },
  { from: "import { a } from 'x';", to: "import { a, b } from 'x';" },
] as const;

const OLD = "import { a } from 'x';\n// the app's own line\nreturn token;\n";
const NEW = "import { a, b } from 'x';\n// the app's own line\nreturn token ?? null;\n";

describe('unit · codemod edits, snippets', () => {
  test('every old snippet there: each is swapped and the rest of the file is kept', async () => {
    const app = memoryCodemodApp({ 'a.ts': OLD });
    expect(await editSnippets(app, 'a.ts', EDITS)).toEqual({ changed: ['a.ts'], skipped: [] });
    expect(app.files['a.ts']).toBe(NEW);
  });

  test('already carried across is nothing to do, and no file is nothing to do', async () => {
    const app = memoryCodemodApp({ 'a.ts': NEW });
    expect(await editSnippets(app, 'a.ts', EDITS)).toEqual({ changed: [], skipped: [] });
    expect(await editSnippets(app, 'gone.ts', EDITS)).toEqual({ changed: [], skipped: [] });
    expect(app.files).toEqual({ 'a.ts': NEW });
  });

  test('half carried across finishes the other half', async () => {
    const app = memoryCodemodApp({ 'a.ts': OLD.replace('return token;', 'return token ?? null;') });
    expect((await editSnippets(app, 'a.ts', EDITS)).changed).toEqual(['a.ts']);
    expect(app.files['a.ts']).toBe(NEW);
  });

  test('a snippet the app rewrote leaves the file untouched and reports the change as a diff', async () => {
    const edited = OLD.replace('return token;', 'return token || undefined;');
    const app = memoryCodemodApp({ 'a.ts': edited });
    const result = await editSnippets(app, 'a.ts', EDITS);
    expect(app.files['a.ts']).toBe(edited);
    expect(result.changed).toEqual([]);
    expect(result.skipped).toHaveLength(1);
    expect(result.skipped[0]?.path).toBe('a.ts');
    expect(result.skipped[0]?.reason).toContain('return token;');
    expect(result.skipped[0]?.diff).toContain('-return token;');
    expect(result.skipped[0]?.diff).toContain('+return token ?? null;');
  });
});

describe('unit · codemod edits, optional prose', () => {
  const WITH_COMMENT = [...EDITS, { from: '// old words', to: '// new words', optional: true }];

  test('a comment the app reworded is no reason to skip the code', async () => {
    const app = memoryCodemodApp({ 'a.ts': OLD });
    expect((await editSnippets(app, 'a.ts', WITH_COMMENT)).changed).toEqual(['a.ts']);
    expect(app.files['a.ts']).toBe(NEW);
  });

  test('a comment still as the template wrote it is carried across too', async () => {
    const app = memoryCodemodApp({ 'a.ts': `// old words\n${OLD}` });
    await editSnippets(app, 'a.ts', WITH_COMMENT);
    expect(app.files['a.ts']).toBe(`// new words\n${NEW}`);
  });

  test('only the reworded comment left over is nothing to do', async () => {
    const app = memoryCodemodApp({ 'a.ts': NEW });
    expect(await editSnippets(app, 'a.ts', WITH_COMMENT)).toEqual({ changed: [], skipped: [] });
  });
});

describe('unit · codemod edits, a file the template added', () => {
  test('absent: written; present, whatever it holds: the app’s, left alone', async () => {
    const app = memoryCodemodApp({ 'kept.ts': 'mine\n' });
    expect(await writeIfAbsent(app, 'new.ts', 'x\n')).toEqual({ changed: ['new.ts'], skipped: [] });
    expect(await writeIfAbsent(app, 'kept.ts', 'x\n')).toEqual({ changed: [], skipped: [] });
    expect(app.files).toEqual({ 'kept.ts': 'mine\n', 'new.ts': 'x\n' });
  });
});
