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
  // why: 9 input(s), never a verdict (plan 101b sweep 8b-3) — each throw is a stub raising a
  // foreign failure at the subject (a dead audit sink, hostile proxy traps, a driver TypeError, an
  // outer transaction's RangeError, a hostile issue getter) to prove it is reported, never
  // swallowed.
  action: 9,
  // why: 5 input(s), never a verdict (plan 101b sweep 8b-3) — action handlers throwing a
  // RangeError, Error or bare string at the action gate, and value getters throwing a TypeError at
  // the dev panel's renderer.
  admin: 5,
  // why: 14 input(s), never a verdict (plan 101b sweep 8b-3) — provider stubs throwing rate-limit
  // or bad-request errors (and never-used stream stubs), hostile Proxy/getter/toJSON values for the
  // error renderers, and tool or onTurn handlers throwing at the agent loop and hive.
  ai: 14,
  // why: 9 input(s), never a verdict (plan 101b sweep 8b-3) — fetch stubs throwing the TypeErrors a
  // failed network or timeout produces, a KDF job that throws, and a Proxy whose getPrototypeOf
  // refuses classification.
  auth: 9,
  // why: 5 input(s), never a verdict (plan 101b sweep 8b-3) — a single-flight loader or tier
  // throwing synchronously, and Proxy traps in invalidation and purge inputs.
  cache: 5,
  // why: 24 input(s), never a verdict (plan 101b sweep 8b-3) — a step, seed, route, renderer,
  // listener, reload or teardown failing with an uncoded error, or a hostile value (a throwing
  // message/code getter or Proxy trap) the renderers and guards must survive.
  cli: 24,
  // why: 42 input(s), never a verdict (plan 101b sweep 8b-3) — hostile values (a throwing
  // toJSON/toString/getter or Proxy trap) fed to the error and log renderers, plus stubs for a
  // failing fetch, log sink, monitor, clock, pool, telemetry provider or lifecycle hook.
  core: 42,
  // why: 28 input(s), never a verdict (plan 101b sweep 8b-3) — the caller's transaction or loop
  // body failing on purpose, plus fake drivers raising Postgres or socket failures (connection
  // reset, EACCES, module not found, invalid URL) and hostile Proxy reads.
  db: 28,
  // why: 18 input(s), never a verdict (plan 101b sweep 8b-3) — a unit of work throwing to force a
  // rollback, fake drivers raising a duplicate key or a send failure, and hostile objects refusing
  // reads or prototype lookups.
  entity: 18,
  // why: 1 input(s), never a verdict (plan 101b sweep 8b-3) — an error monitor that is down.
  flags: 1,
  // why: 26 input(s), never a verdict (plan 101b sweep 8b-3) — each throw is a route handler, hook
  // (onError, errorPage, devNotices), getter or proxy trap raising a non-framework error, to prove
  // the pipeline degrades to a problem document, never rejects and never leaks the message.
  http: 26,
  // why: 15 input(s), never a verdict (plan 101b sweep 8b-3) — a job body, step, key derivation,
  // checkpoint store, renewal, task callback or app context throwing a foreign Error/TypeError, to
  // drive retry, dead-letter, refusal and step failure.
  jobs: 15,
  // why: 5 input(s), never a verdict (plan 101b sweep 8b-3) — a Resend fetch failing at DNS, and
  // mail transforms that throw (throwing getters and Proxy traps included).
  mail: 5,
  // why: 11 input(s), never a verdict (plan 101b sweep 8b-3) — visibility, surface and instructions
  // callbacks that throw, Proxy and getter traps, an unserialisable toJSON, and dev-host fixture
  // drivers refusing the methods they don't cover.
  mcp: 11,
  // why: 1 input(s), never a verdict (plan 101b sweep 8b-3) — a provider rejection whose toString
  // throws.
  notify: 1,
  // why: 4 input(s), never a verdict (plan 101b sweep 8b-3) — network fetch rejections and
  // showNotification throwing the WebIDL TypeError.
  pwa: 4,
  // why: 11 input(s), never a verdict (plan 101b sweep 8b-3) — each throw is a refusing cache tier,
  // a failing read run or an sql builder's TypeError, to prove a tier failure degrades the cache
  // and not the read, and a rejected read is never memoized.
  query: 11,
  // why: 34 input(s), never a verdict (plan 101b sweep 8b-3) — each throw stands in for a foreign
  // failure (socket, network, fetch, bus, walsender close, token service, subscriber, handler, lane
  // task, hostile toString) to prove the node, client or lane isolates, retries or classifies it as
  // a failure rather than a denial.
  realtime: 34,
  // why: 11 input(s), never a verdict (plan 101b sweep 8b-3) — components, loaders and meta
  // throwing at the renderer, throwing message/toString getters, and browser APIs that throw
  // (FormData, adoptNode).
  render: 11,
  // why: 1 input(s), never a verdict (plan 101b sweep 8b-3) — a hostile value whose read throws
  // TypeError.
  schema: 1,
  // why: 1 input(s), never a verdict (plan 101b sweep 8b-3) — a fake storage driver refusing the
  // methods it doesn't implement.
  scraping: 1,
  // why: 1 input(s), never a verdict (plan 101b sweep 8b-3) — verify.test.ts's Proxy whose
  // getPrototypeOf trap throws, to prove the renderer survives a hostile value.
  scripts: 1,
  // why: 15 input(s), never a verdict (plan 101b sweep 8b-3) — a fixture teardown, app boot or
  // close, seed, clone drop, SQL runner, migrate, clock listener, driver close() or hostile getter
  // throwing, to prove the harness still tears down, restores state and reports the right code.
  testing: 15,
  // why: 1 input(s), never a verdict (plan 101b sweep 8b-3) — a hostile toString fed to the
  // renderer.
  time: 1,
  // why: 8 input(s), never a verdict (plan 101b sweep 8b-3) — throwing toString/toJSON/getter traps
  // on rendered errors, a schema validator and a translator that throw, and storage throwing
  // SecurityError.
  ui: 8,
};
