// The ratchet under `scripts/log-levels.ts`: how many `info` lines each package writes on a
// per-unit path (`PER_UNIT_FILES`) without a `// info: <why>` saying why the event is news. A count
// may FALL and never rise. Data only — the rule owns what it does with these.
//
// Shrink it with `bun run scripts/log-levels.ts --unpin <pkg>[,<pkg>]`.

/** Where the table lives, so a stale-pin finding can name the file to edit. */
export const LOG_LEVEL_PINS_FILE = 'scripts/lib/log-levels-pins.ts';

export interface LogLevelPin {
  readonly count: number;
  /** Which events these are and why each is lifecycle or a rare outcome — never "it is fine". */
  readonly reason: string;
}

/**
 * Measured 2026-11-13, when the guard landed. Every row is a site that already obeys the policy
 * (lifecycle, or a rare outcome) and owes only its inline `// info:` — written by the package's
 * owner, then `--unpin`. The two marked `review:` are per-unit successes a later slice may demote.
 */
export const LOG_LEVEL_PINS: Readonly<Record<string, LogLevelPin>> = {
  http: {
    count: 2,
    reason:
      'why: `server.ts` writes `ultimate <role> listening` and `ultimate <role> stopped`, once per boot and once per stop — lifecycle.',
  },
  jobs: {
    count: 10,
    reason:
      'why: lifecycle — `scheduler.ts` started/draining and already-fired (another node fired the occurrence first, a rare handoff), `worker.ts` started/draining/drain-signalled; rare outcomes — `execute.ts` attempt interrupted/rate_limited, `heartbeat.ts` lease cancelled, `worker-key-busy.ts` attempt refused (review: a hot key refuses every attempt).',
  },
  mail: {
    count: 1,
    reason:
      "why: `driver.ts`'s `log` driver exists to write each message as a log line — the line is the send, in development.",
  },
  mcp: {
    count: 1,
    reason:
      "why: `audit-hook.ts`'s `mcp.auth.missing-token` is MCP's own OAuth discovery handshake, demoted from warn in 31.15 and kept at info so a client that never completes it is visible.",
  },
  notify: {
    count: 2,
    reason:
      'why: `native-push.ts` removes a device the platform says is gone or whose token failed repeatedly — a rare outcome that changes stored state.',
  },
  scraping: {
    count: 1,
    reason:
      "why: `scrape-run.ts`'s `scrape.ok` carries the run's usage and refusals (review: one line per scrape is a per-unit success).",
  },
};
