// The enforcement half of `scripts/fetch-deadline.ts`: the gate's `unit` step runs every
// `scripts/**/*.test.ts`, so a new shipped `fetch(` with no signal above its package pin fails
// `bun run verify` here. Fixtures prove each shape; the last block holds the real tree.

import { describe, expect, setDefaultTimeout, test } from 'bun:test';
import {
  checkFetches,
  fetchFindingFor,
  fetchGaps,
  fetchSites,
  scanFetches,
} from './fetch-deadline';
import { FETCH_DEADLINE_PINS, FETCH_DEADLINE_PINS_FILE } from './lib/fetch-deadline-pins';
import { REPO_SCAN_TIMEOUT_MS, repoRoot } from './lib/run';

setDefaultTimeout(REPO_SCAN_TIMEOUT_MS);

const SHIPPED = 'packages/x/src/client.ts';

const calls = (path: string, source: string): readonly string[] =>
  scanFetches(path, source).map((site) => `${String(site.line)}:${site.call}`);

describe('a shipped fetch', () => {
  test('bare, globalThis. and a signal nested in another key are sites', () => {
    const source = [
      'await fetch(url);',
      "await globalThis.fetch(url, { method: 'POST' });",
      'await fetch(url, { env: { signal } });',
      'await fetch(url, init);',
    ].join('\n');
    expect(calls(SHIPPED, source)).toEqual(['1:fetch', '2:globalThis.fetch', '3:fetch', '4:fetch']);
  });

  test('a signal in its own options, as a key or shorthand, is not', () => {
    expect(calls(SHIPPED, 'await fetch(url, { signal });')).toEqual([]);
    expect(calls(SHIPPED, 'await fetch(url, { method, signal: ctx.signal });')).toEqual([]);
  });

  test('an injected seam, a definition, a comment, a string, a test and an island are not', () => {
    expect(calls(SHIPPED, 'await deps.fetch(url);')).toEqual([]);
    expect(calls(SHIPPED, 'Bun.serve({ fetch(request) { return answer; } });')).toEqual([]);
    expect(calls(SHIPPED, 'export async function fetch(url: string) {}')).toEqual([]);
    expect(calls(SHIPPED, "// await fetch(url);\nconst s = 'fetch(url)';")).toEqual([]);
    expect(calls('packages/x/src/client.test.ts', 'await fetch(url);')).toEqual([]);
    expect(calls('packages/x/src/client-fixture.ts', 'await fetch(url);')).toEqual([]);
    expect(calls('apps/web/app/a/like.island.tsx', 'await fetch(url);')).toEqual([]);
  });
});

describe('the ratchet', () => {
  const site = { path: SHIPPED, line: 3, call: 'fetch' };

  test('a package over its pin is X_FETCH_UNBOUNDED, naming the site and outbound()', () => {
    const [gap] = checkFetches([site], {}, true);
    const finding = fetchFindingFor(gap ?? expect.unreachable());
    expect(finding.code).toBe('X_FETCH_UNBOUNDED');
    expect(finding.cause).toContain(`${SHIPPED}:3 (fetch)`);
    expect(finding.fix).toContain('outbound() from @ultimat3/core/outbound');
    expect(finding.fix).toContain(FETCH_DEADLINE_PINS_FILE);
  });

  test('a pin above the tree is stale, with the command that lowers it; a blank one waives nothing', () => {
    const pins = { x: { count: 1, reason: 'why: a local function named fetch' } };
    expect(checkFetches([site], pins, true)).toEqual([]);
    const [stale] = checkFetches([], pins, true);
    expect(fetchFindingFor(stale ?? expect.unreachable()).fix).toBe(
      'bun run scripts/fetch-deadline.ts --unpin x',
    );
    const codes = checkFetches([site], { x: { count: 1, reason: ' ' } }, true).map(
      (gap) => fetchFindingFor(gap).code,
    );
    expect(codes).toContain('X_FETCH_DEADLINE_PIN_UNEXPLAINED');
    const [empty] = checkFetches([], {}, false);
    expect(fetchFindingFor(empty ?? expect.unreachable()).code).toBe('X_CORPUS_UNSCANNED');
  });
});

describe('the real tree', () => {
  test('every pin carries a why: and a count above zero', () => {
    for (const pin of Object.values(FETCH_DEADLINE_PINS)) {
      expect(pin.reason).toContain('why:');
      expect(pin.count).toBeGreaterThan(0);
    }
  });

  test('is on the ratchet, and the scan really read it', async () => {
    // Non-vacuity: the pinned sites ARE found — a scan matching nothing agrees with no pin.
    expect((await fetchSites(repoRoot())).length).toBeGreaterThanOrEqual(6);
    expect(await fetchGaps(repoRoot())).toEqual([]);
  });
});
