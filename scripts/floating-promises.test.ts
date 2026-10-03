// Holds the SCOPE of Biome's `nursery/noFloatingPromises`: every file Biome lints, tests and
// `scripts/` included. Two overrides switched it off outside `packages/*/src` and in every test
// until plan 101 slice 13 — a lint-time cost that no longer reproduces — and a test that forgets
// `await` on `expect(…).rejects` passes whatever the promise does.

import { describe, expect, setDefaultTimeout, test } from 'bun:test';
import { REPO_SCAN_TIMEOUT_MS, repoRoot } from './lib/run';

setDefaultTimeout(REPO_SCAN_TIMEOUT_MS);

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** `linter.rules.nursery.noFloatingPromises` of one config node, whatever shape it was written in. */
const levelIn = (node: unknown): unknown => {
  const linter = isRecord(node) ? node['linter'] : undefined;
  const rules = isRecord(linter) ? linter['rules'] : undefined;
  const nursery = isRecord(rules) ? rules['nursery'] : undefined;
  const rule = isRecord(nursery) ? nursery['noFloatingPromises'] : undefined;
  return isRecord(rule) ? rule['level'] : rule;
};

/** Every override that names the rule at a level other than `error`, by its `includes`. */
function narrowedScopes(config: unknown): readonly string[] {
  const overrides = isRecord(config) ? config['overrides'] : undefined;
  return (Array.isArray(overrides) ? overrides : [])
    .filter((override) => levelIn(override) !== undefined && levelIn(override) !== 'error')
    .map((override) => JSON.stringify(isRecord(override) ? override['includes'] : override));
}

describe('noFloatingPromises covers every file Biome lints', () => {
  test('an override that switches it off is found', () => {
    const narrowed = {
      linter: { rules: { nursery: { noFloatingPromises: 'error' } } },
      overrides: [
        {
          includes: ['**/*.test.ts'],
          linter: { rules: { nursery: { noFloatingPromises: 'off' } } },
        },
        {
          includes: ['x'],
          linter: { rules: { nursery: { noFloatingPromises: { level: 'warn' } } } },
        },
        { includes: ['**/scss.d.ts'], linter: { rules: { style: { noDefaultExport: 'off' } } } },
      ],
    };
    expect(narrowedScopes(narrowed)).toEqual(['["**/*.test.ts"]', '["x"]']);
  });

  test('the committed biome.json enables it at error and narrows it nowhere', async () => {
    const config: unknown = await Bun.file(`${repoRoot()}/biome.json`).json();
    expect(levelIn(config)).toBe('error');
    expect(
      narrowedScopes(config),
      'biome.json switches noFloatingPromises off for these includes — delete the override and await (or `void` with a why:) each promise it then reports',
    ).toEqual([]);
  });
});
