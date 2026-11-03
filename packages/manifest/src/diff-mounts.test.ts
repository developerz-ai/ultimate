// A mount's cut is what a held token reaches, so every way a call turns into a 404 is breaking and
// nothing else is. The primitive stays registered in each case: `diffQueries` and `diffActions`
// see no change, which is why a mount needs a classifier of its own.

import { describe, expect, test } from 'bun:test';
import { diffManifest } from './diff';
import type { ChangeKind, ManifestChange } from './diff-change';
import { fixtureManifest } from './diff-fixture';
import { diffMounts } from './diff-mounts';
import { isManifest, type MountFact } from './schema';

const V1: MountFact = {
  prefix: '/v1',
  scopes: { 'run:read': ['liveRunEvents'], 'run:write': ['cancelRun', 'startRun'] },
};

const only = (changes: readonly ManifestChange[]): readonly [ChangeKind, string][] =>
  changes.map((change) => [change.kind, change.path]);

describe('unit · what a held token stops reaching is breaking', () => {
  test('nothing moved, nothing reported', () => {
    expect(diffMounts([V1], [V1])).toEqual([]);
  });

  test('a prefix removed, or renamed, is the old one gone', () => {
    expect(only(diffMounts([V1], []))).toEqual([['breaking', 'mounts./v1']]);
    expect(only(diffMounts([V1], [{ ...V1, prefix: '/v2' }]))).toEqual([
      ['breaking', 'mounts./v1'],
      ['additive', 'mounts./v2'],
    ]);
  });

  test('a name leaving the cut', () => {
    const after = { ...V1, scopes: { ...V1.scopes, 'run:write': ['startRun'] } };
    expect(diffMounts([V1], [after])).toEqual([
      {
        kind: 'breaking',
        path: 'mounts./v1.scopes.run:write.cancelRun',
        detail: 'left the cut; a held token now answers 404',
      },
    ]);
  });

  test('a scope removed takes each of its names with it', () => {
    const after = { ...V1, scopes: { 'run:read': ['liveRunEvents'] } };
    expect(only(diffMounts([V1], [after]))).toEqual([
      ['breaking', 'mounts./v1.scopes.run:write.cancelRun'],
      ['breaking', 'mounts./v1.scopes.run:write.startRun'],
    ]);
  });

  test('a name moving scope: a token holding the old one stops reaching it', () => {
    const after = {
      ...V1,
      scopes: { 'run:read': ['cancelRun', 'liveRunEvents'], 'run:write': ['startRun'] },
    };
    const changes = diffMounts([V1], [after]);
    expect(only(changes)).toEqual([
      ['breaking', 'mounts./v1.scopes.run:write.cancelRun'],
      ['additive', 'mounts./v1.scopes.run:read.cancelRun'],
    ]);
    expect(changes[0]?.detail).toContain('run:read');
  });
});

describe('unit · what only widens the cut is additive', () => {
  test('a mount added', () => {
    expect(only(diffMounts([], [V1]))).toEqual([['additive', 'mounts./v1']]);
  });

  test('a name added to a scope', () => {
    const after = { ...V1, scopes: { ...V1.scopes, 'run:read': ['liveRunEvents', 'runList'] } };
    expect(only(diffMounts([V1], [after]))).toEqual([
      ['additive', 'mounts./v1.scopes.run:read.runList'],
    ]);
  });

  test('a scope added, names and all', () => {
    const after = { ...V1, scopes: { ...V1.scopes, 'run:audit': ['runList'] } };
    expect(only(diffMounts([V1], [after]))).toEqual([
      ['additive', 'mounts./v1.scopes.run:audit'],
      ['additive', 'mounts./v1.scopes.run:audit.runList'],
    ]);
  });

  test('a name also granted to a second scope: every holder still reaches it', () => {
    const after = { ...V1, scopes: { ...V1.scopes, 'run:read': ['cancelRun', 'liveRunEvents'] } };
    expect(only(diffMounts([V1], [after]))).toEqual([
      ['additive', 'mounts./v1.scopes.run:read.cancelRun'],
    ]);
  });

  test('an empty scope leaving reaches nobody: reported, not breaking', () => {
    const before = { ...V1, scopes: { ...V1.scopes, 'run:audit': [] } };
    expect(only(diffMounts([before], [V1]))).toEqual([['internal', 'mounts./v1.scopes.run:audit']]);
  });
});

describe('unit · the section, through diffManifest', () => {
  test('emptying it is classified — the last mount leaving drops the key from the file', () => {
    const before = fixtureManifest({ mounts: [V1] });
    const after = fixtureManifest({ mounts: [] });
    expect('mounts' in after).toBe(false);
    const diff = diffManifest(before, after);
    expect(diff.hasBreaking).toBe(true);
    expect(diff.breaking.map((change) => change.path)).toEqual(['mounts./v1']);
  });

  test('a file written before mounts were published carries none: that is not a removal', () => {
    const { mounts: _dropped, ...legacy } = fixtureManifest({ mounts: [V1] });
    expect(isManifest(legacy)).toBe(true);
    const diff = diffManifest(legacy, fixtureManifest({ mounts: [V1] }));
    expect(diff.hasBreaking).toBe(false);
    expect(diff.additive.map((change) => change.path)).toEqual(['mounts./v1']);
  });

  test('a damaged section is not a manifest', () => {
    expect(isManifest({ ...fixtureManifest(), mounts: 'nope' })).toBe(false);
  });
});
