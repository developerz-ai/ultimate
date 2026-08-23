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
    count: 6,
    reason:
      '`routes.ts`, `mcp.ts`, `nav.ts` and `resource.ts` match a `candidate` ROUTE PATH, TOOL NAME, NAV ENTRY or FIELD NAME against the registry. `candidate` is in the vocabulary because `mfa.ts` uses the word for a recovery code; here it is a registered identifier.',
  },
  ai: {
    count: 1,
    reason:
      '`prompt.ts:73` compares a cached prompt `hash` to decide whether to re-render the template. A cache-invalidation check on content this process produced.',
  },
  cli: {
    count: 11,
    reason:
      'build and CLI plumbing: a `candidate` EXECUTABLE PATH, OUTPUT PATH, COMMAND NAME or CI JOB NAME; a parsed CLI `token` and its aliases; a `review.state` from the GitHub API; and a content `hash` compared to decide whether a bundle or a migration changed. None is a credential check.',
  },
  core: {
    count: 4,
    reason:
      '`lifecycle.ts:250,289` compare a `candidate` REGISTRATION and WAITER by object identity while removing one from a list. `cursor.ts:71` compares the configured cursor secret against the SHIPPED DEV CONSTANT so `x doctor` can report you are still on it — `DEV_SECRET` is a literal in that file, so there is nothing an attacker does not already have. `image/png-pixels.ts:86` compares one byte of a decoded file against `PNG_SIGNATURE`, the eight-byte magic number every PNG in the world opens with.',
  },
  db: {
    count: 3,
    reason:
      '`sqlstate.ts:106` compares a Postgres SQLSTATE `state` against `40001`/`40P01` to decide whether to retry, and `introspect.ts:212` matches a `candidate` TABLE NAME. A SQLSTATE is a five-character code the server prints in its own error text.',
  },
  i18n: {
    count: 1,
    reason:
      '`context.ts:207` compares a `translatorKey` — the catalog lookup name a registered translator answers to.',
  },
  jobs: {
    count: 5,
    reason:
      '`driver-memory.ts`, `job.ts`, `events.ts` and `backfill-pending.ts` compare a job lifecycle `state` (`queued`/`running`/`failed`), an `idempotencyKey` used to deduplicate an enqueue, a `correlationKey` on an event, and a `candidate` JOB NAME. A job state is not an OAuth state.',
  },
  manifest: {
    count: 12,
    reason:
      '`docs-search.ts` is a SEARCH INDEX: every one of its eleven sites compares or `.includes()` a query `token`, which is one word a human typed into `x docs search`. `emit.ts:151` compares a `contentHash` against the build id to decide whether the manifest is current.',
  },
  query: {
    count: 1,
    reason:
      "`live.ts:177` compares a subscription `queryHash` against the cursor's to detect that the query changed under a live subscription. Both sides are hashes of a query this process compiled.",
  },
  realtime: {
    count: 6,
    reason:
      '`offline-queue.ts`, `rebase.ts`, `presence.ts` and `sync-protocol.ts` compare a `candidate` QUEUED MUTATION, PRESENCE MEMBER or protocol VALUE, by the client-side key a write is deduplicated on. `fanout.ts:50` walks a topic pattern one segment at a time, where `token` is a topic segment.',
  },
  schema: {
    count: 1,
    reason:
      "`validators.ts:242` compares a `candidate` against an enum member — the `in` validator's membership test over a declared list.",
  },
  scripts: {
    count: 1,
    reason:
      '`reference-app-gate.ts:364` matches a `candidate` APP DIRECTORY against the one `--unpin` named.',
  },
  storage: {
    count: 2,
    reason:
      "`driver-local.ts:73,182` compare the configured signing secret against `DEV_SIGNING_SECRET`, the SHIPPED DEV CONSTANT, so `x doctor` and `localDriver()` can refuse to sign with it outside development. Declared as a literal at `driver-local.ts:50` and re-exported from `index.ts`, exactly as `@ultimat3/core`'s `cursor.ts:71` pin above — the same question, and no byte an attacker does not already hold.",
  },
  time: {
    count: 1,
    reason:
      "`schedule.ts:90` compares a `candidate` DATE's weekday against the slot's while walking forward to the next occurrence.",
  },
};

/** What this package is allowed to have today. Absent means zero, deliberately. */
export const secretComparePinnedFor = (
  pkg: string,
  pins: Readonly<Record<string, SecretComparePin>> = SECRET_COMPARE_PINS,
): number => (Object.hasOwn(pins, pkg) ? (pins[pkg]?.count ?? 0) : 0);

/**
 * The edit `X_SECRET_COMPARE_PIN_STALE` names, performed: lower each named package's count to what
 * is measured, and refuse to raise one. Returns the entries it changed, so the caller can say
 * "nothing to lower" rather than reporting a write it did not make.
 */
export async function applySecretCompareUnpin(
  root: string,
  packages: readonly string[],
  counts: Readonly<Record<string, number>>,
  pins: Readonly<Record<string, SecretComparePin>> = SECRET_COMPARE_PINS,
): Promise<readonly string[]> {
  const path = `${root}/${SECRET_PINS_FILE}`;
  let text = await Bun.file(path).text();
  const written: string[] = [];
  for (const pkg of packages) {
    const found = counts[pkg] ?? 0;
    const pinned = secretComparePinnedFor(pkg, pins);
    if (found >= pinned) continue;
    // `RegExp.escape`, never the raw key: a workspace name holding regex syntax matches a
    // NEIGHBOURING row, and the ratchet then lowers the wrong package.
    const key = RegExp.escape(pkg);
    if (found === 0) {
      // The whole entry, reason and all — an emptied row would otherwise sit there claiming a
      // debt of zero, which reads as a rule still in force over nothing.
      const entry = new RegExp(`^\\s*(['"]?)${key}\\1:\\s*\\{[\\s\\S]*?\\n\\s*\\},\\n`, 'm');
      if (!entry.test(text)) continue;
      text = text.replace(entry, '');
    } else {
      const entry = new RegExp(`^(\\s*(['"]?)${key}\\2:\\s*\\{\\s*\\n\\s*count:\\s*)\\d+,$`, 'm');
      if (!entry.test(text)) continue;
      text = text.replace(entry, `$1${String(found)},`);
    }
    written.push(`${pkg} -> ${String(found)}`);
  }
  if (written.length > 0) await Bun.write(path, text);
  return written;
}
