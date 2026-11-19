// WHERE the interaction runtime replays the event it caught — the one thing `hydrate-runtime.test.ts`
// cannot see, because its element is both the island root and the event's target, so "dispatch at
// `ev.target`" and "dispatch at the island" are the same node there. Every island whose `mount`
// clears the wrapper detaches that target, and the click that woke the island went to a node no
// longer in the document: "the button does nothing on the first press, and works on the second".

import { describe, expect, test } from 'bun:test';
import { bootReplayRuntime, REPLAY_EVENTS, settle } from './hydrate-replay-fixture';

describe('the interaction replay aims at a node the mount left standing', () => {
  test('a mount that takes the shell OVER replays onto the very node that was pressed', async () => {
    // `contact-sales.island.tsx` queries the server's form and attaches to it rather than replacing
    // it, so the pressed node is still the right one and has to stay the answer.
    const harness = await bootReplayRuntime(false);
    try {
      harness.fire('click', { clientX: 12, clientY: 34 });
      await settle();
      expect(harness.shell.delivered).toEqual([]);

      harness.finishMount();
      await settle();

      expect(harness.shell.delivered).toEqual(['click']);
      expect(harness.root.delivered).toEqual([]);
    } finally {
      await harness.dispose();
    }
  });

  test('a mount that REPLACES the shell replays onto what now sits under the pointer', async () => {
    // The defect: `ev.target` is the server's button, detached by `el.textContent = ''`, so the
    // click that woke the island was dispatched into nothing and the user pressed twice.
    const harness = await bootReplayRuntime(true);
    harness.hits.set('12,34', harness.mounted);
    try {
      harness.fire('click', { clientX: 12, clientY: 34 });
      await settle();

      harness.finishMount();
      await settle();

      expect(harness.mounted.delivered).toEqual(['click']);
      // The detached node is not merely a worse target, it is nobody's: a replay it receives is a
      // replay the mounted control did not.
      expect(harness.shell.delivered).toEqual([]);
    } finally {
      await harness.dispose();
    }
  });

  test('an event with no coordinates lands on the control the mount put where it was', async () => {
    // A `keydown` has no `clientX`, so there is no point to hit-test. The path to the pressed node
    // was taken when the event was caught, and the mount rendered the same element at the same
    // place: that is the control the visitor was on. The island ROOT reaches no handler on it —
    // Solid delegates from `document` and walks UP from the target.
    const harness = await bootReplayRuntime(true);
    try {
      harness.fire('keydown');
      await settle();

      harness.finishMount();
      await settle();

      expect(harness.mounted.delivered).toEqual(['keydown']);
      expect(harness.root.delivered).toEqual([]);
      expect(harness.shell.delivered).toEqual([]);
    } finally {
      await harness.dispose();
    }
  });

  test('a scripted or keyboard click at (0, 0) is not hit-tested — it names no point', async () => {
    // `button.click()` and Enter on a focused button both fire `click` with `detail: 0` and
    // `clientX: 0`. Hit-testing the page's top-left corner found nothing in the island, the replay
    // went to the root, and the press was lost — the dummy's e2e suite presses exactly this way.
    const harness = await bootReplayRuntime(true);
    // A full-bleed island covers the corner: a hit test there answers the island's own wrapper,
    // which is inside it and reaches no handler of the control.
    harness.hits.set('0,0', harness.root);
    try {
      harness.fire('click', { clientX: 0, clientY: 0, detail: 0 });
      await settle();

      harness.finishMount();
      await settle();

      expect(harness.mounted.delivered).toEqual(['click']);
      expect(harness.root.delivered).toEqual([]);
    } finally {
      await harness.dispose();
    }
  });

  test('a mount that rendered a DIFFERENT element there falls back to the root', async () => {
    // The path found an `<a>` where a `<button>` was pressed: not the same control, and
    // synthesizing an event on an element the visitor never touched is worse than losing it.
    const harness = await bootReplayRuntime(true, 'interaction', 'a');
    try {
      harness.fire('keydown');
      await settle();

      harness.finishMount();
      await settle();

      expect(harness.mounted.delivered).toEqual([]);
      expect(harness.root.delivered).toEqual(['keydown']);
    } finally {
      await harness.dispose();
    }
  });

  test('a hit test landing OUTSIDE the island never reaches the stranger', async () => {
    // The island may have mounted something smaller, or a sticky header may now cover the point.
    // Synthesizing a click on an element the visitor never pressed is worse than losing the replay;
    // the structural answer — the same control at the same place — is still the island's own.
    const harness = await bootReplayRuntime(true);
    harness.hits.set('12,34', harness.outsider);
    try {
      harness.fire('click', { clientX: 12, clientY: 34 });
      await settle();

      harness.finishMount();
      await settle();

      expect(harness.outsider.delivered).toEqual([]);
      expect(harness.mounted.delivered).toEqual(['click']);
    } finally {
      await harness.dispose();
    }
  });

  test('outside the island AND a different element there: the root, never the stranger', async () => {
    const harness = await bootReplayRuntime(true, 'interaction', 'a');
    harness.hits.set('12,34', harness.outsider);
    try {
      harness.fire('click', { clientX: 12, clientY: 34 });
      await settle();

      harness.finishMount();
      await settle();

      expect(harness.outsider.delivered).toEqual([]);
      expect(harness.root.delivered).toEqual(['click']);
    } finally {
      await harness.dispose();
    }
  });

  test('a pointer event at the origin is still hit-tested — 0 is a coordinate', async () => {
    // `ev.clientX || ev.clientY` reads (0, 0) as "no coordinates" and sends a real click to the
    // root. The top-left corner is where a full-bleed island's first pixel is.
    const harness = await bootReplayRuntime(true);
    harness.hits.set('0,0', harness.mounted);
    try {
      harness.fire('click', { clientX: 0, clientY: 0 });
      await settle();

      harness.finishMount();
      await settle();

      expect(harness.mounted.delivered).toEqual(['click']);
      expect(harness.root.delivered).toEqual([]);
    } finally {
      await harness.dispose();
    }
  });
});

// `idle` hydrates on the browser's schedule, not the visitor's, so the server-rendered button is
// pressable for as long as the idle callback and the chunk take — up to IDLE_HYDRATE_TIMEOUT_MS
// plus a download. A click in that window reached a node with no handler and vanished: every app's
// first press could do nothing. The same capture-and-replay `interaction` runs covers it.
describe('an idle island replays what the visitor did before it mounted', () => {
  test('a click BEFORE the idle callback runs is replayed once the island mounts', async () => {
    const harness = await bootReplayRuntime(true, 'idle');
    harness.hits.set('12,34', harness.mounted);
    try {
      harness.fire('click', { clientX: 12, clientY: 34 });
      await settle();
      // Nothing is replayed into a chunk still loading.
      expect(harness.mounted.delivered).toEqual([]);

      harness.goIdle();
      harness.finishMount();
      await settle();

      expect(harness.mounted.delivered).toEqual(['click']);
      expect(harness.shell.delivered).toEqual([]);
      expect(harness.root.listening()).toEqual([]);
    } finally {
      await harness.dispose();
    }
  });

  test('a press wakes an idle island without waiting for the browser to go idle', async () => {
    // The visitor has already said they want it; waiting out IDLE_HYDRATE_TIMEOUT_MS on a busy
    // main thread would turn a replayed click into a two-second one.
    const harness = await bootReplayRuntime(false, 'idle');
    try {
      harness.fire('click', { clientX: 12, clientY: 34 });
      harness.finishMount();
      await settle();

      expect(harness.shell.delivered).toEqual(['click']);
      // The idle callback arriving afterwards finds nothing left to replay.
      harness.goIdle();
      await settle();
      expect(harness.shell.delivered).toEqual(['click']);
    } finally {
      await harness.dispose();
    }
  });

  test('a click while the chunk is still loading is replayed after mount, not before', async () => {
    const harness = await bootReplayRuntime(false, 'idle');
    try {
      harness.goIdle();
      harness.fire('click', { clientX: 12, clientY: 34 });
      await settle();
      expect(harness.shell.delivered).toEqual([]);

      harness.finishMount();
      await settle();

      expect(harness.shell.delivered).toEqual(['click']);
    } finally {
      await harness.dispose();
    }
  });

  test('an idle island nobody touched lets go of its listeners once mounted', async () => {
    // A listener left attached would re-dispatch every later click a second time.
    const harness = await bootReplayRuntime(false, 'idle');
    try {
      expect(harness.root.listening()).toEqual([...REPLAY_EVENTS]);
      harness.goIdle();
      harness.finishMount();
      await settle();

      expect(harness.root.listening()).toEqual([]);
      harness.fire('click', { clientX: 1, clientY: 1 });
      await settle();
      expect(harness.shell.delivered).toEqual([]);
    } finally {
      await harness.dispose();
    }
  });
});
