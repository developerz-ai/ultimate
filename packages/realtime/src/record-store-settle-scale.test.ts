// A settle over a write that touched many rows, the answer carrying half of them. Splitting the
// touched rows into answered and still-awaited scanned the missing ARRAY once per touched row —
// O(t²) membership work on one settle. Measured as elements scanned, never as time.

import { afterEach, expect, spyOn, test } from 'bun:test';
import { RecordStore, recordKey } from './record-store';

const ROWS = 2_000;

let restore = (): void => undefined;
afterEach(() => restore());

test('settling a wide write scans no list once per row', () => {
  const s = new RecordStore({ schedule: () => () => undefined });
  const rows = Object.fromEntries(
    Array.from({ length: ROWS }, (_, at) => [`p${at}`, { id: `p${at}`, seen: false }]),
  );
  s.adopt('posts', rows);
  s.push(
    'mark:all',
    (tx) => {
      for (let at = 0; at < ROWS; at += 1) tx['posts']?.update(`p${at}`, { seen: true });
    },
    'server-wins',
  );
  const carried = new Set(
    Array.from({ length: ROWS / 2 }, (_, at) => recordKey('posts', `p${at * 2}`)),
  );

  // Every element an `Array#includes` walks, summed: the work a linear scan hides from a count of
  // calls. `this` is the array being searched.
  let scanned = 0;
  const original = Array.prototype.includes;
  const spy = spyOn(Array.prototype, 'includes').mockImplementation(function (
    this: unknown[],
    ...args: Parameters<typeof original>
  ) {
    scanned += this.length;
    return original.apply(this, args);
  });
  restore = () => spy.mockRestore();
  s.settle('mark:all', carried);
  spy.mockRestore();

  // The half the answer carried is settled; the other half still waits on the server.
  expect(s.pending()).toEqual(['mark:all']);
  // Quadratic was ROWS × ROWS/2 = 2,000,000; linear work needs no array scan at all.
  expect(scanned).toBeLessThan(ROWS);
});
