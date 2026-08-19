// The manifest panel classifies a diff into added / removed / changed, and `undefined` on one
// side is what tells the three apart. Getting that wrong reports every drift as a change and
// leaves an operator running `x manifest` without knowing what it will do.

import { describe, expect, test } from 'bun:test';
import { staticDevSources } from './data';
import type { ManifestFact } from './facts';
import { manifestPanel } from './panel-manifest';

const factsWith = (diff: ManifestFact['diff']): ManifestFact => ({
  emitted: { packages: 30 },
  committed: { packages: 29 },
  diff,
});

const data = (diff: ManifestFact['diff']): ReturnType<typeof manifestPanel.data> =>
  manifestPanel.data(
    staticDevSources({ manifest: () => Promise.resolve(factsWith(diff)) }),
    new URLSearchParams(),
  );

describe('a current manifest', () => {
  test('an empty diff has not drifted, and still prints the command', async () => {
    const panel = await data([]);
    expect(panel.drifted).toBe(false);
    expect(panel.added).toEqual([]);
    expect(panel.removed).toEqual([]);
    expect(panel.changed).toEqual([]);
    // The fix is unconditional: a reader who wants to regenerate anyway needs the line.
    expect(panel.fix).toBe('x manifest');
  });

  test('the raw facts are carried through, so --json and the tab are the same bytes', async () => {
    const panel = await data([]);
    expect(panel.manifest).toEqual(factsWith([]));
  });
});

describe('a drifted manifest', () => {
  const DIFF: ManifestFact['diff'] = [
    // Present in the emitted manifest, absent from the committed one: something new.
    { path: 'packages.scraping', emitted: { tier: 5 }, committed: undefined },
    // The mirror image: a package that no longer exists.
    { path: 'packages.legacy', emitted: undefined, committed: { tier: 3 } },
    // Both sides present and different.
    { path: 'codes.X_ADMIN_DENIED.owner', emitted: 'admin', committed: 'policy' },
  ];

  test('each entry lands in exactly one bucket, decided by which side is undefined', async () => {
    const panel = await data(DIFF);
    expect(panel.drifted).toBe(true);
    expect(panel.added).toEqual(['packages.scraping']);
    expect(panel.removed).toEqual(['packages.legacy']);
    expect(panel.changed).toEqual(['codes.X_ADMIN_DENIED.owner']);
  });

  test('a value that is null on one side is a CHANGE, not a removal', async () => {
    // `null` is a value the manifest can hold; only `undefined` means "this side has no entry".
    const panel = await data([{ path: 'codes.X.docs', emitted: null, committed: 'https://x' }]);
    expect(panel.changed).toEqual(['codes.X.docs']);
    expect(panel.removed).toEqual([]);
    expect(panel.added).toEqual([]);
  });

  test('an entry absent from both sides is reported as added AND removed, never silently', async () => {
    // Not a shape the generator emits — pinned because the two filters are independent, and a
    // bucket that swallowed it would drop a row out of a panel whose whole job is completeness.
    const panel = await data([{ path: 'ghost', emitted: undefined, committed: undefined }]);
    expect(panel.added).toEqual(['ghost']);
    expect(panel.removed).toEqual(['ghost']);
    expect(panel.changed).toEqual([]);
    expect(panel.drifted).toBe(true);
  });
});
