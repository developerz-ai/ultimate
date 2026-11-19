import { describe, expect, test } from 'bun:test';
import { memoryCodemodApp } from './codemod';
import { codemod, MANY_AGENTS_ROW } from './docs-many-agents';

const TABLE =
  '| Coverage | c | d |\n| One way | generators, not hand-rolled files: `x` | review |\n';

describe('docs-many-agents', () => {
  test('adds the row above the One way row, once', async () => {
    const app = memoryCodemodApp({ 'CLAUDE.md': TABLE });
    expect((await codemod.run(app)).changed).toEqual(['CLAUDE.md']);
    expect(app.files['CLAUDE.md']).toContain(`${MANY_AGENTS_ROW}\n| One way |`);
    expect((await codemod.run(app)).changed).toEqual([]);
  });

  test('leaves an app that reworded the table alone', async () => {
    const app = memoryCodemodApp({ 'CLAUDE.md': '| Rules | mine |\n' });
    expect(await codemod.run(app)).toEqual({ changed: [], skipped: [] });
  });
});
