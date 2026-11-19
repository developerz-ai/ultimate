import { describe, expect, test } from 'bun:test';
import { AGENTS_MD_MAX_BYTES } from '@ultimat3/manifest';
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

  test('a reworded row is left as written and reported, with the row to use', async () => {
    const app = memoryCodemodApp({ 'CLAUDE.md': '| Many agents | ours | review |\n' });
    const result = await codemod.run(app);
    expect(result.changed).toEqual([]);
    expect(result.skipped[0]?.reason).toContain(WORKER_COMMANDS_ROW);
    expect(app.files['CLAUDE.md']).toBe('| Many agents | ours | review |\n');
  });

  test('a row that would take the file over its byte budget is skipped with the count', async () => {
    const tail = `\n${MANY_AGENTS_ROW}\n`;
    const full = `${'x'.repeat(AGENTS_MD_MAX_BYTES - tail.length - 5)}${tail}`;
    const app = memoryCodemodApp({ 'CLAUDE.md': full });
    const result = await codemod.run(app);
    expect(result.changed).toEqual([]);
    expect(result.skipped[0]?.reason).toContain(String(AGENTS_MD_MAX_BYTES));
    expect(app.files['CLAUDE.md']).toBe(full);
  });

  test('says what a new app is scaffolded with', () => {
    const written = docsFiles(names('shop')).find((file) => file.path === 'CLAUDE.md');
    expect(written?.contents).toContain(WORKER_COMMANDS_ROW);
    expect(written?.contents).not.toContain(MANY_AGENTS_ROW);
  });
});
