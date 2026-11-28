import { describe, expect, test } from 'bun:test';
import { SCAFFOLD_AGENTS_MD_MAX_BYTES } from '../templates/scaffold-docs';
import { codemod } from './agents-md-budget';
import { memoryCodemodApp } from './codemod';

const FLOOR = 'x.verify.json';

describe('unit · agents-md-budget codemod', () => {
  test('a floor that declares no budget gains the scaffold one, keeping its other keys', async () => {
    const app = memoryCodemodApp({ [FLOOR]: '{"steps":["unit"],"strict":true}\n' });
    expect(await codemod.run(app)).toEqual({ changed: [FLOOR], skipped: [] });
    expect(JSON.parse(app.files[FLOOR] ?? '')).toEqual({
      steps: ['unit'],
      strict: true,
      agentsMdMaxBytes: SCAFFOLD_AGENTS_MD_MAX_BYTES,
    });
  });

  test('a budget the author raised above the default is left alone', async () => {
    const app = memoryCodemodApp({ [FLOOR]: '{"agentsMdMaxBytes":20000}\n' });
    expect(await codemod.run(app)).toEqual({ changed: [], skipped: [] });
    expect(app.files[FLOOR]).toBe('{"agentsMdMaxBytes":20000}\n');
  });

  test("a deliberate lower cap is the author's and stays", async () => {
    const app = memoryCodemodApp({ [FLOOR]: '{"agentsMdMaxBytes":10000}\n' });
    expect(await codemod.run(app)).toEqual({ changed: [], skipped: [] });
    expect(app.files[FLOOR]).toBe('{"agentsMdMaxBytes":10000}\n');
  });

  test('the default declared out loud becomes exactly the scaffold budget, and a second run changes nothing', async () => {
    const app = memoryCodemodApp({ [FLOOR]: '{"agentsMdMaxBytes":12000}\n' });
    expect((await codemod.run(app)).changed).toEqual([FLOOR]);
    expect(JSON.parse(app.files[FLOOR] ?? '').agentsMdMaxBytes).toBe(SCAFFOLD_AGENTS_MD_MAX_BYTES);
    expect(SCAFFOLD_AGENTS_MD_MAX_BYTES).toBe(13_120);
    expect(await codemod.run(app)).toEqual({ changed: [], skipped: [] });
  });

  test('no floor file is nothing to do; an unparseable one is reported', async () => {
    expect(await codemod.run(memoryCodemodApp({}))).toEqual({ changed: [], skipped: [] });
    const broken = memoryCodemodApp({ [FLOOR]: '{' });
    expect((await codemod.run(broken)).skipped[0]?.path).toBe(FLOOR);
  });
});
