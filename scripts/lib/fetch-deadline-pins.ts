// The ratchet under `scripts/fetch-deadline.ts`: how many shipped `fetch(` calls each package makes
// with no `signal` in their own options. A count may FALL and never rise without a `why:` saying
// what ends the call instead. Data only — the rule owns what it does with these.
//
// Shrink it with `bun run scripts/fetch-deadline.ts --unpin <pkg>[,<pkg>]`.

/** Where the table lives, so a stale-pin finding can name the file to edit. */
export const FETCH_DEADLINE_PINS_FILE = 'scripts/lib/fetch-deadline-pins.ts';

export interface FetchDeadlinePin {
  readonly count: number;
  /** What ends each unsignalled call, by name — never "it returns". */
  readonly reason: string;
}

/**
 * Measured 2026-11-03. The vendor clients (`auth`, `cache`, `mail`, `pwa`, `ai`'s embedder) moved
 * onto `outbound()` and their rows went with them; what is left is a local name, a browser seam
 * whose bytes a page pays for, a build-time script or this machine's own loopback.
 */
export const FETCH_DEADLINE_PINS: Readonly<Record<string, FetchDeadlinePin>> = {
  // why: not the platform fetch at all.
  action: {
    count: 1,
    reason:
      "why: `idempotency-postgres.ts`'s `fetch(key)` is the store's own local read of a record, a function that shadows the global name; nothing leaves the process.",
  },
  cli: {
    count: 1,
    reason:
      "why: `cdp-shot-driver.ts`'s `defaultFetchJson` reads Chrome's `/json/version` on this machine's loopback debugging port, a process `x shot` started and kills; its launch is bounded by the attempt's own deadline.",
  },
  core: {
    count: 1,
    reason:
      "why: `client-dispatch.ts`'s `browserFetch` forwards `init`, and `clientTransport` always sets the flight's `signal` in it; a browser has no request to outlive.",
  },
  // why: the seam outbound() calls, not a call of its own.
  notify: {
    count: 1,
    reason:
      "why: `native-transport.ts`'s `platformFetch` is the `fetch` handed to `outbound()` (`apns.ts`, `fcm.ts`), which passes its own `init.signal` — the push's `deadlineMs` — on every hop; it reads the global per call so a test's sealed network sees it.",
  },
  realtime: {
    count: 1,
    reason:
      "why: `use-query.ts`'s `fetch(append)` is the island's own local page loader, a function that shadows the global name; its transport call carries the query's signal.",
  },
  // why: a build-time generator a person runs, never shipped code on a request path.
  ui: {
    count: 2,
    reason:
      'why: `icons/build-icons.ts` runs by hand (`bun run packages/ui/src/icons/build-icons.ts`) to regenerate the icon set from the Lucide registry; the person running it ends it.',
  },
  scripts: {
    count: 2,
    reason:
      "why: `registry-audit.ts` defaults its registry seam to `fetch(url, init)`, and its callers pass `signal: AbortSignal.timeout(...)` in `init`; `bench/restart-bench.ts`'s publisher fires against its own loopback server, which the bench kills when the run ends.",
  },
};
