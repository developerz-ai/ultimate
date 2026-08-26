// Single responsibility: a suite that registers an entity at module scope unregisters it even when
// the suite never runs. Bun evaluates a skipped file's module body and then does NOT run a hook
// inside `describe.skipIf(true)` — measured below — so a `clearRegistry()` parked in that hook
// leaks the entity into every later file in the process, where the next same-named `entity()` is an
// `X_ENTITY_DUPLICATE` nobody can attribute. Static, because the leak shows only in the ONE
// configuration a live suite is never deliberately run in.

import { afterAll, describe, expect, test } from 'bun:test';

/** A `const x = entity(` at column 0 — registration that happens on import, skip or no skip. */
const REGISTERS_ON_IMPORT = /^const .* = entity\(/m;

/**
 * The one spelling, assembled rather than written so this file is not its own counter-example. A
 * dedicated top-level hook and not a line inside the teardown, because the teardown is the part
 * that must NOT run without a server: an `if (!hasPostgres) return` above it is the same hole by a
 * second route, and an exact-text rule cannot be satisfied by either.
 */
const UNCONDITIONAL = ['afterAll(() => {', '  clearRegistry();', '});'].join('\n');

const liveSuites = async (): Promise<readonly (readonly [string, string])[]> => {
  const files: [string, string][] = [];
  for await (const file of new Bun.Glob('*.live.test.ts').scan({ cwd: import.meta.dir })) {
    files.push([file, await Bun.file(`${import.meta.dir}/${file}`).text()]);
  }
  return files.sort(([left], [right]) => left.localeCompare(right));
};

/** Pushed to by a hook that must never run. Module scope, so the skipped block can reach it. */
const ranInsideSkipped: string[] = [];

describe.skipIf(true)('a skipped block, here only to be measured', () => {
  afterAll(() => {
    ranInsideSkipped.push('inside');
  });

  test('never runs', () => {
    expect(1).toBe(1);
  });
});

describe('unit · a skipped live suite still empties the registry', () => {
  /**
   * The measurement the rule rests on. If a future bun runs hooks inside a skipped `describe`, this
   * fails and the whole file is deletable with evidence rather than kept out of caution.
   */
  test('bun does not run a hook inside a skipped describe', () => {
    expect(ranInsideSkipped).toEqual([]);
  });

  test('every live suite that registers on import clears unconditionally', async () => {
    const offenders: string[] = [];
    for (const [file, source] of await liveSuites()) {
      if (!REGISTERS_ON_IMPORT.test(source)) continue;
      const calls = [...source.matchAll(/\bclearRegistry\(\)/g)].length;
      if (calls !== 1)
        offenders.push(`${file}: ${calls} clearRegistry() calls, expected exactly 1`);
      else if (!source.includes(UNCONDITIONAL)) {
        offenders.push(`${file}: clearRegistry() is not in a top-level afterAll of its own`);
      }
    }
    expect(offenders).toEqual([]);
  });

  /**
   * The rule needs something to bind to: a live suite registering nothing on import needs no hook,
   * and one that does register must import the seam it is required to call.
   */
  test('and each of them imports the seam it is required to call', async () => {
    const offenders: string[] = [];
    for (const [file, source] of await liveSuites()) {
      if (!REGISTERS_ON_IMPORT.test(source)) continue;
      if (!source.includes("import { clearRegistry } from './registry'")) offenders.push(file);
    }
    expect(offenders).toEqual([]);
  });
});
