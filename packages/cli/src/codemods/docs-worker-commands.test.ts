import { describe, expect, test } from 'bun:test';
import { names } from '../templates/naming';
import { docsFiles } from '../templates/scaffold-docs';
import { memoryCodemodApp } from './codemod';
import { MANY_AGENTS_ROW } from './docs-many-agents';
import { codemod, WORKER_COMMANDS_ROW } from './docs-worker-commands';

describe('docs-worker-commands', () => {
  test('moves the row x new wrote, once', async () => {
    const app = memoryCodemodApp({ 'CLAUDE.md': `| A | b | c |\n${MANY_AGENTS_ROW}\n` });
    expect((await codemod.run(app)).changed).toEqual(['CLAUDE.md']);
    expect(app.files['CLAUDE.md']).toBe(`| A | b | c |\n${WORKER_COMMANDS_ROW}\n`);
    expect((await codemod.run(app)).changed).toEqual([]);
  });

  test('leaves a reworded row alone', async () => {
    const app = memoryCodemodApp({ 'CLAUDE.md': '| Many agents | ours | review |\n' });
    expect(await codemod.run(app)).toEqual({ changed: [], skipped: [] });
  });

  test('lands on what a new app is scaffolded with', () => {
    const written = docsFiles(names('shop')).find((file) => file.path === 'CLAUDE.md');
    expect(written?.contents).toContain(WORKER_COMMANDS_ROW);
    expect(written?.contents).not.toContain(MANY_AGENTS_ROW);
  });
});
