import { describe, expect, test } from 'bun:test';
import { AGENTS_MD_MAX_BYTES } from '@ultimat3/manifest';
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

  // 4 of 5 real apps reported `changed: [], skipped: []` here: the row was owed and nobody was told.
  test('leaves an app that reworded the table alone', async () => {
    const app = memoryCodemodApp({ 'CLAUDE.md': '| Rules | mine |\n' });
    const result = await codemod.run(app);
    expect(result.changed).toEqual([]);
    expect(result.skipped.map((skip) => skip.path)).toEqual(['CLAUDE.md']);
    expect(result.skipped[0]?.reason).toContain(MANY_AGENTS_ROW);
    expect(app.files['CLAUDE.md']).toBe('| Rules | mine |\n');
  });

  test('finds the table in AGENTS.md when CLAUDE.md does not hold it', async () => {
    const app = memoryCodemodApp({ 'CLAUDE.md': 'See AGENTS.md.\n', 'AGENTS.md': TABLE });
    expect(await codemod.run(app)).toEqual({ changed: ['AGENTS.md'], skipped: [] });
    expect(app.files['AGENTS.md']).toContain(`${MANY_AGENTS_ROW}\n| One way |`);
    expect((await codemod.run(app)).changed).toEqual([]);
  });

  // One real app went to 12,071 bytes and the manifest step refused it (`X_AGENTS_MD_TOO_LARGE`).
  test('a row that would take the file over its byte budget is skipped with the count', async () => {
    const full = `${'x'.repeat(AGENTS_MD_MAX_BYTES - TABLE.length - 10)}\n${TABLE}`;
    const app = memoryCodemodApp({ 'CLAUDE.md': full });
    const result = await codemod.run(app);
    expect(result.changed).toEqual([]);
    expect(result.skipped[0]?.reason).toContain(String(AGENTS_MD_MAX_BYTES));
    expect(result.skipped[0]?.reason).toContain(MANY_AGENTS_ROW);
    expect(app.files['CLAUDE.md']).toBe(full);
  });

  test('a budget raised in x.verify.json is the one the row is held to', async () => {
    const full = `${'x'.repeat(AGENTS_MD_MAX_BYTES - TABLE.length - 10)}\n${TABLE}`;
    const floor = JSON.stringify({ steps: [], agentsMdMaxBytes: AGENTS_MD_MAX_BYTES + 1000 });
    const app = memoryCodemodApp({ 'CLAUDE.md': full, 'x.verify.json': floor });
    expect((await codemod.run(app)).changed).toEqual(['CLAUDE.md']);
  });
});
