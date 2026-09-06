// The substring bug, in one place. `path.includes('node_modules')` is true for every file of an app
// checked out under `~/dev/node_modules-experiments/myapp`, so `loadApp` skipped all of them and
// the app registered nothing — a zero-primitive manifest, green.

import { describe, expect, test } from 'bun:test';
import { hasPathSegment, pathSegments } from './path-segments';

describe('hasPathSegment', () => {
  test('a directory of that exact name, at any depth', () => {
    expect(hasPathSegment('node_modules/pkg/index.js', 'node_modules')).toBe(true);
    expect(hasPathSegment('/home/dev/app/apps/web/node_modules/x.ts', 'node_modules')).toBe(true);
    expect(hasPathSegment('/home/dev/app/packages/db/dist/index.js', 'dist')).toBe(true);
  });

  test('a name that merely CONTAINS the segment is not the segment', () => {
    expect(hasPathSegment('/home/dev/node_modules-experiments/myapp/app.ts', 'node_modules')).toBe(
      false,
    );
    expect(hasPathSegment('/app/packages/distribution/src/a.ts', 'dist')).toBe(false);
    expect(hasPathSegment('/app/my-node_modules/a.ts', 'node_modules')).toBe(false);
  });

  test('a backslash separator splits the same way, so the rule exists on Windows too', () => {
    expect(hasPathSegment('apps\\web\\node_modules\\x.ts', 'node_modules')).toBe(true);
    expect(pathSegments('a\\b/c')).toEqual(['a', 'b', 'c']);
  });
});
