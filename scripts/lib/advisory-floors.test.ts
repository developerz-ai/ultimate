import { describe, expect, test } from 'bun:test';
import type { Advisory, Declaration, PackageFacts, World } from './advisory-floors';
import { decideFloor, parseAdvisories, raiseManifest } from './advisory-floors';

// Fixtures modelled on the registry as it stood 2026-11-15: solid-js 1.9.18 was the first release
// whose `seroval` range excluded every seroval advisory, and no sass release excludes the
// source-map-js one. Synthetic version lists, so the decision is pinned without the network.

const range = (from: number, to: number, prefix: string): string[] =>
  Array.from({ length: to - from + 1 }, (_, i) => `${prefix}${from + i}`);

const seroval: PackageFacts = { versions: range(0, 12, '1.6.'), dependencies: {} };
const solid: PackageFacts = {
  versions: ['1.8.22', ...range(0, 19, '1.9.'), '2.0.0'],
  dependencies: Object.fromEntries(
    range(0, 19, '1.9.').map((v) => [
      v,
      { seroval: Number(v.split('.')[2]) >= 18 ? '~1.6.11' : '~1.6.8' },
    ]),
  ),
};
const sourceMap: PackageFacts = { versions: ['1.0.0', '1.2.1', '1.2.2'], dependencies: {} };
const sass: PackageFacts = {
  versions: ['1.106.1', '1.108.2'],
  dependencies: {
    '1.106.1': { 'source-map-js': '>=0.6.2 <2.0.0' },
    '1.108.2': { 'source-map-js': '>=0.6.2 <2.0.0' },
  },
};

const ADVISORIES: Readonly<Record<string, readonly Advisory[]>> = {
  seroval: [{ id: 'GHSA-f86p-h4j2-7qgj', vulnerable: '>=1.6.0 <1.6.11' }],
  'solid-js': [{ id: 'GHSA-3qxh-p7jc-5xh6', vulnerable: '<1.9.4' }],
  'source-map-js': [{ id: 'GHSA-68fv-2mgg-jv7q', vulnerable: '>=1.0.0 <1.2.2' }],
};

const world: World = {
  facts: (name) =>
    ({ seroval, 'solid-js': solid, 'source-map-js': sourceMap, sass })[name] ?? undefined,
  advisories: (name) => ADVISORIES[name] ?? [],
};

const declared = (name: string, declaredRange: string): Declaration => ({
  manifest: 'packages/ui/package.json',
  field: 'peerDependencies',
  name,
  range: declaredRange,
});

describe('decideFloor', () => {
  test('raises a caret range to the first release whose own range excludes the advisory', () => {
    const verdict = decideFloor(declared('solid-js', '^1.9.0'), world);
    expect(verdict.kind).toBe('raise');
    if (verdict.kind !== 'raise') return;
    expect(verdict.to).toBe('^1.9.18');
    expect(verdict.exposures.map((e) => e.advisory).sort()).toEqual([
      'GHSA-3qxh-p7jc-5xh6',
      'GHSA-f86p-h4j2-7qgj',
    ]);
    expect(verdict.exposures.find((e) => e.package === 'seroval')?.via).toBe('solid-js');
  });

  test('an exact pin moves to the first clean release of its major', () => {
    const verdict = decideFloor(declared('solid-js', '1.9.17'), world);
    expect(verdict).toMatchObject({ kind: 'raise', to: '1.9.18' });
  });

  test('a range that admits only patched versions is clean', () => {
    expect(decideFloor(declared('solid-js', '^1.9.18'), world).kind).toBe('clean');
  });

  test('a transitive advisory no release of the direct dependency excludes is unfloorable', () => {
    const verdict = decideFloor(declared('sass', '1.106.1'), world);
    expect(verdict.kind).toBe('unfloorable');
    expect(verdict.kind === 'unfloorable' && verdict.exposures[0]).toMatchObject({
      advisory: 'GHSA-68fv-2mgg-jv7q',
      package: 'source-map-js',
      via: 'sass',
    });
  });

  test('an open range that is not a plain caret, tilde or pin is reported, never rewritten', () => {
    expect(decideFloor(declared('solid-js', '>=1.9.0 <2.0.0'), world).kind).toBe('unfloorable');
  });

  test('a 0.x caret never crosses its minor: that would be a breaking change, not a floor', () => {
    const zero: World = {
      facts: (name) =>
        name === 'zero' ? { versions: ['0.3.0', '0.3.1', '0.4.0'], dependencies: {} } : undefined,
      advisories: () => [{ id: 'GHSA-zero', vulnerable: '<0.4.0' }],
    };
    expect(decideFloor(declared('zero', '^0.3.0'), zero).kind).toBe('unfloorable');
  });

  test('a dependency the world cannot describe is unknown, never clean', () => {
    expect(decideFloor(declared('left-pad', '^1.0.0'), world).kind).toBe('unknown');
  });
});

describe('parseAdvisories', () => {
  test('joins every vulnerable range for the package and ignores the withdrawn and the others', () => {
    const parsed = parseAdvisories('seroval', [
      {
        ghsa_id: 'GHSA-9wx9-5pv9-3349',
        withdrawn_at: null,
        vulnerabilities: [
          { package: { name: 'seroval' }, vulnerable_version_range: '>= 1.5.5, < 1.6.10' },
          { package: { name: 'seroval' }, vulnerable_version_range: '< 1.0.0' },
          { package: { name: 'other' }, vulnerable_version_range: '< 9.0.0' },
        ],
      },
      {
        ghsa_id: 'GHSA-gone',
        withdrawn_at: '2026-01-01T00:00:00Z',
        vulnerabilities: [{ package: { name: 'seroval' }, vulnerable_version_range: '< 9.0.0' }],
      },
      'not an advisory',
    ]);
    expect(parsed).toEqual([
      { id: 'GHSA-9wx9-5pv9-3349', vulnerable: '>=1.5.5 <1.6.10 || <1.0.0' },
    ]);
  });
});

describe('raiseManifest', () => {
  test('rewrites the one declaration and keeps every other byte', () => {
    const before = '{\n  "peerDependencies": {\n    "solid-js": "^1.9.0"\n  }\n}\n';
    expect(raiseManifest(before, 'peerDependencies', 'solid-js', '^1.9.0', '^1.9.18')).toBe(
      '{\n  "peerDependencies": {\n    "solid-js": "^1.9.18"\n  }\n}\n',
    );
  });

  test('refuses a manifest that no longer declares the range it was asked to raise', () => {
    const before = '{\n  "peerDependencies": {\n    "solid-js": "^1.9.5"\n  }\n}\n';
    expect(() =>
      raiseManifest(before, 'peerDependencies', 'solid-js', '^1.9.0', '^1.9.18'),
    ).toThrow('X_ADVISORY_MANIFEST_MOVED');
  });
});
