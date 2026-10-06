// The ratchet under `scripts/secret-compare.ts`: every comparison of a value whose NAME is in the
// secret vocabulary that is allowed to stay, keyed by SITE — `<path>: <the comparison as the rule
// quotes it>` — with the count of identical comparisons in that file. A row may FALL and may never
// rise. Data only — the gate owns what it does with these.
//
// WHY PER SITE, since plan 101 sweep 11. Per-package counts let a pinned false positive be SWAPPED
// for a real unsafe comparison: delete a pinned `queryHash` check, add `token === session.token` in
// the same package, and the count did not move. A row now names the one comparison its sentence is
// about, so a new comparison is a new row and a new row is a review.
//
// WHY A SENTENCE. Every row is a claim that the value is not a secret, and a row with no sentence
// is the waiver axiom 3 refuses. A `Map` key, a sort key and a search token are all legitimately
// compared with `===`; a session token is not, and text cannot tell them apart.
//
// WHY IT EXISTS AT ALL. `packages/auth/CLAUDE.md` states "never `===` on a secret" and nothing
// enforced it: all twelve `timingSafeEqual` call sites in `@ultimat3/auth` were rewritten to
// `(a) === (b)` and the suite answered 432 pass · 14 skip · 0 fail · 446 tests. A unit test CANNOT
// assert constant time, which is exactly why this is a static gate.
//
// Shrink it with `bun run scripts/secret-compare.ts --unpin <path>[,<path>]`, which lowers every
// row of each named file to what is measured, deletes a row at zero, and refuses to raise one.
// Adding or raising a row is a hand edit, in a review.

/** Where the table lives, so a stale-pin finding can name the file to edit. */
export const SECRET_PINS_FILE = 'scripts/lib/secret-compare-pins.ts';

export interface SecretComparePin {
  /** How many identical comparisons this file may hold at this site today. */
  readonly count: number;
  /** Why the compared value is not a secret. Named values, never "false positives". */
  readonly reason: string;
}

/**
 * Re-measured 2026-10-06 (plan 101 sweep 11): 54 comparisons in 51 rows across 16 packages.
 * `@ultimat3/auth` is ABSENT and that is the point: every comparison of a token, a hash, a nonce
 * or a state there goes through `timingSafeEqual`. `bun run secret-compare --json` re-derives
 * every row in `data.counts`; no number below is a claim the command cannot check.
 */
export const SECRET_COMPARE_PINS: Readonly<Record<string, SecretComparePin>> = {
  'packages/action/src/idempotency.ts: record.requestHash !== requestHash': {
    // why: re-keyed per site in plan 101 sweep 11; it was counted under the `action` package row.
    count: 1,
    reason:
      'A stored `requestHash` against a recomputed one, deciding REPLAY vs conflict. Both sides are hashes this process computed from a body it already holds; the answer is not an authentication decision.',
  },
  'packages/admin/src/dev/jobs-state-chart.tsx: run.status === state': {
    // why: re-keyed per site in plan 101 sweep 11; it was counted under the `admin` package row.
    count: 1,
    reason:
      'Counts runs per job state for the `/_x` jobs ring: `state` is a job lifecycle value (`queued`, `running`, …), the word the rule reads as an OAuth state.',
  },
  'packages/admin/src/resource.ts: field.name === candidate': {
    // why: re-keyed per site in plan 101 sweep 11; it was counted under the `admin` package row.
    count: 1,
    reason:
      'Walks `LABEL_CANDIDATES`, a literal list of FIELD NAMES in that file, matching each `candidate` against the resource’s declared fields — a loop variable over a constant.',
  },
  'packages/admin/src/resource.ts: f.name === candidate': {
    // why: re-keyed per site in plan 101 sweep 11; it was counted under the `admin` package row.
    count: 1,
    reason:
      'Walks `SORT_CANDIDATES`, a literal list of FIELD NAMES in that file, matching each `candidate` against the resource’s declared fields — a loop variable over a constant.',
  },
  'packages/ai/src/prompt.ts: existing.hash !== hash': {
    // why: re-keyed per site in plan 101 sweep 11; it was counted under the `ai` package row.
    count: 1,
    reason:
      'A cached prompt `hash`, compared to decide whether to re-render the template: a cache-invalidation check on content this process produced.',
  },
  'packages/cli/src/app-reload-graph.ts: hashOf(text) === node.hash': {
    // why: re-keyed per site in plan 101 sweep 11; it was counted under the `cli` package row.
    count: 1,
    reason:
      'A route module’s source `hash` against the one it registered under, to decide whether the file changed — a content digest of the app’s own source, computed here.',
  },
  'packages/cli/src/cmd-deploy-start-first.ts: fact.hash === want': {
    // why: re-keyed per site in plan 101 sweep 11; it was counted under the `cli` package row.
    count: 1,
    reason:
      'A container’s `com.docker.compose.config-hash` label against `docker compose config --hash`, telling a container built from the new compose definition from a stale one — a digest of a compose file anyone can read.',
  },
  'packages/cli/src/cmd-deploy-start-first.ts: fact.hash !== want': {
    // why: re-keyed per site in plan 101 sweep 11; it was counted under the `cli` package row.
    count: 1,
    reason:
      'The same compose config-hash comparison, negated: a public digest of the compose file, not a credential.',
  },
  'packages/cli/src/drift.ts: record.hash === hash': {
    // why: re-keyed per site in plan 101 sweep 11; it was counted under the `cli` package row.
    count: 1,
    reason:
      'A migration’s content `hash` against the recorded one, deciding whether the migration changed — a digest of a file in the checkout.',
  },
  'packages/cli/src/fix-path.ts: token.startsWith(dir)': {
    // why: re-keyed per site in plan 101 sweep 11; it was counted under the `cli` package row.
    count: 1,
    reason:
      'Asks whether a path-shaped CITATION on a `fix:` line sits under a gitignored directory — `token` is a file path off a doc line.',
  },
  'packages/cli/src/island-shot-index.ts: target.state === state': {
    // why: re-keyed per site in plan 101 sweep 11; it was counted under the `cli` package row.
    count: 1,
    reason:
      'Groups a screenshot verdict by island STATE ID — the slug a `.island.states.ts` declares, already the screenshot filename stem on disk.',
  },
  'packages/cli/src/island-shot-index.ts: shot.state === state': {
    // why: re-keyed per site in plan 101 sweep 11; it was counted under the `cli` package row.
    count: 1,
    reason:
      'Groups a screenshot by island STATE ID — a slug the filesystem already publishes as the screenshot filename stem.',
  },
  'packages/cli/src/island-sources.ts: (await digestOf(stamp.path)) !== stamp.digest': {
    // why: re-keyed per site in plan 101 sweep 11; it was counted under the `cli` package row.
    count: 1,
    reason:
      'A committed island source file’s content `digest` now against the one the prebuilt store recorded, to decide whether the stored chunk is stale — a digest of source the app ships.',
  },
  'packages/cli/src/island-store.ts: contentHash(code) !== entry.identity': {
    // why: re-keyed per site in plan 101 sweep 11; it was counted under the `cli` package row.
    count: 1,
    reason:
      'A stored island chunk’s content hash against the identity the store recorded for it, to decide whether the cached bytes are still the build’s — a digest of shipped code.',
  },
  'packages/cli/src/parse.ts: spec.name === token': {
    // why: re-keyed per site in plan 101 sweep 11; it was counted under the `cli` package row.
    count: 1,
    reason: 'A parsed CLI `token` — a word from argv — matched against a command’s name.',
  },
  'packages/cli/src/parse.ts: (spec.aliases ?? []).includes(token)': {
    // why: re-keyed per site in plan 101 sweep 11; it was counted under the `cli` package row.
    count: 1,
    reason: 'A parsed CLI `token` — a word from argv — matched against a command’s aliases.',
  },
  'packages/cli/src/parse.ts: allowed.includes(token)': {
    // why: re-keyed per site in plan 101 sweep 11; it was counted under the `cli` package row.
    count: 1,
    reason:
      'A parsed CLI `token` — a word from argv — matched against the subcommands a command allows.',
  },
  'packages/cli/src/pr-threads.ts: review.state === decision': {
    // why: re-keyed per site in plan 101 sweep 11; it was counted under the `cli` package row.
    count: 1,
    reason:
      'A `review.state` from the GitHub API (`APPROVED`, `CHANGES_REQUESTED`) against the decision being looked for.',
  },
  'packages/cli/src/site-asset-routes.ts: asset.hash !== named.hash': {
    // why: re-keyed per site in plan 101 sweep 11; it was counted under the `cli` package row.
    count: 1,
    reason:
      'A hashed site asset’s content `hash` against the one spelled in the requested URL — the hash IS the public URL, printed into every page that names the asset.',
  },
  'packages/cli/src/solid-loader.ts: hit.hash === hash': {
    // why: re-keyed per site in plan 101 sweep 11; it was counted under the `cli` package row.
    count: 1,
    reason:
      'A cached island transform’s content `hash` against the source’s, deciding whether the cached compile is still valid — a digest of source this process read.',
  },
  'packages/core/src/cursor.ts: currentSecret() === DEV_SECRET': {
    // why: re-keyed per site in plan 101 sweep 11; it was counted under the `core` package row.
    count: 1,
    reason:
      'Compares the configured cursor secret against the SHIPPED DEV CONSTANT so `x doctor` can report you are still on it — `DEV_SECRET` is a literal in that file, nothing an attacker does not already have.',
  },
  'packages/core/src/image/png-pixels.ts: bytes[i] !== PNG_SIGNATURE[i]': {
    // why: re-keyed per site in plan 101 sweep 11; it was counted under the `core` package row.
    count: 1,
    reason:
      'One byte of a decoded file against `PNG_SIGNATURE`, the eight-byte magic number every PNG in the world opens with.',
  },
  'packages/db/src/sqlstate.ts: state === SQLSTATE.serializationFailure': {
    // why: re-keyed per site in plan 101 sweep 11; it was counted under the `db` package row.
    count: 1,
    reason:
      'A Postgres SQLSTATE `state` against `40001`, deciding whether to retry — a five-character code the server prints in its own error text.',
  },
  'packages/db/src/sqlstate.ts: state === SQLSTATE.deadlockDetected': {
    // why: re-keyed per site in plan 101 sweep 11; it was counted under the `db` package row.
    count: 1,
    reason:
      'A Postgres SQLSTATE `state` against `40P01`, deciding whether to retry — a five-character code the server prints in its own error text.',
  },
  'packages/i18n/src/context.ts: translatorKey(registered) === key': {
    // why: re-keyed per site in plan 101 sweep 11; it was counted under the `i18n` package row.
    count: 1,
    reason: 'A `translatorKey` — the catalog lookup name a registered translator answers to.',
  },
  'packages/jobs/src/backfill-pending.ts: PENDING_BACKFILL_STATES.includes(state)': {
    // why: re-keyed per site in plan 101 sweep 11; it was counted under the `jobs` package row.
    count: 1,
    reason:
      'A job lifecycle `state` (`queued`/`running`/`failed`) against the states a pending backfill counts. A job state is not an OAuth state.',
  },
  'packages/jobs/src/driver-memory-operator.ts: record.state === filter.state': {
    // why: re-keyed per site in plan 101 sweep 11; it was counted under the `jobs` package row.
    count: 2,
    reason:
      '`requeueMany` / `removeMany` match a row’s lifecycle `state` against the state a bulk filter names — a job state, compared to the one an operator named.',
  },
  'packages/jobs/src/driver-memory.ts: record.idempotencyKey === key': {
    // why: re-keyed per site in plan 101 sweep 11; it was counted under the `jobs` package row.
    count: 1,
    reason:
      'An `idempotencyKey` used to deduplicate an enqueue — a caller-chosen dedupe name, not a credential.',
  },
  'packages/jobs/src/events.ts: event.correlationKey !== correlationKey': {
    // why: re-keyed per site in plan 101 sweep 11; it was counted under the `jobs` package row.
    count: 1,
    reason: 'A `correlationKey` on a job event, grouping events of one run.',
  },
  'packages/jobs/src/operator-surface-settle-fixture.ts: row.idempotencyKey === ` occurrenceMs `': {
    // why: re-keyed per site in plan 101 sweep 11; it was counted under the `jobs` package row.
    count: 1,
    reason:
      'A test fixture filtering listed rows by the idempotency key a scheduled fire derives from its occurrence (`nightly:<ms>`) — a dedupe name the fixture built itself. Visible from sweep 11, when an interpolating template stopped reading as a constant.',
  },
  'packages/manifest/src/docs-search.ts: out.includes(token)': {
    // why: re-keyed per site in plan 101 sweep 11; it was counted under the `manifest` package row.
    count: 1,
    reason:
      '`docs-search.ts` is a SEARCH INDEX: `token` is one word a human typed into `x docs search`, deduplicated here.',
  },
  'packages/manifest/src/docs-search.ts: symbolsLower.indexOf(token)': {
    // why: re-keyed per site in plan 101 sweep 11; it was counted under the `manifest` package row.
    count: 1,
    reason:
      'A search `token` — one word a human typed into `x docs search` — looked up among symbol names.',
  },
  'packages/manifest/src/docs-search.ts: symbol.includes(token)': {
    // why: re-keyed per site in plan 101 sweep 11; it was counted under the `manifest` package row.
    count: 1,
    reason:
      'A search `token` — one word a human typed into `x docs search` — matched inside a symbol name.',
  },
  'packages/manifest/src/docs-search.ts: topicTokens.includes(token)': {
    // why: re-keyed per site in plan 101 sweep 11; it was counted under the `manifest` package row.
    count: 1,
    reason:
      'A search `token` — one word a human typed into `x docs search` — matched against a topic’s words.',
  },
  'packages/manifest/src/docs-search.ts: packageToken === token': {
    // why: re-keyed per site in plan 101 sweep 11; it was counted under the `manifest` package row.
    count: 1,
    reason:
      'A search `token` — one word a human typed into `x docs search` — matched against a package name.',
  },
  'packages/manifest/src/docs-search.ts: !matched.includes(token)': {
    // why: re-keyed per site in plan 101 sweep 11; it was counted under the `manifest` package row.
    count: 3,
    reason:
      'A search `token` — one word a human typed into `x docs search` — recorded once per field it matched in.',
  },
  'packages/manifest/src/docs-search.ts: titleLower.includes(token)': {
    // why: re-keyed per site in plan 101 sweep 11; it was counted under the `manifest` package row.
    count: 1,
    reason:
      'A search `token` — one word a human typed into `x docs search` — matched inside a doc title.',
  },
  'packages/manifest/src/docs-search.ts: textLower.includes(token)': {
    // why: re-keyed per site in plan 101 sweep 11; it was counted under the `manifest` package row.
    count: 1,
    reason:
      'A search `token` — one word a human typed into `x docs search` — matched inside a doc body.',
  },
  'packages/manifest/src/docs-search.ts: topic.includes(token)': {
    // why: re-keyed per site in plan 101 sweep 11; it was counted under the `manifest` package row.
    count: 1,
    reason:
      'A search `token` — one word a human typed into `x docs search` — scored against a topic.',
  },
  'packages/manifest/src/docs-search.ts: topic.includes(token.slice(0, 4))': {
    // why: re-keyed per site in plan 101 sweep 11; it was counted under the `manifest` package row.
    count: 1,
    reason:
      'A search `token`’s four-letter prefix scored against a topic, so `retries` reaches `retry` — a word a human typed into `x docs search`.',
  },
  'packages/manifest/src/emit.ts: contentHash(body) === buildId': {
    // why: re-keyed per site in plan 101 sweep 11; it was counted under the `manifest` package row.
    count: 1,
    reason:
      'A `contentHash` against the build id, deciding whether the manifest is current — a digest of content this process emitted.',
  },
  'packages/query/src/live.ts: cursor.queryHash !== hash': {
    // why: re-keyed per site in plan 101 sweep 11; it was counted under the `query` package row.
    count: 1,
    reason:
      'A subscription `queryHash` against the cursor’s, detecting that the query changed under a live subscription. Both sides are hashes of a query this process compiled.',
  },
  'packages/realtime/src/fanout.ts: token !== s[i]': {
    // why: re-keyed per site in plan 101 sweep 11; it was counted under the `realtime` package row.
    count: 1,
    reason: 'Walks a topic pattern one segment at a time: `token` is a topic segment.',
  },
  'packages/realtime/src/page-store.ts: host[BOOT_RELEASE_KEY] !== release': {
    // why: re-keyed per site in plan 101 sweep 11; it was counted under the `realtime` package row.
    count: 1,
    reason:
      '`…_KEY` is the NAME of the global property a page’s boot parks its release function under, compared by identity against this module’s own.',
  },
  'packages/realtime/src/pg-auth.ts: !serverNonce.startsWith(this.)': {
    // why: re-keyed per site in plan 101 sweep 11; it was counted under the `realtime` package row.
    count: 1,
    reason:
      '`serverNonce.startsWith(this.#clientNonce)`, the RFC 5802 check that the SCRAM server echoed our own nonce back. A nonce is public by construction (it travels in clear in `client-first`); the credential comparison is the client proof, computed and never compared here.',
  },
  'packages/render/src/sass-cache.ts: digestOf(path) === digest': {
    // why: re-keyed per site in plan 101 sweep 11; it was counted under the `render` package row.
    count: 1,
    reason:
      'The sha256 `digest` of a stylesheet the compiler read against the one stored beside a cached compile — hashes of source files in the checkout, nothing a caller supplies.',
  },
  'packages/schema/src/validators.ts: candidate === value': {
    // why: re-keyed per site in plan 101 sweep 11; it was counted under the `schema` package row.
    count: 1,
    reason:
      'A `candidate` VALUE against the one literal a `literalSchema` was declared with — the value being validated, named for its role in the parse.',
  },
  'packages/storage/src/signing-secret.ts: configured === DEV_SIGNING_SECRET': {
    // why: re-keyed per site in plan 101 sweep 11; it was counted under the `storage` package row.
    count: 1,
    reason:
      'The configured signing secret against `DEV_SIGNING_SECRET`, the SHIPPED DEV CONSTANT, so `x doctor` can refuse to sign with it outside development — a published literal, no byte an attacker does not already hold.',
  },
  'packages/storage/src/signing-secret.ts: supplied === DEV_SIGNING_SECRET': {
    // why: re-keyed per site in plan 101 sweep 11; it was counted under the `storage` package row.
    count: 1,
    reason:
      'A supplied signing secret against `DEV_SIGNING_SECRET`, the SHIPPED DEV CONSTANT, so `localDriver()` can refuse it outside development — a published literal, no byte an attacker does not already hold.',
  },
  'packages/time/src/cron-parse.ts: list.indexOf(token)': {
    // why: re-keyed per site in plan 101 sweep 11; it was counted under the `time` package row.
    count: 1,
    reason:
      'Looks a cron field `token` up in the closed list of month and weekday NAMES (`jan`, `mon`) — the cron expression a developer wrote, in the source.',
  },
  'packages/time/src/schedule.ts: toZoned(candidate, slot.zone).weekday === slot.weekday': {
    // why: re-keyed per site in plan 101 sweep 11; it was counted under the `time` package row.
    count: 1,
    reason:
      'A `candidate` DATE’s weekday against the slot’s while walking forward to the next occurrence.',
  },
};
