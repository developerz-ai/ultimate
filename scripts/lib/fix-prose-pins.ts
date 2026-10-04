// The ratchet under `scripts/fix-prose.ts`: how many `fix:` lines in each package's shipped source
// open with prose rather than a command or a code shape. The number may FALL and may never rise.
// Data only — the rule owns what it does with these.
//
// why: measured 2026-10-03 on the rule's first run (plan 101 slice 13): 987 of the fix lines the
// `errors` step reads. Most are "edit <file> — add …" sentences written before the rule existed;
// each one rewritten to open with the command or the code to paste lowers its package's row.
//
// Shrink it with `bun run scripts/fix-prose.ts --unpin <pkg>[,<pkg>]`, which lowers a count to what
// is measured and refuses to raise one. Raising a count is a hand edit, in a review, with a why:.

/** Where the table lives, so a stale-pin finding can name the file to edit. */
export const FIX_PROSE_PINS_FILE = 'scripts/lib/fix-prose-pins.ts';

export const FIX_PROSE_PINS: Readonly<Record<string, number>> = {
  action: 28,
  admin: 31,
  ai: 24,
  auth: 47,
  cache: 11,
  cli: 84,
  core: 52,
  db: 32,
  entity: 49,
  flags: 7,
  http: 26,
  jobs: 37,
  mail: 41,
  manifest: 6,
  mcp: 34,
  money: 10,
  notify: 5,
  policy: 6,
  pwa: 11,
  query: 16,
  realtime: 46,
  render: 48,
  schema: 7,
  scraping: 54,
  scripts: 173,
  seo: 13,
  storage: 33,
  testing: 28,
  time: 8,
  ui: 13,
};
