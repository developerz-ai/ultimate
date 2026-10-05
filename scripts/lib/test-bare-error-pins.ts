// The ratchet under `scripts/test-bare-error.ts`: how many of each package's own TESTS report their
// verdict by throwing a bare `Error`. The number may FALL and may never rise. Data only — the gate
// owns what it does with these.
//
// Measured 2026-08-20: 266 across 24 packages, under a green gate. `CLAUDE.md` has always said
// never throw a bare `Error`, and `checkErrorFixes` opens with `if (isTest(path)) continue`, so in
// test files the rule was prose — which axiom 3 says is no rule at all. #132 counted 295 `new
// Error(` sites; the total is now 422, and that growth is the argument for a rule over a sweep.
//
// WHAT IS COUNTED, and it is not every `new Error`. Only `throw new Error(…)` — the test stating
// its own verdict. A `new Error` that is NOT thrown is the subject's INPUT and is not reported at
// all: `Promise.reject(new Error('redis is down'))`, `render(new Error('the driver went away'))`,
// `Object.assign(new Error('denied'), { code, cause, fix })`. That is 159 sites here, and
// `packages/realtime/CLAUDE.md` already blesses the shape — "the rule governs what this package
// throws, never what a test hands it". Rebuilding those would change what the tests prove.
//
// THE HONEST LIMIT: a stub that throws AT the subject — `{ get: () => { throw new Error('boom') } }`
// — is also an input, and it is counted here because text cannot tell it from a verdict. So a pin
// will not always reach zero, and a package should stop lowering when what is left is stubs. That
// is a smaller and more honest residue than 422 unguarded sites.
//
// The replacement for a verdict is `expect.unreachable('<what was expected>')`, this repo's own
// idiom (10+ uses in `packages/realtime/src/`): it reports at the assertion with the value that
// actually arrived, and its `never` return narrows the variable so the cast under it goes away.
//
// Shrink it with `bun run scripts/test-bare-error.ts --unpin <pkg>[,<pkg>]`, which lowers a count
// to what is measured and refuses to raise one. Raising a count is a hand edit, in a review.

// why: RAISED 2026-10-05 (plan 101 sweep 6, K19). The rule read only `Error`; it now reads every
// builtin class — `TypeError`, `RangeError`, `SyntaxError`, `ReferenceError`, `EvalError`,
// `URIError`, `AggregateError` — because a bare one of any of them carries no code, cause or fix.
// The new sites were spot-checked in cli, http, realtime, core, jobs and mcp: what remained after
// six verdicts became `expect.unreachable` are stubs throwing AT the subject — `fetch`'s
// `TypeError('Failed to fetch')`, Proxy traps, a handler that blows up — the honest limit above.
// Each raised row says so on its own line, which is what `bun run pin-raises` reads.

/** Where the table lives, so a stale-pin finding can name the file to edit. */
export const PINS_FILE = 'scripts/lib/test-bare-error-pins.ts';

export const BARE_ERROR_PINS: Readonly<Record<string, number>> = {
  action: 9, // why: 0 -> 9, the K19 class list; the new sites are stubs (input)
  admin: 10, // why: 7 -> 10, the K19 class list; the new sites are stubs (input)
  ai: 18,
  auth: 11, // why: 4 -> 11, the K19 class list; the new sites are stubs (input)
  cache: 6, // why: 3 -> 6, the K19 class list; the new sites are stubs (input)
  cli: 29, // why: 9 -> 29, the K19 class list; the new sites are stubs (input)
  core: 43, // why: 30 -> 43, the K19 class list; the new sites are stubs (input)
  db: 34, // why: 24 -> 34, the K19 class list; the new sites are stubs (input)
  entity: 25, // why: 17 -> 25, the K19 class list; the new sites are stubs (input)
  flags: 1,
  http: 32, // why: 11 -> 32, the K19 class list; the new sites are stubs (input)
  jobs: 33, // why: 23 -> 33, the K19 class list; the new sites are stubs (input)
  mail: 5, // why: 0 -> 5, the K19 class list; the new sites are stubs (input)
  mcp: 11, // why: 6 -> 11, the K19 class list; the new sites are stubs (input)
  notify: 1, // why: 0 -> 1, the K19 class list; the new sites are stubs (input)
  policy: 1, // why: 0 -> 1, the K19 class list; the new sites are stubs (input)
  pwa: 4, // why: 0 -> 4, the K19 class list; the new sites are stubs (input)
  query: 12, // why: 11 -> 12, the K19 class list; the new sites are stubs (input)
  realtime: 50, // why: 25 -> 50, the K19 class list; the new sites are stubs (input)
  render: 15, // why: 6 -> 15, the K19 class list; the new sites are stubs (input)
  schema: 1, // why: 0 -> 1, the K19 class list; the new sites are stubs (input)
  scraping: 1,
  scripts: 1, // why: 0 -> 1, the K19 class list; the new sites are stubs (input)
  seo: 8,
  testing: 24, // why: 19 -> 24, the K19 class list; the new sites are stubs (input)
  time: 1,
  ui: 11, // why: 6 -> 11, the K19 class list; the new sites are stubs (input)
};
