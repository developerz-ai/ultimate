// Every break parked for `next` (wiki/Stability.md), one row each, with the plan and ledger lines
// that parked it. Anchors, not line numbers: `scripts/next-breaks.ts` resolves each to `file:line`
// on every run and refuses one that no longer matches exactly one line.

/** A line that records the break: `anchor` is a substring of exactly one line of `path`. */
export interface BreakSource {
  readonly path: string;
  readonly anchor: string;
}

export interface ParkedBreak {
  /** The plan item ids that name it, as the plans spell them. */
  readonly ids: string;
  readonly title: string;
  /** What changes for an app the day `next` merges. */
  readonly change: string;
  readonly sources: readonly BreakSource[];
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
];

/** A Known-Gaps row that parks its fix on `next`: each must be the source of a row above. */
export const PARKED_ON_NEXT = /(?:planned for|waits on|refusal on|lands on|flips on) `next`/;
