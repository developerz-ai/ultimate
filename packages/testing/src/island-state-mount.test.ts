// `describeIslandState` and `mountIslandState`, exercised by REGISTERING through them: the suite
// form calls `describe`, `beforeAll` and `afterAll`, so the honest witness is a real block whose
// tests read the mount, plus a file-level `afterAll` that reads what the blocks left behind.

import { afterAll, describe, expect, test } from 'bun:test';
// why: Bun ships no temp-directory primitive and no recursive delete.
import { mkdtemp, rm } from 'node:fs/promises';
// why: Bun exposes no tmpdir(); only node:os answers the platform temp root.
import { tmpdir } from 'node:os';
// why: Bun ships no path-join primitive.
import { join } from 'node:path';
import { defineIslandStates } from './define-island-states';
import type { IslandBuilder } from './fixture-island';
import { FILE, LIVE_ISLAND, ROOT } from './fixture-island-fixtures.test';
import { describeIslandState, mountIslandState } from './island-state-mount';
import { testName } from './test-types';

const states = defineIslandStates({
  island: FILE,
  states: [
    { id: 'idle', title: 'the first paint', props: { label: 'count' } },
    { id: 'long-label', title: 'a label three times as long', props: { label: 'Zähler' } },
  ],
});

let builds = 0;
/** Counts what reaches the bundler: the whole point of the suite form is that this is ONE. */
const build: IslandBuilder = (root, options) => {
  builds += 1;
  return Promise.resolve({
    chunks: root === ROOT && options?.only === FILE ? [{ file: FILE, code: LIVE_ISLAND }] : [],
  });
};
const island = { build, root: ROOT, shell: '<span>shell</span>' };

const documentInstalled = (): boolean => 'document' in globalThis;
const seen: string[] = [];

describeIslandState(states, 'idle', island, (mounted) => {
  test('the block mounts the state it names, with that state’s props', () => {
    seen.push('idle');
    expect(mounted().text('[data-role="count"]')).toBe('count 0');
    // The server shell went in and `mount` replaced it.
    expect(mounted().find('span')).toBeNull();
  });

  test('one mount per block: the second test sees what the first one did', () => {
    expect(mounted().fire('button', 'click')).toBe(true);
    expect(mounted().text('[data-role="count"]')).toBe('count 1');
  });
});

describeIslandState(states, 'long-label', island, (mounted) => {
  test('the next block starts from its own state, on a fresh mount', () => {
    seen.push('long-label');
    expect(mounted().text('[data-role="count"]')).toBe('Zähler 0');
  });
});

describe(testName('unit', 'mountIslandState'), () => {
  test('a state the manifest does not declare is refused by name, listing the declared ones', async () => {
    const refused = await mountIslandState(states, 'idel', island).catch((error: unknown) => error);
    expect(refused).toBeUltimateError('X_TEST_ISLAND_STATE_UNKNOWN');
    expect(String((refused as { cause?: unknown }).cause)).toContain('idle, long-label');
    // Refused before anything was installed: no build, no fake `document` left behind.
    expect(documentInstalled()).toBe(false);
  });

  test('`using` owns the teardown of a mount one test asked for', async () => {
    {
      using mounted = await mountIslandState(states, 'long-label', island);
      expect(mounted.text('[data-role="count"]')).toBe('Zähler 0');
      expect(documentInstalled()).toBe(true);
    }
    expect(documentInstalled()).toBe(false);
  });

  test('a build that rejects is not kept: the next mount builds again and reports its own', async () => {
    let calls = 0;
    const flaky: IslandBuilder = () => {
      calls += 1;
      // The bundler's own failure, as input: what the helper must not cache.
      return calls === 1
        ? Promise.reject(new Error('bundler down'))
        : Promise.resolve({ chunks: [{ file: FILE, code: LIVE_ISLAND }] });
    };
    const flakyIsland = { build: flaky, root: ROOT };
    await expect(mountIslandState(states, 'idle', flakyIsland)).rejects.toThrow('bundler down');
    using mounted = await mountIslandState(states, 'idle', flakyIsland);
    expect(mounted.text('[data-role="count"]')).toBe('count 0');
    expect(calls).toBe(2);
  });

  test('the accessor outside its own block’s tests has nothing to hand over', () => {
    // Blocks run in declaration order, so the block below has not mounted yet.
    expect(() => lateAccessor?.()).toThrow(/is not mounted/);
    expect(lateAccessor).toBeDefined();
  });
});

/** A block's accessor, held outside the block — the misuse the refusal is for. */
let lateAccessor: (() => unknown) | undefined;
describeIslandState(states, 'idle', island, (mounted) => {
  lateAccessor = mounted;
  test('a third block still costs no build', () => {
    expect(mounted().el).toBeDefined();
  });
});

afterAll(() => {
  // Both blocks ran, each disposed its mount, and the island was built ONCE for the file — the
  // four mounts above (three blocks and one `using`) share one bundle.
  expect(seen).toEqual(['idle', 'long-label']);
  expect(builds).toBe(1);
  expect(documentInstalled()).toBe(false);
});

const HELPER = join(import.meta.dir, 'island-state-mount.ts');
const STATES = join(import.meta.dir, 'define-island-states.ts');

/**
 * One slow build under two deadlines: the suite form's `timeoutMs` is the build's own. Ordered by
 * SIGNALS, never by sleeps — the short block's build resolves only when the last test releases
 * it, and that test waits for the late mount itself, so a loaded runner changes no outcome.
 */
const CHILD = `
import { test } from 'bun:test';
import { describeIslandState } from ${JSON.stringify(HELPER)};
import { defineIslandStates } from ${JSON.stringify(STATES)};
const FILE = 'apps/web/site/slow.island.tsx';
const states = defineIslandStates({ island: FILE, states: [{ id: 'idle', title: 'idle', props: {} }] });
let release;
const gate = new Promise((resolve) => { release = resolve; });
const chunk = (name) => ({ chunks: [{ file: FILE, code: 'export function mount(el) { globalThis.__mounted = (globalThis.__mounted ?? 0) + 1; el.textContent = ' + JSON.stringify(name) + '; }' }] });
describeIslandState(states, 'idle', { build: () => gate.then(() => chunk('short')), root: '/a', timeoutMs: 20 }, (mounted) => {
  test('short', () => { mounted(); });
});
describeIslandState(states, 'idle', { build: async () => chunk('long'), root: '/b', timeoutMs: 30000 }, (mounted) => {
  test('long', () => { if (mounted().el.textContent !== 'long') process.exit(3); });
});
// The short block's mount resolves AFTER its deadline and its afterAll: it must not stay installed.
test('nothing is left installed', async () => {
  const before = globalThis.__mounted;
  release();
  while (globalThis.__mounted === before) await Bun.sleep(1);
  // The late mount's own continuation disposes it: every microtask drains before a macrotask.
  await new Promise((resolve) => setImmediate(resolve));
  if ('document' in globalThis) process.exit(4);
});
`;

test('timeoutMs is the deadline of the mount, build included', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ultimate-island-state-'));
  try {
    await Bun.write(join(dir, 'slow.test.ts'), CHILD);
    const run = Bun.spawn(['bun', 'test', './slow.test.ts'], {
      cwd: dir,
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const output = `${await new Response(run.stdout).text()}${await new Response(run.stderr).text()}`;
    expect(await run.exited).toBe(1);
    expect(output).toContain('unit · the slow island, idle');
    // The short block's one test fails on its hook's deadline; the long block's and the leak
    // check pass. Exit 3 is a mount holding the wrong island, 4 a `document` left installed.
    expect(output).toContain('hook timed out');
    expect(output).toContain(' 2 pass');
    expect(output).toContain(' 1 fail');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}, 20_000);
