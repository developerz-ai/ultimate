// The ratchet under `scripts/wiki-fences.ts`: how many fenced `ts`/`tsx` examples on each
// `wiki/` page do not typecheck today. A count may FALL and may never rise — a new example must
// compile from the day it is written, and the ones that do not get retired over time.
//
// Measured when this shipped (2026-10-06): 182 failing across 45 pages. Most are the
// fragments `scripts/readme-fences-backlog.ts` describes for package READMEs — an identifier the
// prose around the block defines, an app-level import (`@app/db`, `./entity`) that resolves in
// an app and not here, a signature with its arguments elided. A count per page, never a list of
// blocks, for that file's reason: a pin keyed on a line goes stale on every paragraph edit.
//
// why: the table is new in sweep 11 and opens with the wiki's whole measured debt at once — no
// wiki fence was ever compiled before it, so every count is a first measurement, not a raise.
//
// Shrink it with `bun run scripts/wiki-fences.ts --pin`, which lowers a count and refuses to
// raise one. Raising a count is a hand edit, on purpose, in a review.

export const WIKI_FENCE_BACKLOG: Readonly<Record<string, number>> = {
  Actions: 3,
  'Admin-Dashboard': 3,
  Agents: 7,
  Auth: 1,
  'Batching-And-Preloading': 4,
  'Building-Your-Own-Base': 1,
  'CLI-Reference': 1,
  'Caching-And-Invalidation': 3,
  'Client-Data': 4,
  'Client-Navigation': 3,
  Configuration: 11,
  Contributing: 1,
  'Entities-And-Migrations': 16,
  'Feature-Flags': 1,
  'Getting-Started': 4,
  'Jobs-And-Workflows': 9,
  'MCP-And-AI': 7,
  Mail: 2,
  'Migrating-An-Existing-App': 1,
  'Migrations-And-Backfills': 3,
  Money: 3,
  'N-Plus-One-Detection': 4,
  Notify: 1,
  Observability: 1,
  'PWA-And-Offline': 4,
  'Policies-And-Authz': 2,
  'Queries-And-Live-Queries': 3,
  Realtime: 3,
  'Resource-Management': 1,
  'Routes-And-Render-Modes': 7,
  SEO: 3,
  'Scheduled-Tasks': 3,
  Scraping: 7,
  'Static-Assets': 1,
  'Storage-And-Uploads': 2,
  Testing: 15,
  'The-Eight-Primitives': 7,
  'Timezones-And-Dates': 2,
  'Tutorial-01-First-App': 1,
  'Tutorial-02-First-Feature': 5,
  'Tutorial-03-Auth-And-Admin': 5,
  'Tutorial-04-Jobs-And-Realtime': 5,
  'Tutorial-06-Growing-Up': 2,
  'UI-Components': 1,
  Upgrading: 9,
};
