// The Env row reaches an app's CLAUDE.md exactly as `x new` writes it today, once.

import { describe, expect, test } from 'bun:test';
import { memoryCodemodApp } from './codemod';
import { codemod, DOCS_ENV_GUARD_EDITS, ENVIRONMENT_ROW } from './docs-env-guard';
import { today, undo } from './scaffold-prose-fixture';

const CLAUDE = 'CLAUDE.md';

describe('unit · codemod · docs-env-guard', () => {
  test('a CLAUDE.md as 31.39 wrote it comes back as x new writes it today, and stays', async () => {
    const written = today[CLAUDE] ?? '';
    expect(written).toContain(ENVIRONMENT_ROW);
    const app = memoryCodemodApp({ [CLAUDE]: undo(written, DOCS_ENV_GUARD_EDITS) });
    expect(app.files[CLAUDE]).not.toContain(ENVIRONMENT_ROW);
    expect((await codemod.run(app)).changed).toEqual([CLAUDE]);
    expect(app.files[CLAUDE]).toBe(written);
    expect((await codemod.run(app)).changed).toEqual([]);
  });

  test('an app that already names the guard, or reworded the table, is left alone', async () => {
    const own = memoryCodemodApp({ [CLAUDE]: '| Config | mine | `undeclared-env` |\n' });
    expect((await codemod.run(own)).changed).toEqual([]);
    const reworded = memoryCodemodApp({ [CLAUDE]: '# mine\n' });
    const result = await codemod.run(reworded);
    expect(result.changed).toEqual([]);
    expect(result.skipped).toEqual([]);
    expect(reworded.files[CLAUDE]).toBe('# mine\n');
  });
});
