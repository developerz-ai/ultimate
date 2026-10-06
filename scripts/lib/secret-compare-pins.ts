// The ratchet under `scripts/secret-compare.ts`: how many `===` / `!==` / `.includes()` sites in
// each package compare something whose NAME is in the secret vocabulary. The number may FALL and
// may never rise. Data only — the gate owns what it does with these.
//
// WHY A COUNT AND A SENTENCE, not a count alone. Every site pinned here is a claim that the value
// is not a secret, and "pinned" with no sentence is the waiver axiom 3 refuses. A `Map` key, a sort
// key and a `keyOf` helper are all legitimately compared with `===`; a session token is not, and
// text cannot tell them apart. The sentence is where a human says which.
//
// WHY IT EXISTS AT ALL. `packages/auth/CLAUDE.md` states "never `===` on a secret" and nothing
// enforced it: all twelve `timingSafeEqual` call sites in `@ultimat3/auth` were rewritten to
// `(a) === (b)` and the suite answered 432 pass · 14 skip · 0 fail · 446 tests. `session.test.ts`
// alone passed 24 of 24 with `session.ts:149` degraded — the single most important comparison in
// the package. A unit test CANNOT assert constant time, which is exactly why this is a static gate.
//
// Shrink it with `bun run scripts/secret-compare.ts --unpin <pkg>[,<pkg>]`, which lowers a count to
// what is measured and refuses to raise one. Raising a count is a hand edit, in a review.

/** Where the table lives, so a stale-pin finding can name the file to edit. */
export const SECRET_PINS_FILE = 'scripts/lib/secret-compare-pins.ts';

export interface SecretComparePin {
  /** How many sites this package is allowed to hold today. */
  readonly count: number;
  /** Why those sites are not secrets. Named values, never "false positives". */
  readonly reason: string;
}

/**
 * Measured 2026-08-23, on the first run. `@ultimat3/auth` is ABSENT and that is the point: every
 * comparison of a token, a hash, a nonce or a state there already goes through `timingSafeEqual`,
 * so the package this rule was written for is at zero and stays there by construction.
 *
 * RE-MEASURED the same day, when the vocabulary learned the spelling a module-scope constant
 * actually uses: `SESSION_SECRET`, `API_KEY`, `DEV_SIGNING_SECRET` — SCREAMING_SNAKE read as an
 * ordinary identifier, and `password`/`otp` were not words at all. That added `storage` (which had
 * been absent entirely, while comparing a signing secret) and one `core` site, and moved nothing
 * else. `bun run secret-compare --json` re-derives every count in `data.counts`; no number below
 * is a claim about the tree that the command cannot check.
 */
export const SECRET_COMPARE_PINS: Readonly<Record<string, SecretComparePin>> = {
  action: {
    count: 1,
    reason:
      '`idempotency.ts:201` compares a stored `requestHash` with a recomputed one to decide REPLAY vs conflict. Both sides are hashes this process computed from a body it already holds; the answer is not an authentication decision.',
  },
  admin: {
    // why: `dev/jobs-state-chart.tsx:24` compares a job run's `status` with a job STATE it counts — a lifecycle enum, no secret.
    count: 3,
    reason:
      '`resource.ts:225,235` walk `LABEL_CANDIDATES` / `SORT_CANDIDATES` — two literal lists of FIELD NAMES in that file — and match each `candidate` against the resource’s declared fields. `candidate` is in the vocabulary because `mfa.ts` uses the word for a recovery code; here it is a loop variable over a constant, not a predicate’s own parameter, so the rule still reads it. The third (2026-10-05, plan 101 sweep 9b) is `dev/jobs-state-chart.tsx:24`, which counts runs per job state for the `/_x` jobs ring: `state` there is a job lifecycle value (`queued`, `running`, …), the word the rule reads as an OAuth state.',
  },
  ai: {
    count: 1,
    reason:
      '`prompt.ts:73` compares a cached prompt `hash` to decide whether to re-render the template. A cache-invalidation check on content this process produced.',
  },
  cli: {
    // why: `cmd-deploy-start-first.ts:87,90` compare a container's compose config hash with `docker compose config --hash` — a public digest of the compose file, no secret.
    count: 15,
    reason:
      '`app-load.ts` compares a route module’s source `hash` with the one it registered under, to decide whether the file changed since — a content digest of the app’s own source, computed here. build and CLI plumbing: a parsed CLI `token` and its aliases; a `review.state` from the GitHub API; and a content `hash` compared to decide whether a bundle or a migration changed. None is a credential check. The twelfth arrived 2026-09-06 with `startsWith`: `fix-path.ts:102` asks whether a path-shaped CITATION on a `fix:` line sits under a gitignored directory — `token` there is a file path off a doc line. The fourteenth and fifteenth are `island-shot-index.ts:29,32`, which group a screenshot verdict by island STATE ID — the slug a `.island.states.ts` declares, which is already the screenshot filename stem on disk and is read back off a path. A value the filesystem publishes is not a secret, and renaming the field to dodge the NAME heuristic would trade a real domain word for a lint. The sixteenth is `site-asset-routes.ts:95`, which compares a hashed site asset’s content `hash` with the one spelled in the requested URL — the hash IS the public URL, printed into every page that names the asset. Four `candidate` sites left this count on 2026-10-01, when a predicate’s own parameter stopped being read as a secret name — the ordinals above count from before that. The thirteenth (2026-10-05, plan 101 K8) is `island-sources.ts`’s `changedSource`, which compares a committed island source file’s content `digest` now with the one the prebuilt store recorded, to decide whether the stored chunk is stale — a digest of source the app ships, not a credential. The fourteenth and fifteenth (2026-10-05, plan 101 sweep 8c) are `cmd-deploy-start-first.ts:87,90`: a start-first rollout tells a container built from the new compose definition apart from a stale one by its `com.docker.compose.config-hash` label against `docker compose config --hash` — a digest of the compose file anyone can read.',
  },
  core: {
    count: 2,
    reason:
      '`cursor.ts:79` compares the configured cursor secret against the SHIPPED DEV CONSTANT so `x doctor` can report you are still on it — `DEV_SECRET` is a literal in that file, so there is nothing an attacker does not already have. `image/png-pixels.ts:86` compares one byte of a decoded file against `PNG_SIGNATURE`, the eight-byte magic number every PNG in the world opens with.',
  },
  db: {
    count: 2,
    reason:
      '`sqlstate.ts:121` compares a Postgres SQLSTATE `state` against `40001` and against `40P01` to decide whether to retry. A SQLSTATE is a five-character code the server prints in its own error text.',
  },
  i18n: {
    count: 1,
    reason:
      '`context.ts:207` compares a `translatorKey` — the catalog lookup name a registered translator answers to.',
  },
  // why: `driver-memory-operator.ts` matches a job row's lifecycle `state` against the state a bulk filter names — no secret.
  jobs: {
    count: 5,
    reason:
      '`driver-memory.ts`, `events.ts` and `backfill-pending.ts` compare a job lifecycle `state` (`queued`/`running`/`failed`), an `idempotencyKey` used to deduplicate an enqueue, and a `correlationKey` on an event. A job state is not an OAuth state. The sixth, 2026-10-01: `driver-memory-operator.ts` matches a row`s lifecycle `state` against a bulk filter`s (`requeueMany` / `removeMany`) — the same job state, compared to the one an operator named.',
  },
  manifest: {
    count: 13,
    reason:
      '`docs-search.ts` is a SEARCH INDEX: every one of its twelve sites compares, `.includes()` or `.indexOf()` a query `token`, which is one word a human typed into `x docs search`. `emit.ts:151` compares a `contentHash` against the build id to decide whether the manifest is current. The twelfth site is `docs-search.ts:148` — `symbolsLower.indexOf(token)`, visible from 2026-09-06 because `.indexOf(x) !== -1` is `.includes(x)` with an inert `-1` in front, and the equality scan used to delete the site on the strength of that half.',
  },
  query: {
    count: 1,
    reason:
      "`live.ts:177` compares a subscription `queryHash` against the cursor's to detect that the query changed under a live subscription. Both sides are hashes of a query this process compiled.",
  },
  render: {
    // why: `sass-cache.ts` compares two sha256 hashes of stylesheet files in the checkout — no secret.
    count: 1,
    reason:
      '`sass-cache.ts` compares the sha256 `digest` of a stylesheet the compiler read against the one stored beside a cached compile, to decide whether the entry is still valid. Both sides are hashes of source files in the checkout — nothing a caller supplies and nothing secret.',
  },
  realtime: {
    count: 3,
    reason:
      '`page-store.ts:80` reads `host[BOOT_RELEASE_KEY]` — `…_KEY` there is the NAME of the global property a page’s boot parks its release function under, compared by identity against this module’s own. `fanout.ts:50` walks a topic pattern one segment at a time, where `token` is a topic segment. The third is `pg-auth.ts:63` — `serverNonce.startsWith(this.#clientNonce)`, the RFC 5802 check that the SCRAM server echoed our own nonce back. A nonce is public by construction (it travels in clear in `client-first`) and the branch decides whether the exchange is well-formed, not whether a credential is right; the credential comparison in that file is the client proof, which is computed and never compared here.',
  },
  schema: {
    count: 1,
    reason:
      '`validators.ts:268` compares a `candidate` VALUE against the one literal a `literalSchema` was declared with — the value being validated, named for its role in the parse.',
  },
  storage: {
    count: 2,
    reason:
      "`driver-local.ts:73,182` compare the configured signing secret against `DEV_SIGNING_SECRET`, the SHIPPED DEV CONSTANT, so `x doctor` and `localDriver()` can refuse to sign with it outside development. Declared as a literal at `driver-local.ts:50` and re-exported from `index.ts`, exactly as `@ultimat3/core`'s `cursor.ts:71` pin above — the same question, and no byte an attacker does not already hold.",
  },
  time: {
    count: 2,
    reason:
      "`schedule.ts:90` compares a `candidate` DATE's weekday against the slot's while walking forward to the next occurrence. `cron-parse.ts:230` looks a cron field `token` up in the closed list of month and weekday NAMES — `jan`, `mon` — which is the cron expression a developer wrote, in the source.",
  },
};
