// What `x g guard` has to get right: the directory (it IS the registration), the exported `guard`
// the seam looks for, and a rule the emitted test actually drives. Failure case first — an emitted
// example that fires on nothing is a template nobody can tell is working.

import { describe, expect, test } from 'bun:test';
import { guardCode, guardFiles } from './guard';

const paths = (files: readonly { path: string }[]): readonly string[] =>
  files.map((file) => file.path);

const sourceOf = (name: string): string =>
  guardFiles(name).find((file) => file.path === `guards/${name}.ts`)?.contents ?? '';

describe('x g guard', () => {
  test('the emitted test drives the emitted rule, failure case first', () => {
    // The rule itself is executed in `guards.test.ts`, against a real migration through the real
    // seam. What is checkable here is that the scaffold ships a test that would notice: a
    // generated example nothing drives is the TODO this repo's generators refuse to emit.
    const spec = guardFiles('migration-safety').find((file) => file.path.endsWith('.test.ts'));
    expect(spec?.contents).toContain('unsafeAdditions');
    expect(spec?.contents.indexOf('is refused')).toBeLessThan(
      spec?.contents.indexOf('makes the same addition safe') ?? 0,
    );
    expect(sourceOf('migration-safety')).toContain(guardCode('migration-safety'));
  });

  test('the directory is the registration — nothing else is written and nothing registers it', () => {
    const files = guardFiles('migration-safety');
    expect(paths(files)).toEqual(['guards/migration-safety.ts', 'guards/migration-safety.test.ts']);
    // No manifest, no index, no list to append to: a guard that has to announce itself is a
    // guard an app can forget to announce.
    expect(sourceOf('migration-safety')).not.toContain('registerGuard');
  });

  test('the name is kebab-cased into both the file and the test that imports it', () => {
    const files = guardFiles('MigrationSafety');
    expect(paths(files)).toEqual(['guards/migration-safety.ts', 'guards/migration-safety.test.ts']);
    const spec = files.find((file) => file.path.endsWith('.test.ts'));
    expect(spec?.contents).toContain("from './migration-safety'");
  });

  test('the emitted guard exports what the seam looks for, and types it', () => {
    const source = sourceOf('migration-safety');
    expect(source).toContain('export const guard: Guard = {');
    expect(source).toContain("import type { Finding, Guard } from '@ultimat3/cli'");
  });

  test('every fix the emitted rule can produce names a command or a file', () => {
    // The seam refuses a guard finding whose fix is advice (`X_GUARD_FINDING_INVALID`), so a
    // template that emitted one would scaffold a guard that fails on its first real hit.
    expect(sourceOf('migration-safety')).toContain('x db migrate');
  });
});
