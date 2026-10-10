// What the bootstrap of a realtime island that READS the store or the outbox awaits before `mount`
// (#506, owner option 3; one that only follows a channel never imports this): the page boot's disk
// restore AND the outbox it opened, so the first render already carries the overlays a reload
// rebuilds from the queue. Capped, because an IndexedDB that hangs must cost the hold, never the island.

import { peekOutbox } from './outbox-slot';
import { pageRealtime } from './page-store';

/**
 * The longest a realtime island waits on the restore before it mounts anyway. A warm IndexedDB
 * opens in tens of milliseconds; a second is a disk that is not answering, and past it the island
 * paints what it has. Below `@ultimat3/render`'s `ISLAND_HOLD_MS`, which reveals the server's
 * markup regardless — so this cap, not that one, is the one a slow disk meets.
 */
export const FIRST_PAINT_HOLD_MS = 1_000;

/** `settled` — the restore finished (or was refused; there is nothing more to wait for). */
export type FirstPaintHold = 'settled' | 'capped';

/**
 * Resolves once the page's records are back AND its outbox is open — what `useMutation` rebuilds a
 * queued write's overlay from, synchronously from then on — or at the cap. Never rejects: a hold
 * that threw would take the island's module graph, and with it the island, down with the disk.
 * A page with no boot resolves at once (`booted` does, and no outbox is seated). No options: the
 * cap is the constant, and an option would ship its finite-number screen (~550 B) in every
 * realtime island to serve tests that can stub the timer instead.
 */
export async function holdFirstPaint(): Promise<FirstPaintHold> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const capped = new Promise<FirstPaintHold>((resolve) => {
    timer = setTimeout(() => resolve('capped'), FIRST_PAINT_HOLD_MS);
  });
  try {
    return await Promise.race([restored(), capped]);
  } finally {
    clearTimeout(timer);
  }
}

async function restored(): Promise<FirstPaintHold> {
  try {
    await pageRealtime().booted;
    // Read after the boot, never before: the boot seats the outbox as its last step.
    await peekOutbox()?.ready;
  } catch {
    // The boot already reported what the disk refused (`boot.ts`); the hold only stops waiting.
  }
  return 'settled';
}
