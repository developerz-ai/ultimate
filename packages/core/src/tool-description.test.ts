import { describe, expect, test } from 'bun:test';
import { join } from 'node:path';
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

// The four copies this function replaced (plan 101, wave 5b) drifted: two of them skipped the
// primitive's own description. No tool projection may spell the default lead out again.
describe('the default lead has one home', () => {
  const packages = join(import.meta.dir, '..', '..');
  const copy = /`(?:Run|Read with) the "?\$\{/;

  for (const pkg of ['ai', 'mcp', 'admin']) {
    test(`packages/${pkg}/src restates no default lead`, async () => {
      const offenders: string[] = [];
      for await (const file of new Glob('**/*.ts').scan(join(packages, pkg, 'src'))) {
        if (file.endsWith('.test.ts')) continue;
        if (copy.test(await Bun.file(join(packages, pkg, 'src', file)).text())) {
          offenders.push(`packages/${pkg}/src/${file}`);
        }
      }
      expect(offenders).toEqual([]);
    });
  }
});
