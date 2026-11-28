/**
 * How a feed row arrives: a row that scrolls into view fades up, and the rows that scroll in
 * together (the first screenful, a pull) start one beat apart instead of all at once. `inView`
 * decides WHEN, `stagger` decides the order; both read the motion tokens, so a stilled page
 * (reduced motion, the reader's pause) shows every row at rest.
 */

import { inView, PRESENCE_ENTER, stagger } from '@ultimat3/ui/motion';

/** The rows that entered this tick, flushed together so one `stagger` spreads them. */
let batch: Element[] = [];

const flush = (): void => {
  const rows = batch;
  batch = [];
  stagger(rows, PRESENCE_ENTER, { each: 'fast', duration: 'base', easing: 'gentle' });
};

/** Hand a rendered row to the reveal; returns nothing to clean up — a removed row just stops. */
export function revealRow(row: Element): void {
  inView(row, () => {
    if (batch.length === 0) queueMicrotask(flush);
    batch.push(row);
    return undefined;
  });
}
