// `targets()` answers from a set kept as `stale` moves; the walk it replaced is the oracle. A
// seeded random run of births, stale/fresh transitions, re-adds and drops must agree with the walk
// after every step, for every table.

import { describe, expect, test } from 'bun:test';
import { RingChangeBuffer } from './change-buffer';
import type { LiveQueryDefinition } from './live-contract';
import { LiveEntries } from './live-entries';
import { type QueryEntry, queryEntry } from './query-window';

const TABLES = ['posts', 'comments', 'likes'] as const;

const reading = (table: string): LiveQueryDefinition => ({
  name: `on_${table}`,
  entities: [table],
  snapshot: async () => ({ rows: [], lsn: '' }),
  visible: () => true,
  matcher: () => ({ entities: [table], match: () => ({ patches: [], refill: false }) }),
});

/** mulberry32: the same sequence every run, so a failure names its seed and replays. */
function rng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

/** The pre-index answer: every reader of `table`, plus every stale entry on the node. */
function walked(entries: LiveEntries, table: string): Set<QueryEntry> {
  const out = new Set(entries.readersOf(table));
  for (const entry of entries.values()) if (entry.stale) out.add(entry);
  return out;
}

function build(qid: string, table: string): QueryEntry {
  const definition = reading(table);
  return queryEntry(qid, definition, { qid }, definition.matcher({ qid }));
}

describe('LiveEntries.targets', () => {
  test.each([1, 7, 42, 2026, 9001])('equals the walked set over a random run (seed %d)', (seed) => {
    const random = rng(seed);
    const pick = <T>(items: readonly T[]): T | undefined =>
      items[Math.floor(random() * items.length)];
    const entries = new LiveEntries({ source: new RingChangeBuffer(), maxEntries: 1_000 });
    // Dropped entries stay writable: a fanout can still hold one, and its writes must not leak in.
    const everBuilt: QueryEntry[] = [];
    for (let step = 0; step < 600; step += 1) {
      const roll = random();
      const qid = `q${String(Math.floor(random() * 40))}`;
      const table = pick(TABLES) ?? 'posts';
      if (roll < 0.25) {
        const entry = build(qid, table);
        // A fresh entry may arrive already stale: `add` must count it without a transition.
        if (random() < 0.3) entry.stale = true;
        entries.add(entry);
        everBuilt.push(entry);
      } else if (roll < 0.3) {
        // A hand-written literal: no accessor reports it, the table has to read the field.
        const literal: QueryEntry = { ...build(qid, table) };
        entries.add(literal);
        everBuilt.push(literal);
      } else if (roll < 0.65) {
        const entry = pick(everBuilt);
        if (entry !== undefined) entry.stale = random() < 0.5;
      } else if (roll < 0.75) {
        const entry = pick([...entries.values()]);
        if (entry !== undefined) entries.add(entry);
      } else if (roll < 0.9) {
        entries.delete(qid);
      } else {
        entries.release(qid);
      }
      for (const asked of TABLES) {
        const answer = entries.targets(asked);
        expect(answer).toHaveLength(new Set(answer).size);
        expect(new Set(answer)).toEqual(walked(entries, asked));
      }
    }
  });

  test('an entry re-seated under its qid elsewhere stays reported by its new owner', () => {
    const first = new LiveEntries({ source: new RingChangeBuffer() });
    const second = new LiveEntries({ source: new RingChangeBuffer() });
    const entry = build('q1', 'posts');
    first.add(entry);
    second.add(entry);
    first.delete('q1');
    entry.stale = true;
    expect(second.targets('comments')).toEqual([entry]);
  });
});
