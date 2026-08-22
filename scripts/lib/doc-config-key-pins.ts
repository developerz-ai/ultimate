// The pages allowed to cite an `app.config.ts` key `AppConfig` does not declare, one entry each,
// with the reason. Read by `scripts/doc-config-keys.ts`; an entry that matches nothing is a finding,
// so the list can only shrink by being wrong.
//
// Not a reason: "we will fix it later". Drift is a finding. The one legitimate reason is that the
// citation is a SYMPTOM of a defect that lives somewhere else and is a release decision, recorded
// here so the gap is visible rather than absent.

/** Where the table lives, so a stale-pin finding can name the file to edit. */
export const DOC_CONFIG_PINS_FILE = 'scripts/lib/doc-config-key-pins.ts';

/** One page's licence to cite one key that resolves against nothing. */
export interface DocConfigKeyAllowance {
  /** Repo-relative, exactly as the scan reports it. */
  readonly path: string;
  /** The citation verbatim: `http.requestTimeoutMs`. */
  readonly cites: string;
  /** Why this page may say it. One sentence, and it must survive being read out loud. */
  readonly why: string;
}

/**
 * Measured 2026-08-22, the day the citation reader learned to see an unknown top-level SECTION
 * rather than only an unknown leaf under a known one. All four are ONE defect and it is not in
 * these pages: `packages/http/src/config.ts` opens with "The HTTP slice of `app.config.ts`" and
 * `AppConfig` (`packages/core/src/config.ts`) declares no `http` member at all — so `http:` in a
 * `defineConfig({…})` literal is an excess-property type error, and the only `HttpConfig` any
 * framework-booted process builds is `defineHttpConfig(…)` in `packages/cli/src/dev-roles.ts`, from
 * `port`/`dev`/`buildId`/`hostname`/`signInPath`/`trustProxy` and a `rateLimit.scope` derived from
 * the store. `requestTimeoutMs`, `cors`, `csrf` and `rateLimit.buckets` are reachable from no app
 * config key that exists.
 *
 * Eight shipped `fix:` lines in `@ultimat3/http` say the same thing (`errors.ts` ×5,
 * `rate-limit-errors.ts` ×3), so the repair is one decision — declare an `http` section on
 * `AppConfig` and wire it, or rewrite every site to name `createServer({ routes, config:
 * defineHttpConfig(…) })` — and it is a release decision, not an edit to the four rows below.
 */
export const DOC_CONFIG_KEY_ALLOWANCES: readonly DocConfigKeyAllowance[] = [
  {
    path: 'wiki/Error-Codes.md',
    cites: 'http.rateLimit.scope',
    why: "X_RATE_LIMIT_SCOPE_UNSET's Fix cell, the wiki copy of `packages/http/src/rate-limit-errors.ts`'s own fix line — one `http` section defect, not a typo on this row",
  },
  {
    path: 'wiki/Error-Codes.md',
    cites: 'http.csrf.mode',
    why: "X_CSRF_BLOCKED's Fix cell, the wiki copy of `packages/http/src/errors.ts`'s own fix line — same `http` section defect",
  },
  {
    path: 'wiki/Error-Codes.md',
    cites: 'http.cors.credentials',
    why: "X_CORS_CONFIG_INVALID's Fix cell, the wiki copy of `packages/http/src/errors.ts`'s own fix line — same `http` section defect",
  },
  {
    path: 'wiki/Agents.md',
    cites: 'http.requestTimeoutMs',
    why: "the agent-timeout row, the wiki copy of X_TIMEOUT's own fix line in `packages/http/src/errors.ts` — same `http` section defect",
  },
];
