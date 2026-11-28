// Presence under the REAL Solid runtime: the bug was an ordering one — the enter started inside the
// effect that flipped `when`, before Solid had built the new wrapper, so a first open popped in and
// a later one animated the detached wrapper of the last exit. The browser build of solid-js is
// loaded by file (the bare specifier is the server build under `bun test`, where no effect runs);
// attaching the wrapper's `ref` is the one step a DOM renderer would take, done here by hand.

import { afterEach, beforeAll, describe, expect, test } from 'bun:test';
import { attachRef, byTag, nodesOf, one } from '@ultimat3/core/render-nodes';
import { clearSolidRuntime, setSolidRuntime } from '../theme/runtime-slot';
import { Presence } from './Presence';

type Solid = typeof import('solid-js');

async function browserSolid(): Promise<Solid> {
  const manifest = Bun.resolveSync('solid-js/package.json', import.meta.dir);
  return (await import(new URL('dist/solid.js', Bun.pathToFileURL(manifest)).href)) as Solid;
}

interface Played {
  readonly node: number;
  readonly fill: unknown;
  finish(): void;
}

function element(id: number, played: Played[]) {
  return {
    animate(_frames: unknown, options: { fill?: unknown }) {
      let finish = (): void => {};
      const finished = new Promise<void>((resolve) => {
        finish = resolve;
      });
      played.push({ node: id, fill: options.fill, finish: () => finish() });
      return { finished, cancel() {}, reverse() {} };
    },
  };
}

const settle = async (): Promise<void> => {
  for (let i = 0; i < 4; i += 1) await Promise.resolve();
};

describe('<Presence> under a real Solid runtime', () => {
  let solid: Solid;
  beforeAll(async () => {
    solid = await browserSolid();
  });
  afterEach(clearSolidRuntime);

  test('each open animates the wrapper just built, never before it exists, never an old one', async () => {
    const {
      createContext,
      useContext,
      createSignal,
      createMemo,
      createEffect,
      onCleanup,
      createRoot,
    } = solid;
    setSolidRuntime({
      createContext,
      useContext,
      createSignal,
      createMemo,
      createEffect,
      onCleanup,
      createRoot,
    });
    const played: Played[] = [];
    let dispose = (): void => {};
    const [when, setWhen] = createSignal(false);
    const out = createRoot((done) => {
      dispose = done;
      return Presence({
        get when() {
          return when();
        },
        children: 'panel',
      });
    });
    const wrapper = () => one(byTag(nodesOf(out), 'div'), 'the Presence wrapper');
    try {
      setWhen(true);
      expect(played).toEqual([]); // the effect ran; no wrapper yet, so nothing may play
      attachRef(wrapper(), element(1, played));
      expect(played.map((p) => [p.node, p.fill])).toEqual([[1, 'backwards']]);
      played[0]?.finish();
      await settle();

      setWhen(false);
      expect(played.map((p) => [p.node, p.fill])).toEqual([
        [1, 'backwards'],
        [1, 'both'],
      ]);
      played[1]?.finish();
      await settle();
      expect(byTag(nodesOf(out), 'div')).toEqual([]);

      setWhen(true);
      expect(played.length).toBe(2); // the detached wrapper 1 is never animated again
      attachRef(wrapper(), element(2, played));
      expect(played.map((p) => p.node)).toEqual([1, 1, 2]);
    } finally {
      dispose();
    }
  });
});
