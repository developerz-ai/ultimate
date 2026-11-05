// `toolDescription` — the one lead an agent tool is described by (the mcp block, else the
// primitive's own, else a read or write default) plus its declared refusals, and a sweep holding
// every other package to calling it rather than spelling the default lead out again.

import { describe, expect, test } from 'bun:test';
import { Glob } from 'bun';
import { toolDescription } from './tool-description';

describe('toolDescription', () => {
  test('the mcp block wins over the primitive own description', () => {
    expect(toolDescription({ name: 'p', description: 'own', mcp: { description: 'mcp' } })).toBe(
      'mcp',
    );
  });

  test('the primitive own description is the lead when the mcp block names none', () => {
    expect(toolDescription({ name: 'p', description: 'own', mcp: {} })).toBe('own');
  });

  test('the default names the primitive when nothing was written', () => {
    expect(toolDescription({ name: 'publishPost' })).toBe('Run the "publishPost" action.');
  });

  // A read is not an action: an agent told to "run the listPosts action" plans a write.
  test('a read (mutates: false) defaults to a read lead; a write or an unsaid one to an action', () => {
    expect(toolDescription({ name: 'listPosts', mutates: false })).toBe(
      'Read with the "listPosts" query.',
    );
    expect(toolDescription({ name: 'publishPost', mutates: true })).toBe(
      'Run the "publishPost" action.',
    );
    expect(toolDescription({ name: 'listPosts', mutates: false }, ['X_NOT_FOUND'])).toBe(
      'Read with the "listPosts" query. Declared refusals: X_NOT_FOUND.',
    );
  });

  test('a declared errors: list ends whichever lead was chosen — the own description kept', () => {
    expect(toolDescription({ name: 'p', description: 'own' }, ['X_FORBIDDEN', 'X_NOT_FOUND'])).toBe(
      'own Declared refusals: X_FORBIDDEN, X_NOT_FOUND.',
    );
    expect(toolDescription({ name: 'p' }, ['X_FORBIDDEN'])).toBe(
      'Run the "p" action. Declared refusals: X_FORBIDDEN.',
    );
  });

  test('an empty list adds nothing', () => {
    expect(toolDescription({ name: 'p', description: 'own' }, [])).toBe('own');
  });
});

// The copies this function replaced (plan 101, wave 5b) drifted: two of them skipped the
// primitive's own description. They were five sites in four files — `ai/src/tools.ts` (two),
// `mcp/src/from-action.ts`, `mcp/src/projectable.ts`, `admin/src/mcp-tools.ts` — and the sweep
// reads every package but this one, so a fifth home cannot appear outside it.
describe('the default lead has one home', () => {
  const packages = `${import.meta.dir}/../..`;
  const copy = /`(?:Run|Read with) the "?\$\{/;

  test('no package but core restates a default lead', async () => {
    const offenders: string[] = [];
    let read = 0;
    for await (const found of new Glob('*/src/**/*.ts').scan(packages)) {
      // Windows scans with `\`: one spelling, or `core\` slips past the skip below.
      const file = found.replaceAll('\\', '/');
      if (file.startsWith('core/') || file.endsWith('.test.ts')) continue;
      read += 1;
      if (copy.test(await Bun.file(`${packages}/${file}`).text())) {
        offenders.push(`packages/${file}`);
      }
    }
    // Zero files read is a broken glob, never a clean tree.
    expect(read).toBeGreaterThan(100);
    expect(offenders).toEqual([]);
  });
});
