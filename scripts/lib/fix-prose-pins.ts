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
  // why: plan 101b sweep 8b-4 (917 → 55) — X_AI_PROMPT_SECRET's honest fix removes a variable (a
  // paste of revealSecret would make the leak the default); X_HIVE_EMPTY's two remedies are at a
  // call site the thrower cannot see
  ai: 2,
  // why: plan 101b sweep 8b-4 (917 → 55) — a forged token and a re-signing proxy have no safe
  // paste (trusting the claimed issuer trusts the attacker); azp is set in the identity provider
  // console
  auth: 3,
  // why: plan 101b sweep 8b-4 (917 → 55) — two Dockerfile edits (no line known, no extension);
  // two generator bugs whose template the thrower cannot locate; "split this file" is judgement
  cli: 5,
  // why: plan 101b sweep 8b-4 (917 → 55) — assert.ts's caller switch, toInternalError's default
  // for any thrown value, an image asset to shrink outside code, an env name no shell can assign,
  // a broken framework publish
  core: 6,
  // why: plan 101b sweep 8b-4 (917 → 55) — unrendered.ts: a framework bug in entity/describe.ts,
  // and an edit fix may not hard-code a line
  db: 1,
  // why: plan 101b sweep 8b-4 (917 → 55) — X_DRAINING: the caller can only wait and retry;
  // deleting a config key has no code shape
  http: 2,
  // why: plan 101b sweep 8b-4 (917 → 55) — webhook-errors.ts: how an app names its own event ids
  // is the app's convention
  jobs: 1,
  // why: plan 101b sweep 8b-4 (917 → 55) — the SMTP server's reply names the remedy; an accepted
  // message has nothing to run; the remote server's log is somewhere the framework cannot know
  mail: 3,
  // why: plan 101b sweep 8b-4 (917 → 55) — AGENTS.md is hand-written by design; which facts count
  // as generated is judgement; two manifest positions the thrower cannot map to a declaration
  manifest: 4,
  // why: plan 101b sweep 8b-4 (917 → 55) — X_MCP_TOOL_DUPLICATE: a rename at one of two sites of
  // three kinds, the author picks; X_MCP_LIST_PARAMS_INVALID: the field type is unknown, so a
  // shape would be a guess
  mcp: 3,
  // why: plan 101b sweep 8b-4 (917 → 55) — two browser-side cases with nothing to paste (the
  // queue's own retry, a browser setting); an entity rename; a schema change through a migration;
  // an internal stream misuse
  realtime: 5,
  // why: plan 101b sweep 8b-4 (917 → 55) — a Sass failure with no line; the app's own prerender()
  // and load() threw; a self-rendering component the walker cannot locate
  render: 4,
  // why: plan 101b sweep 8b-4 (917 → 55) — X_VALIDATION_FAILED: the reader is the API caller
  // correcting its own data
  schema: 1,
  // why: plan 101b sweep 8b-4 (917 → 55) — the app's own resolver, two extract-vs-page judgements
  // over an artifact no command opens, recover() widening, and a credential only the site can
  // judge
  scraping: 5,
  // why: plan 101b sweep 8b-4 (917 → 55) — error-code-page-edit.ts: a page with no code table;
  // the original new-error-code command cannot be rebuilt
  scripts: 1,
  // why: plan 101b sweep 8b-4 (917 → 55) — an image URL's query value (?q=75, ?f=webp, ?w=640),
  // which no shape reads as code
  seo: 3,
  // why: plan 101b sweep 8b-4 (917 → 55) — improving an eval prompt is judgement (a threshold:
  // opener invites gaming it); a nested props value only the app can choose
  testing: 2,
  // why: plan 101b sweep 8b-4 (917 → 55) — X_SCHEDULE_INVALID's general branch: callers pass
  // different fields and ranges, so no one call is honest
  time: 1,
  // why: plan 101b sweep 8b-4 (917 → 55) — a colour role chosen from the cause, one factory
  // behind ~20 call shapes, and a control name that is the author's choice
  ui: 3,
};
