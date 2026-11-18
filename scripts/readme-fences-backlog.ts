// The ratchet under `scripts/readme-fences.ts`: every fenced `ts`/`tsx` example in a package's
// `README.md` that does not typecheck today, keyed by FENCE — `<package>: <its first code line>` —
// with how many fences of that package open with that line. A row may FALL and may never rise — a
// new example must compile from the day it is written, and the ones that do not get retired over
// time.
//
// Measured when this shipped: 170 fenced examples across 27 packages, 155 of them failing. Most are
// illustrative fragments — an identifier the surrounding prose defines, an app-level import that
// resolves in an app and not here, a signature shown with its arguments elided. Turning those into
// compiling programs is fixture engineering, not a formatting pass, so the honest artifact is a
// rule with a recorded edge rather than a rule switched off. Compiling a package's blocks TOGETHER
// was measured too, on the theory that block 4 uses what block 1 declared: 156 rather than 158,
// because an unparseable block has to leave the fixture and takes its declarations with it. Two
// designs, one answer — there is no cheap fixture that rescues these, only writing them out.
//
// Keyed on the fence's FIRST CODE LINE, never its README line or a content hash: the prose around
// an example is rewritten constantly and neither of those survives a paragraph edit, while the
// example's own opening line moves only when the example does. A per-package count — this table
// until plan 101 sweep 11c — let one fixed example be swapped for a new broken one unseen.
//
// why: re-keyed per fence in plan 101 sweep 11c — 138 failing fences, the same 138 the per-package
// counts held, at 138 sites; `pin-raises` reads a wholly re-keyed table against its old total.
//
// Every row carries a `// why:`: the fence cannot compile as written, being a fragment by design or
// importing the app's own files. A row without one is `X_FINISHED_PIN_UNREASONED`.
//
// Shrink it with `bun run scripts/readme-fences.ts --pin`, which lowers a row and refuses to
// raise one. Adding or raising a row is a hand edit, on purpose, in a review.

export const README_FENCE_BACKLOG: Readonly<Record<string, number>> = {
  // why: a function body shown alone: its top-level `return` does not parse
  'action: const key = req.header(IDEMPOTENCY_HEADER);': 1,
  // why: imports `../app/posts/actions`, `../app/posts/live`, `../app/posts/mutator`: the
  // app's own files, which a one-file fixture cannot resolve
  "action: import { defineApi } from '@ultimat3/action';": 1,
  // why: imports `../api`: the app's own files, which a one-file fixture cannot resolve
  "action: import { rpc } from '@ultimat3/action';": 1,
  // why: imports `./prompts`: the app's own files, which a one-file fixture cannot resolve
  'ai: // app/support/summarize.evals.ts — the declaration the gate reads': 1,
  // why: a function body shown alone: its top-level `return` does not parse
  "db: return expectedQueryLoop('one indexed lookup per text field beats one unindexed OR', async () => {": 1,
  // why: a function body shown alone: its top-level `return` does not parse
  "db: return withStatementAttribution('members', 'findById', () =>": 1,
  // why: object members shown without their call, opening `targeting:`; they do not parse
  // alone
  'flags: // whole tenants, named — the 90% case, which is why it has a shorthand': 1,
  // why: imports `../catalogs/en.json`, `../catalogs/es.json`: the app's own files, which a
  // one-file fixture cannot resolve
  "i18n: // the app's own packages/i18n/src/index.ts — its whole i18n module": 1,
  // why: imports `@postly/db`: the app's own files, which a one-file fixture cannot resolve
  "jobs: import { backfill } from '@ultimat3/jobs';": 1,
  // why: object members shown without their call, opening `run:`; they do not parse alone
  'jobs: run: async ({ input, ctx, step }) => {': 1,
  // why: object members shown without their call, opening `tenant:`; their types come from
  // that call
  'jobs: tenant: (input) => input.orgId   // the run acts under this org': 1,
  // why: imports `../api/posts`: the app's own files, which a one-file fixture cannot resolve
  "mcp: import { publishPost } from '../api/posts';": 1,
  // why: object members shown without their call, opening `deprecated:`; they do not parse
  // alone
  "query: deprecated: { since: '2026-08-01T00:00:00Z', sunset: '2026-12-31T23:59:59Z', replacedBy: 'searchOrders' },": 1,
  // why: imports `../api`: the app's own files, which a one-file fixture cannot resolve
  "query: import { queryClient } from '@ultimat3/query';": 1,
  // why: object members shown without their call, opening `rateLimit:`; they do not parse
  // alone
  'query: rateLimit: { limit: 3, windowMs: 600_000 },   // 3 held, one back every three and a bit minutes': 1,
  // why: imports `./ark`: the app's own files, which a one-file fixture cannot resolve
  "schema: import { configureSchemaProvider } from '@ultimat3/schema';": 1,
  // why: elides code with `…`, which does not parse
  "ui: <Accordion level={3} exclusive items={[{ id: 'ship', title: t('faq.ship'), panel: <p>…</p> }]} />": 1,
  // why: several JSX elements listed side by side, not one expression
  "ui: import { Button, Field, Input } from '@ultimat3/ui';": 1,
  // why: several JSX elements listed side by side, not one expression
  "ui: import { Icon } from '@ultimat3/ui';": 1,
};

/** How many fences at this site may fail today. Absent means zero: a new example compiles or
 * its first `x verify` says so. */
export const pinnedFor = (
  site: string,
  backlog: Readonly<Record<string, number>> = README_FENCE_BACKLOG,
): number => (Object.hasOwn(backlog, site) ? (backlog[site] ?? 0) : 0);
