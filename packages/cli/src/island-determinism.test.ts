// One question, and it needs a REAL dependency graph to ask it: does an island whose sources have
// not moved keep its URL?
//
// Split from `island-bundle.test.ts` because that suite's fixtures are single modules with no
// imports, and a single module is where this defect is invisible — its
// "the same source hashes to the same URL" test passed throughout. `Bun.build`'s minified output
// is not byte-deterministic once there is a third-party graph to walk: measured on 1.4.0 against
// ai-maxxing's 131,858-byte `session-console` island with no source file touched (`find -newermt`
// clean), TEN distinct `session-console-*.js` names in ten minutes, flipping BACK AND FORTH
// between values — roughly one build in ten renamed its minified identifiers differently, same
// output length, `var ca=Object.defineProperty` against `var la=…`.
//
// Both consequences were confirmed in that app: the service worker's precache manifest named
// `/islands/session-console-bbe72226.js`, which 404ed, and the browser's `immutable` cache never
// hit, so a 131 kB island was re-downloaded on every visit.
//
// The fixture imports `@ultimat3/realtime` and `solid-js` because a graph of the app's OWN modules
// is not enough: forty generated local modules were measured emitting one byte string across forty
// builds, and the same entry with the two package imports added raced within forty. Both resolve
// from `packages/cli/node_modules`, so this suite needs nothing outside its own package.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
// why: `node:` by necessity — Bun ships no path API, and `rm(…, { force: true })` removes a
// fixture root that may not exist without a branch.
import { rm } from 'node:fs/promises';
// why: Bun exposes no path API — nothing native joins a directory to a file.
import { join } from 'node:path';
import { clearStylesheets, contentHash } from '@ultimat3/render/server';
import { buildIslands, clearIslandChunkCache } from './island-bundle';

// `.island-fixture/determinism`, never `.island-fixture` itself — `island-bundle.test.ts` wipes
// its own subdirectory of that parent, and owning the parent deletes a sibling suite mid-build.
const ROOT = join(import.meta.dir, '..', '.island-fixture', 'determinism');
const ISLAND = 'apps/web/app/graph.island.tsx';

/** Enough builds that a one-in-ten race is all but certain to fire; ~25ms each on this fixture. */
const ROUNDS = 40;

const SOURCE = `
import { LiveClient, setLiveClient, useConnection, useLive } from '@ultimat3/realtime';
import { batch, createEffect, createMemo, createResource, createSignal, For, Match, on, Show, Switch, untrack } from 'solid-js';
import { Dynamic, Portal, render } from 'solid-js/web';
import { createStore, produce, reconcile } from 'solid-js/store';
import styles from './panel.module.scss';

export function mount(el: HTMLElement, props: { items?: string[] }): void {
  void LiveClient; void setLiveClient; void useConnection; void useLive;
  const [count, setCount] = createSignal(0);
  const [store, setStore] = createStore({ items: props.items ?? [] });
  const doubled = createMemo(() => count() * 2);
  createEffect(on(count, () => { el.dataset['n'] = String(doubled()); }));
  const [data] = createResource(async () => store.items.length);
  render(
    () => (
      <div class={styles['panel']}>
        <Show when={data() !== undefined} fallback={<span>…</span>}>
          <For each={store.items}>{(item) => <li>{item}</li>}</For>
        </Show>
        <Switch>
          <Match when={count() > 1}><Dynamic component="b">{doubled()}</Dynamic></Match>
        </Switch>
        <Portal><i>{untrack(() => count())}</i></Portal>
      </div>
    ),
    el,
  );
  batch(() => { setCount(1); setStore(produce((s) => { s.items = reconcile(s.items)(s.items); })); });
}
`;

beforeAll(async () => {
  await rm(ROOT, { recursive: true, force: true });
  await Bun.write(join(ROOT, 'package.json'), JSON.stringify({ name: 'determinism-fixture' }));
  await Bun.write(join(ROOT, 'apps/web/app/panel.module.scss'), '.panel{color:red}\n');
  await Bun.write(join(ROOT, ISLAND), SOURCE);
});

afterAll(async () => {
  await rm(ROOT, { recursive: true, force: true });
  // The island's `.module.scss` registers into render's process-global stylesheet registry, which
  // every other suite in this package reads through `stylesFor`.
  clearStylesheets();
});

const buildOnce = async (): Promise<{ url: string; code: string }> => {
  // The emitted-code cache is what keeps ONE process serving one byte string at one URL, so
  // clearing it is what puts the bundler's own determinism under test rather than the cache's.
  clearIslandChunkCache();
  const chunk = (await buildIslands(ROOT, { only: ISLAND })).chunks[0];
  if (chunk === undefined) expect.unreachable('the fixture island was not built');
  return { url: chunk.url, code: chunk.code };
};

describe('an island chunk URL', () => {
  test('does not move while its sources do not, across many builds', async () => {
    const urls = new Set<string>();
    for (let round = 0; round < ROUNDS; round += 1) {
      urls.add((await buildOnce()).url);
    }

    expect([...urls]).toHaveLength(1);
  }, 120_000);

  test('is not a hash of the emitted bytes, which is what made it flap', async () => {
    const { url, code } = await buildOnce();

    // The deterministic half of this file: under output-addressing the URL was exactly
    // `${moduleId}-${contentHash(code)}.js`, so this fails the moment anyone puts that back —
    // whether or not the bundler's race fires in that particular run.
    expect(url).not.toContain(contentHash(code));
    expect(url).toMatch(/^\/islands\/graph-[0-9a-f]{8}\.js$/);
  }, 60_000);

  test('a rebuild of unchanged sources serves the byte string the first one emitted', async () => {
    clearIslandChunkCache();
    const first = (await buildIslands(ROOT, { only: ISLAND })).chunks[0]?.code ?? '';
    const codes = new Set<string>();
    for (let round = 0; round < 8; round += 1) {
      // NOT cleared: this is the cache under test. `x dev` re-runs `buildIslands` on every watcher
      // tick, and without it a tick can mint different bytes behind a URL the browser is holding
      // under `max-age=31536000, immutable`.
      codes.add((await buildIslands(ROOT, { only: ISLAND })).chunks[0]?.code ?? '');
    }

    expect([...codes]).toEqual([first]);
  }, 60_000);

  test('a changed source moves the URL — the identity is the graph, not a constant', async () => {
    const before = (await buildOnce()).url;
    await Bun.write(join(ROOT, 'apps/web/app/panel.module.scss'), '.panel{color:green}\n');
    try {
      expect((await buildOnce()).url).not.toBe(before);
    } finally {
      await Bun.write(join(ROOT, 'apps/web/app/panel.module.scss'), '.panel{color:red}\n');
    }
  }, 60_000);
});
