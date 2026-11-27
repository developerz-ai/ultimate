// Every break parked for `next` (wiki/Stability.md), one row each, with the plan and ledger lines
// that parked it. Anchors, not line numbers: `scripts/next-breaks.ts` resolves each to `file:line`
// on every run and refuses one that no longer matches exactly one line.

/** A line that records the break: `anchor` is a substring of exactly one line of `path`. */
export interface BreakSource {
  readonly path: string;
  readonly anchor: string;
}

/** A declaration the break deletes: `symbol` is declared in `path`, where its `@deprecated` sits. */
export interface RemovedSymbol {
  readonly path: string;
  readonly symbol: string;
}

export interface ParkedBreak {
  /** The plan item ids that name it, as the plans spell them. */
  readonly ids: string;
  readonly title: string;
  /** What changes for an app the day `next` merges. */
  readonly change: string;
  readonly sources: readonly BreakSource[];
  /**
   * What it deletes. Every source comment that promises a removal at the next major must be one
   * of these (`X_NEXT_BREAK_UNPARKED`); one with no tag yet is reported as owed one.
   */
  readonly removes?: readonly RemovedSymbol[];
}

const P11 = 'docs/plans/2026/11/11/101-full-stack-efficiency-sweeps';
const P14 = 'docs/plans/2026/11/14/101-finished-and-self-maintained';
const OD10: BreakSource = {
  path: `${P11}/90-owner-decisions.md`,
  anchor: '| OD10 | Breaking items parked for `next`',
};
export const KNOWN_GAPS = 'wiki/Known-Gaps.md';

/** The title of the one tracking issue; `gh issue list --search` finds it by this, exactly. */
export const NEXT_TRACKING_TITLE = 'next: every break parked for the major window';

export const PARKED_BREAKS: readonly ParkedBreak[] = [
  {
    ids: 'E12 / E2',
    title: '`.all()` refuses when a cursor remains',
    change:
      'a bare `.all()` whose page filled throws its coded refusal instead of logging `ALL_TRUNCATED`; the scaffolded `unbounded-read` guard errors',
    sources: [
      OD10,
      { path: `${P11}/05-entity.md`, anchor: '| E12 | shipped (warning only)' },
      { path: `${P14}/03-db-entity-policy.md`, anchor: '2. E2: in 31.x' },
    ],
  },
  {
    ids: 'E9',
    title: 'redundant implicit indexes dropped by default',
    change:
      'a foreign-key index another index already leads with is no longer emitted, so `x db gen` drops it in an existing app',
    sources: [OD10, { path: `${P11}/05-entity.md`, anchor: '| E9 | partial' }],
  },
  {
    ids: 'E1',
    title: '`updateWhere` / `deleteWhere` removed',
    change: '`.updateAll(patch)` and `.deleteAll()` on the read chain are the one way',
    sources: [OD10, { path: `${P11}/05-entity.md`, anchor: '| E1 | shipped, renamed' }],
  },
  {
    ids: 'K4',
    title: "`sitemap`'s `now` option removed",
    change: '`clock?: Clock` is the one clock seam; the deprecated alias goes',
    sources: [OD10, { path: `${P11}/04-cache-seo.md`, anchor: '| K4 | P3' }],
    removes: [{ path: 'packages/seo/src/sitemap.ts', symbol: 'now' }],
  },
  {
    ids: 'X8 / G1',
    title: '`x verify` strict by default',
    change:
      'every one of the gate steps runs or carries a written `why`; a step an app never floored stops skipping in silence',
    sources: [
      OD10,
      { path: `${P11}/13-cli-exercise-verify.md`, anchor: '| X8 | non-breaking half only' },
      { path: `${P14}/07-gate-truth.md`, anchor: '1. G1: `x verify` prints' },
      { path: `${P14}/90-owner-decisions.md`, anchor: '| OD2 | The strict gate' },
    ],
  },
  {
    ids: 'G6',
    title: 'the planned commands `branch`, `ai` and `money` leave the CLI',
    change: '`x branch`, `x ai` and `x money` are removed from the registry, not planned',
    sources: [{ path: `${P14}/07-gate-truth.md`, anchor: '6. G6: per `90` OD3' }],
  },
  {
    ids: 'ERROR_DOCS_URL',
    title: 'error docs links move to the docs site',
    change:
      '`ERROR_DOCS_URL` points at the docs site’s `/errors/<code>`, once the site has served for two weeks; a test pinning the old string updates',
    sources: [
      {
        path: 'docs/plans/2026/11/02/101-absorb-reinvented-patterns/42-adopt-docs-site.md',
        anchor: 'flips `ERROR_DOCS_URL` to',
      },
    ],
  },
  {
    ids: 'Q2',
    title: 'a live query ordered by a non-`C` text column is refused',
    change: 'refused at subscribe instead of logging `X_LIVE_ORDER_COLLATION`',
    sources: [
      { path: `${P11}/08-action-query.md`, anchor: '| Q2 | shipped as a warning; refusal on' },
    ],
  },
  {
    ids: 'J18',
    title: 'an undeclared `step.run` output past 256 KiB is refused',
    change: '`X_STEP_OUTPUT_TOO_LARGE` by default, instead of stored with a warning',
    sources: [
      { path: `${P11}/09-jobs.md`, anchor: '| J18 | shipped as a ceiling' },
      { path: KNOWN_GAPS, anchor: 'A `step.run` output past 256 KiB is stored with a warning' },
    ],
  },
  {
    ids: 'X_BOUNDARY_DEV_IMPORT',
    title: 'a development entry in a role’s module graph is refused',
    change:
      'the `boundaries` step is red, not warning, for a module the boot scan imports that reaches `@ultimat3/cli`, `@ultimat3/testing` or `bun:test`',
    sources: [
      { path: 'packages/cli/src/app-dev-imports.ts', anchor: 'the refusal lands on `next`' },
    ],
  },
  {
    ids: 'onSettled',
    title: "a job body's return value is stored",
    change: '`onSettled` runs at least once for every completion, a returned value included',
    sources: [
      { path: KNOWN_GAPS, anchor: '`onSettled` for a completion that **returned a value**' },
    ],
  },
  {
    ids: 'T3',
    title: 'the e2e accessibility audit covers more roles',
    change:
      'the listbox, option, `menuitem*` and treeitem roles and focusable-without-role join the audit, which has no warn mode',
    sources: [{ path: `${P11}/15-admin-ui-testing.md`, anchor: '| T3 | **already shipped**' }],
  },
  {
    ids: 'tenantColumn',
    title: "the replicator's and the record publisher's `tenantColumn` option removed",
    change:
      'ignored since 31.38.1: the tenant of a change is the column its entity declares (`entity(name, { tenant })`); passing the option stops compiling',
    sources: [],
    removes: [
      { path: 'packages/realtime/src/live-replicator.ts', symbol: 'tenantColumn' },
      { path: 'packages/realtime/src/record-publisher.ts', symbol: 'tenantColumn' },
    ],
  },
  {
    ids: 'orgIdOf',
    title: '`orgIdOf` leaves `@ultimat3/realtime/server`',
    change:
      'the helper, unused now that a live window takes its org from its tenant alone, is no longer exported; importing it stops compiling',
    sources: [],
    removes: [{ path: 'packages/realtime/src/query-window.ts', symbol: 'orgIdOf' }],
  },
  {
    ids: 'error-reference pages',
    title: "the CLI's single-page error-reference checks removed",
    change:
      'the error reference is a page set since 31.35.0: `documentedCodesIn`, `liveCodesIn`, `declaredUnthrownIn`, `checkErrorCodeRegistryIn`, `checkErrorCodeDocsIn` and `checkErrorCodesThrownIn` are the one way',
    sources: [],
    removes: [
      { path: 'packages/cli/src/error-contract.ts', symbol: 'documentedCodes' },
      { path: 'packages/cli/src/error-contract.ts', symbol: 'liveCodes' },
      { path: 'packages/cli/src/error-contract.ts', symbol: 'checkErrorCodeRegistry' },
      { path: 'packages/cli/src/error-contract.ts', symbol: 'checkErrorCodeDocs' },
      { path: 'packages/cli/src/error-unthrown.ts', symbol: 'declaredUnthrown' },
      { path: 'packages/cli/src/error-unthrown.ts', symbol: 'checkErrorCodesThrown' },
    ],
  },
  {
    ids: 'legacy OAuth handshake cookie',
    title: 'the pre-31.2 `__Host-x_oauth` handshake cookie is no longer read',
    change:
      'only `__Host-x_sso_<provider>` finishes a login; a handshake begun on a 31.1 pod across the upgrade deploy restarts',
    sources: [],
    removes: [
      {
        path: 'packages/auth/src/oauth-handshake-cookie.ts',
        symbol: 'LEGACY_HANDSHAKE_COOKIE_PREFIX',
      },
    ],
  },
  {
    ids: 'pwa never-wired',
    title: "the PWA's declared-and-never-wired precache fields removed",
    change:
      '`ServiceWorkerConfig.shellUrl` / `shellRevision` / `shellBytes` and `PwaRoute.dataUrl` go; `revision` and `bytes`, set by the prerender pass, are the fed pair',
    sources: [
      { path: 'packages/pwa/CLAUDE.md', anchor: 'carried as candidates for the next major' },
    ],
    removes: [
      { path: 'packages/pwa/src/service-worker.ts', symbol: 'shellUrl' },
      { path: 'packages/pwa/src/service-worker.ts', symbol: 'shellRevision' },
      { path: 'packages/pwa/src/service-worker.ts', symbol: 'shellBytes' },
      { path: 'packages/pwa/src/precache.ts', symbol: 'shellUrl' },
      { path: 'packages/pwa/src/precache.ts', symbol: 'shellRevision' },
      { path: 'packages/pwa/src/precache.ts', symbol: 'shellBytes' },
      { path: 'packages/pwa/src/strategies.ts', symbol: 'dataUrl' },
    ],
  },
  {
    ids: 'A7 realtime',
    title: 'dead exports leave `@ultimat3/realtime/server`',
    change:
      '`parseLsn`, `normalizePatch`, `patchFromChange`, `kvStream`, `kvSubject`, `decodeValue`, `changeSubject` and `actorIdOf` are no longer exported; the package keeps them internally',
    sources: [{ path: 'packages/realtime/src/server.ts', anchor: '  parseLsn,' }],
    removes: [
      { path: 'packages/realtime/src/changefeed.ts', symbol: 'parseLsn' },
      { path: 'packages/realtime/src/matcher-bridge.ts', symbol: 'normalizePatch' },
      { path: 'packages/realtime/src/matcher-bridge.ts', symbol: 'patchFromChange' },
      { path: 'packages/realtime/src/nats-jetstream.ts', symbol: 'kvStream' },
      { path: 'packages/realtime/src/nats-jetstream.ts', symbol: 'kvSubject' },
      { path: 'packages/realtime/src/pg-values.ts', symbol: 'decodeValue' },
      { path: 'packages/realtime/src/replicator-subject.ts', symbol: 'changeSubject' },
      { path: 'packages/realtime/src/socket.ts', symbol: 'actorIdOf' },
    ],
  },
  {
    ids: 'A7 db',
    title: '`recountSql` and `recountDriftSql` leave `@ultimat3/db`',
    change:
      'no longer exported; `x db recount` and the counter migration keep using them inside the package',
    sources: [],
    removes: [
      { path: 'packages/db/src/generate-counter.ts', symbol: 'recountSql' },
      { path: 'packages/db/src/generate-counter.ts', symbol: 'recountDriftSql' },
    ],
  },
  {
    ids: 'A7 admin',
    title: 'the individual dev panels leave `@ultimat3/admin/dev`',
    change:
      '`DEV_PANELS` and `devDashboard` are the one way to a panel; `cachePanel` … `timelinePanel` are no longer exported',
    sources: [],
    removes: [
      { path: 'packages/admin/src/dev/panel-cache.ts', symbol: 'cachePanel' },
      { path: 'packages/admin/src/dev/panel-db.ts', symbol: 'dbPanel' },
      { path: 'packages/admin/src/dev/panel-jobs.ts', symbol: 'jobsPanel' },
      { path: 'packages/admin/src/dev/panel-live.ts', symbol: 'livePanel' },
      { path: 'packages/admin/src/dev/panel-mail.ts', symbol: 'mailPanel' },
      { path: 'packages/admin/src/dev/panel-manifest.ts', symbol: 'manifestPanel' },
      { path: 'packages/admin/src/dev/panel-policy.ts', symbol: 'policyPanel' },
      { path: 'packages/admin/src/dev/panel-routes.ts', symbol: 'routesPanel' },
      { path: 'packages/admin/src/dev/panel-timeline.ts', symbol: 'timelinePanel' },
    ],
  },
];

/** A Known-Gaps row that parks its fix on `next`: each must be the source of a row above. */
export const PARKED_ON_NEXT = /(?:planned for|waits on|refusal on|lands on|flips on) `next`/;
