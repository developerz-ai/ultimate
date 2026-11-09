// The install cache the setup composite restores in every job is keyed on `bun.lock` alone, with no
// prefix fallback: a fallback restored the previous lock's cache and saved it again, grown.

import { describe, expect, test } from 'bun:test';
import type { Step } from './lib/ci-workflow-read';
import { expr, text } from './lib/ci-workflow-read';
import { repoRoot } from './lib/run';

const composite = Bun.YAML.parse(
  await Bun.file(`${repoRoot()}/.github/actions/setup/action.yml`).text(),
) as { readonly runs?: { readonly steps?: readonly Step[] } };
const caches = (composite.runs?.steps ?? []).filter((step) =>
  text(step.uses).startsWith('actions/cache@'),
);

describe('unit · setup composite · the bun install cache is one lockfile`s, never a grown one', () => {
  test('one cache, keyed on the OS and bun.lock, and no restore-keys', () => {
    expect(caches).toHaveLength(1);
    const options = caches[0]?.with ?? {};
    expect(options['key']).toBe(`bun-${expr('runner.os')}-${expr("hashFiles('bun.lock')")}`);
    expect(Object.keys(options).sort()).toEqual(['key', 'path']);
  });
});
