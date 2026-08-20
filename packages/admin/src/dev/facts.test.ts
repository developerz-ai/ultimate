// `facts.ts` is the SHAPE a panel renders, kept apart from the sources that produce them so a
// panel imports the shape and nothing else. Two properties follow from that, and both are
// checkable at runtime rather than only in prose.

import { describe, expect, test } from 'bun:test';
import { defaultDevSources, staticDevSources } from './data';
// A VALUE import on purpose: `import type` would erase and this file could not see whether the
// module ships anything at all.
import * as facts from './facts';

describe('the shape module stays type-only', () => {
  test('it exports no runtime value — a shape a panel imports must not carry code', () => {
    // Everything here is an `interface` or a `type`, so the compiled module is empty. A `const`
    // added beside them would ship /_x's vocabulary into whatever imports the shape, which is
    // the split this file's placement exists to keep.
    expect(Object.keys(facts)).toEqual([]);
  });
});

describe('DevSources has exactly one implementation shape, and two implementations of it', () => {
  const REQUIRED = [
    'routes',
    'traces',
    'statementLoops',
    'liveQueries',
    'subscribers',
    'jobDefs',
    'queues',
    'jobRuns',
    'backfills',
    'tasks',
    'tables',
    'drift',
    'runSql',
    'mail',
    'cacheGraph',
    'invalidations',
    'policyMatrix',
    'manifest',
  ] as const;

  test('the fixture source and the registry source answer the SAME member set', () => {
    // Neither may grow a member the other lacks: a panel is written against `DevSources` and
    // reaches for the member by name, so a source that forgot one is a `TypeError` in `/_x`
    // rather than a missing panel row. Compared to each other, so this cannot be satisfied by
    // updating one list.
    expect(Object.keys(staticDevSources()).sort()).toEqual(Object.keys(defaultDevSources()).sort());
  });

  test('every declared member is present on both, and every one is callable', () => {
    const fixture = staticDevSources() as unknown as Record<string, unknown>;
    const registry = defaultDevSources() as unknown as Record<string, unknown>;
    for (const member of REQUIRED) {
      expect(typeof fixture[member]).toBe('function');
      expect(typeof registry[member]).toBe('function');
    }
    // The list above is the whole surface — no member exists that it does not name.
    expect(Object.keys(fixture).sort()).toEqual([...REQUIRED].sort());
  });

  test('every member answers a promise, so a panel can await one without branching', () => {
    // Variadic: `runSql` is the one member that takes an argument, and a nullary erasure would
    // make the call below a compile error rather than the check it is meant to be.
    const fixture = staticDevSources() as unknown as Record<
      string,
      (...args: readonly unknown[]) => unknown
    >;
    for (const member of REQUIRED) {
      const answer = fixture[member]?.('select 1');
      expect(answer).toBeInstanceOf(Promise);
    }
  });
});
