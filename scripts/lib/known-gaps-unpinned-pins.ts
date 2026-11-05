// The Open rows of `wiki/Known-Gaps.md` that had no pin when `known-gaps-pins.ts` landed, by first
// cell as written. A ratchet: an entry is deleted when its row is pinned or closed, and nothing is
// ever added — a new row arrives with its pin. Data, not a rule: `guards-doc` reads no codes here.
//
// why: each row is a gap the reference already admitted in prose before any gap carried a pin, so
// the table is born at its whole debt and only shrinks from here.

export const UNPINNED_FILE = 'scripts/lib/known-gaps-unpinned-pins.ts';

/** `As of 2026-11-03`: the Open rows still unpinned, after the first ten were pinned or marked `pin: none`. */
export const KNOWN_GAPS_UNPINNED: readonly string[] = [
  'A purge that a replica never hears is bounded by `ttl`, not by the next request',
  'A queued offline write is not bound to its principal **on the server**',
  'Presence leaves past the lease roster cap',
  'An **offline** scrape reads `/robots.txt` over the real network',
  'The cache fill fence crosses nodes for **tag busts through Redis only**',
  'A replicated table with **no** replica identity is warned about, never refused',
  'A `stream` page with a realtime island keeps every island on the page inert until its slowest hole closes',
  "A job's `runAt` is stamped from the enqueuer's clock",
  '`onSettled` runs at most once across a crash',
  "The CDP driver's `allowHosts` judges NAMES, and a page's WebSocket is not screened at all",
  '`ScrapeReport.usage.bytesIn` counts the HTTP leg only',
  'Retry-from-step on the jobs dashboard is a free-text field',
  'The admin MCP batch tool takes `ids` only',
  "No counts on the jobs dashboard's state tabs",
];
