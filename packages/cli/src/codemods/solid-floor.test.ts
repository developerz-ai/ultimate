// The solid-floor codemod over the pins older scaffolds wrote: every manifest's `solid-js` below the
// advisory floor is raised in its own shape (exact, caret, tilde); a range the app wrote itself is
// reported and left whole.

import { describe, expect, test } from 'bun:test';
import { SOLID_FLOOR } from '../doctor-advisory-floors';
import { memoryCodemodApp } from './codemod';
import { codemod } from './solid-floor';

const manifest = (field: string, range: string): string =>
  `{\n  "name": "older",\n  "${field}": {\n    "@ultimat3/ui": "31.20.0",\n    "solid-js": "${range}"\n  }\n}\n`;

describe('codemod · solid-floor', () => {
  test('is a codemod the engine can order', () => {
    expect(codemod.id).toBe('solid-floor');
    expect(codemod.since).toMatch(/^\d+\.\d+\.\d+$/);
    expect(codemod.summary).toContain(SOLID_FLOOR);
  });

  test('raises every manifest under the floor, keeping each pin shape and every other byte', async () => {
    const app = memoryCodemodApp({
      'package.json': manifest('dependencies', '1.9.17'),
      'apps/web/package.json': manifest('dependencies', '^1.9.4'),
      'packages/ui/package.json': manifest('peerDependencies', '~1.9.10'),
      'packages/db/package.json': '{\n  "name": "db"\n}\n',
    });
    const result = await codemod.run(app);
    expect(result).toEqual({
      changed: ['apps/web/package.json', 'package.json', 'packages/ui/package.json'],
      skipped: [],
    });
    expect(app.files['package.json']).toBe(manifest('dependencies', '1.9.18'));
    expect(app.files['apps/web/package.json']).toBe(manifest('dependencies', '^1.9.18'));
    expect(app.files['packages/ui/package.json']).toBe(manifest('peerDependencies', '~1.9.18'));
    // Twice is once: a second run finds nothing left to raise.
    expect(await codemod.run(app)).toEqual({ changed: [], skipped: [] });
  });

  test('a pin at or past the floor, or on a later major, is the app’s and untouched', async () => {
    const app = memoryCodemodApp({
      'package.json': manifest('dependencies', '1.9.19'),
      'apps/web/package.json': manifest('devDependencies', '^2.0.0'),
    });
    expect(await codemod.run(app)).toEqual({ changed: [], skipped: [] });
  });

  test('a range the app wrote itself is reported with the floor, never rewritten', async () => {
    const before = manifest('dependencies', '>=1.9.0 <2.0.0');
    const app = memoryCodemodApp({ 'package.json': before });
    const result = await codemod.run(app);
    expect(result.changed).toEqual([]);
    expect(result.skipped).toEqual([
      { path: 'package.json', reason: expect.stringContaining(`solid-js >=1.9.0 <2.0.0`) },
    ]);
    expect(result.skipped[0]?.reason).toContain(SOLID_FLOOR);
    expect(app.files['package.json']).toBe(before);
  });
});
