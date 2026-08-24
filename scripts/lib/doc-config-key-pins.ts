// The pages allowed to cite an `app.config.ts` key `AppConfig` does not declare, one entry each,
// with the reason. Read by `scripts/doc-config-keys.ts`; an entry that matches nothing is a finding,
// so the list can only shrink by being wrong.

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
 * Not a reason: "we will fix it later". Drift is a finding. The one legitimate reason is that the
 * citation is a SYMPTOM of a defect that lives somewhere else and is a release decision, recorded
 * here so the gap is visible rather than absent.
 *
 * EMPTY since 12.0.0, and that is the point. The four entries here were all ONE defect: `AppConfig`
 * declared no `http` member, so `http.requestTimeoutMs`, `http.cors.*`, `http.csrf.mode` and
 * `http.rateLimit.scope` were reachable from no app config key that existed, and the pages quoting
 * the shipped `fix:` lines inherited it. This table said the repair "is a release decision, not an
 * edit to the four rows below" — 12.0.0 is that decision. `configureHttp()` is the seam, the
 * `fix:` lines name it, and the wiki rows were rewritten to match, so nothing is waived any more.
 */
export const DOC_CONFIG_KEY_ALLOWANCES: readonly DocConfigKeyAllowance[] = [];
