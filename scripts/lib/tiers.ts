// The import-boundary table from the build contract, as data, and BOTH rules it carries: a package
// may import only from a strictly lower tier (the ceiling), and may not sit above the lowest tier
// its own imports allow without a written reason (the floor).
// This is axiom 3: a convention that is not a build error does not exist.

import type { Finding } from './log';

// The contract's table is the first name in each row; `db`, `storage`, `auth` and `mail` are
// packages the repo grew afterwards, placed at the lowest tier their real imports allow. That
// placement is CHECKED, as of 2026-08-22: `checkFloors` below reads the edges `boundaries.ts`
// collects and refuses a package above its floor with no row in `FLOOR_ABOVE`. This comment said
// "checked by this file's own rule" while no such rule existed anywhere, and the boundary checker
// enforced the ceiling only. Adding a package here is a deliberate act: an import of a package
// that is not listed is a build error, never a shrug.
export const TIERS: Readonly<Record<number, readonly string[]>> = {
  0: ['core', 'schema'],
  1: ['i18n', 'money', 'time', 'cache', 'seo', 'db', 'storage', 'flags'],
  2: ['entity', 'policy', 'http', 'auth'],
  3: ['action', 'query', 'jobs', 'realtime'],
  4: ['render', 'pwa', 'mcp', 'ai', 'manifest', 'mail', 'ui'],
  5: ['admin', 'testing', 'cli', 'scraping'],
};

/**
 * Declared sideways edges — the contract allows same-tier imports only when they are listed, and
 * each of these earns its line.
 *
 * `admin -> ui` used to be here and is GONE, because it was never about composition: `ui` imports
 * `core`, `i18n`, `money` and `time`, so tier 2 is the lowest its real imports allow and tier 5
 * was two tiers too high. The exception existed only to undo that placement. `ui` sits at 4 rather
 * than at its floor for a reason of its own, stated once in `FLOOR_ABOVE` below and not repeated
 * here. An exception line in an enforcement table is a rule with a hole in it; deleting the hole
 * beats arguing for it.
 *
 * | Edge | Why it is not a lower-tier extraction |
 * |---|---|
 * | `realtime -> query` | tier 3 is one feature: a live query is a query plus a subscription, and splitting it would duplicate the SQL shape |
 * | `create-ultimate -> cli` | a published shim whose whole job is to call `x new`; the alternative is a second copy of the templates |
 * | `cli -> admin` | `x dev` MOUNTS the `/_x` dashboard, it does not reimplement it; the panels are a product of the same tier, and the alternative is a second dev dashboard living in the CLI |
 * | `cli -> scraping` | `x shot` drives a real browser, and `@ultimat3/scraping` is the one package that can: it declares the CDP library's shape structurally (`cdp-port.ts`) and takes no runtime dependency, so the CLI passes the app's own `puppeteer` in. Moving `scraping` down to 4 would have removed the need for this line and is REFUSED: `packages/scraping/CLAUDE.md` places it at 5 deliberately, reserving room for `recover: 'agent'` to import `@ultimat3/ai` (tier 4), and a package at 4 cannot import a package at 4. That file predicted this edge before anything imported the package |
 * | `cli -> testing` | `@ultimat3/testing` IS the framework's harness, and `serve.live.test.ts` spawns the scaffolded `server.ts` as a child and has to let one real port through the seal. It was already live as `../../testing/src/sealed-network` — a relative specifier the checker could not see — and the alternatives are worse: core's `markListening()` would announce a socket a CHILD opened, and a second unseal in the CLI is a second sealed-network |
 */
export const SIDEWAYS_ALLOW: Readonly<Record<string, readonly string[]>> = {
  realtime: ['query'],
  cli: ['admin', 'scraping', 'testing'],
  'create-ultimate': ['cli'],
};

/**
 * Packages that sit ABOVE the lowest tier their shipped imports allow, each with the sentence that
 * earns the position. `boundaries.ts` computes the floor and refuses a package above it with no row
 * here — and refuses a row whose reason is blank, because "there was a reason" is the documentation
 * axiom 3 says does not exist.
 *
 * Every reason states what MOVING THE PACKAGE DOWN WOULD LEGALISE, never why the current tier feels
 * right: a floor exception is worth a line only when the tier itself is enforcing something. The
 * five rows here are the whole list `As of 2026-08-22`, and none of them was invented for the rule
 * — each is a sentence one of the package `CLAUDE.md` files already carried.
 *
 * `Object.freeze<Record<…>>({…})`, never an annotated literal: `scripts/frozen-records.ts`.
 */
export const FLOOR_ABOVE = Object.freeze<Record<string, string>>({
  policy:
    'Tier 2 is the only thing making `entity -> policy`, `http -> policy` and `auth -> policy` ' +
    'build errors. All three mirror what they need of policy STRUCTURALLY instead and say so in ' +
    'their own CLAUDE.md — http through `ServerHooks.authorize` (hooks.ts), auth through ' +
    '`PolicyActorFields` (policy-bridge.ts), entity by naming policy as same-tier — and ' +
    '@ultimat3/action (tier 3) is the one package that wires `evaluate()` in. Below tier 2 all ' +
    'three become ordinary downward imports and "never add a second authz path" is prose again.',
  pwa:
    'Held LEVEL with `render` so neither can import the other. `PwaRoute` is a structural view of ' +
    "render's `RouteDescriptor` and both CLAUDE.md files name the other as never-import, but only " +
    'the shared tier enforces the `render -> pwa` half — the other half is upward from anywhere. ' +
    'Below tier 4 `render -> pwa` becomes an ordinary downward import and the service-worker ' +
    'generator joins the static bundle graph, which is axiom 6.',
  render:
    'The other half of that pair. Below tier 4 `pwa -> render` becomes an ordinary downward ' +
    'import, and `packages/pwa/CLAUDE.md`\'s "Never import render" — the rule that keeps ' +
    '`PwaRoute` a structural view rather than a re-export of the route table — would have nothing ' +
    'enforcing it.',
  scraping:
    "Tier 5 reserves room for `recover: 'agent'` to import @ultimat3/ai (tier 4), which a package " +
    'AT tier 4 could not do. `packages/scraping/CLAUDE.md` wrote that before anything imported ' +
    'this package, and the declared `cli -> scraping` edge above is the price the position ' +
    'charges — paid deliberately rather than by moving the package down to 4.',
  ui:
    'Held LEVEL with `render` so `render -> ui` stays refused (both at 4): the static bundle graph ' +
    'may not reach the design system, which is axiom 6 and what `packages/render/CLAUDE.md` ' +
    'requires. Its floor is tier 2 (`core`, `schema`, `i18n`, `money`, `time`), and the ' +
    '`admin -> ui` exception that used to undo that placement was deleted on 2026-08-19 rather ' +
    'than widened.',
});

export const TIER_OF: ReadonlyMap<string, number> = new Map(
  Object.entries(TIERS).flatMap(([tier, packages]) =>
    packages.map((name): [string, number] => [name, Number.parseInt(tier, 10)]),
  ),
);

/** A package no table places. Nothing may import it, and it may import nothing but its edges. */
export const UNLISTED_TIER = 6;

/**
 * Above tier 5, deliberately rather than by fallback. `create-ultimate` resolved to
 * `UNLISTED_TIER` because it is absent from `TIERS`, and a tier of 6 makes every one of the 29
 * framework packages a legal LOWER-tier import — so the `create-ultimate -> cli` edge the doc
 * block above presents as earning its line restricted nothing at all. It stays out of `TIERS`
 * because that map is the prose table's executable copy (`tier-table-drift.test.ts` asserts them
 * row for row) and this package is not a row of it.
 */
export const ABOVE_TABLE: Readonly<Record<string, number>> = { 'create-ultimate': 6 };

/**
 * Packages whose ONLY permitted imports are their declared `SIDEWAYS_ALLOW` edges — no tier range
 * at all. `create-ultimate`'s whole job is to call `x new`; anything else it reaches for is a
 * second copy of something `@ultimat3/cli` already owns.
 */
export const EDGE_ONLY_PACKAGES: ReadonlySet<string> = new Set(['create-ultimate']);

export const tierOf = (packageName: string): number =>
  TIER_OF.get(packageName) ?? ABOVE_TABLE[packageName] ?? UNLISTED_TIER;

/** Takes the TIER, not the package name: a package being scaffolded is not in the table yet, so
 * resolving its name here answered `0-5` for every new package regardless of `--tier`. */
export const allowedTiersFor = (tier: number): string => `0-${Math.max(tier - 1, 0)}`;

/** What a package may import, as one phrase for a finding. An edge-only package has no range. */
export const allowedImportsFor = (packageName: string): string =>
  EDGE_ONLY_PACKAGES.has(packageName)
    ? `only ${(SIDEWAYS_ALLOW[packageName] ?? []).map((edge) => `@ultimat3/${edge}`).join(', ')}`
    : allowedTiersFor(tierOf(packageName));

export interface TierCheck {
  readonly allowed: boolean;
  readonly reason:
    | 'lower-tier'
    | 'declared-sideways'
    | 'same-tier'
    | 'upward'
    | 'edge-only'
    | 'unknown-package';
}

/** The whole rule, in one place: lower is fine, listed sideways is fine, everything else is not. */
export function checkTier(from: string, to: string): TierCheck {
  if (!TIER_OF.has(to) && SIDEWAYS_ALLOW[from]?.includes(to) !== true) {
    return { allowed: false, reason: 'unknown-package' };
  }
  if (SIDEWAYS_ALLOW[from]?.includes(to) === true) {
    return { allowed: true, reason: 'declared-sideways' };
  }
  if (EDGE_ONLY_PACKAGES.has(from)) return { allowed: false, reason: 'edge-only' };
  const fromTier = tierOf(from);
  const toTier = tierOf(to);
  if (toTier < fromTier) return { allowed: true, reason: 'lower-tier' };
  if (toTier === fromTier) return { allowed: false, reason: 'same-tier' };
  return { allowed: false, reason: 'upward' };
}

export const ALL_PACKAGES: readonly string[] = Object.values(TIERS).flat();

/**
 * The lowest tier a package's own imports allow: one above the highest tier it reaches. A DECLARED
 * sideways edge is excluded — `realtime -> query` is same-tier by construction, so counting it
 * would compute a floor no package could ever sit at and turn every declared edge into a demand to
 * move the package that holds it.
 *
 * A specifier naming no package in the table contributes nothing; the ceiling rule already reports
 * that as `unknown-package`, and two reports of one condition is the duplication this repo forbids.
 */
export function floorFor(packageName: string, imports: Iterable<string>): number {
  const sideways = new Set(SIDEWAYS_ALLOW[packageName] ?? []);
  let floor = 0;
  for (const target of imports) {
    if (target === packageName || sideways.has(target) || !TIER_OF.has(target)) continue;
    floor = Math.max(floor, tierOf(target) + 1);
  }
  return floor;
}

export type FloorFault =
  /** Above its floor, and `FLOOR_ABOVE` says nothing about it. */
  | 'undeclared'
  /** Above its floor with a row that states no reason — the shape "we'll write it later" takes. */
  | 'blank-reason'
  /** A row for a package that is AT its floor, or for a name the tier table does not carry. */
  | 'stale-row';

export interface FloorViolation {
  readonly package: string;
  readonly tier: number;
  readonly floor: number;
  readonly fault: FloorFault;
}

/**
 * Pure, like `checkTier`: the caller does the scanning and hands the table in, so the blank-reason
 * and stale-row branches are fixtures rather than an edit to the shipped one. `edges` is package ->
 * the framework packages it imports, over the SAME file set the ceiling rule judges, tests included. Test files
 * are deliberately in: excluding them drops `realtime`'s only `entity` edge and would demand a
 * written reason for a package whose shipped tier is exactly its floor.
 */
export function checkFloors(
  edges: ReadonlyMap<string, ReadonlySet<string>>,
  declared: Readonly<Record<string, string>>,
): readonly FloorViolation[] {
  const violations: FloorViolation[] = [];
  for (const name of ALL_PACKAGES) {
    // A package the scan never saw has an UNKNOWN floor, never a floor of 0. Judging it anyway
    // made every rule here a statement about the scan's coverage: `tierBoundaries` run against a
    // fixture directory holding one file reported 22 packages as sitting above a floor computed
    // from no evidence at all. The ceiling rule goes silent on the same input, for the same reason.
    const own = edges.get(name);
    if (own === undefined) continue;
    const floor = floorFor(name, own);
    const tier = tierOf(name);
    const reason = declared[name];
    if (tier > floor) {
      if (reason === undefined)
        violations.push({ package: name, tier, floor, fault: 'undeclared' });
      else if (reason.trim() === '') {
        violations.push({ package: name, tier, floor, fault: 'blank-reason' });
      }
      continue;
    }
    if (reason !== undefined) violations.push({ package: name, tier, floor, fault: 'stale-row' });
  }
  for (const name of Object.keys(declared)) {
    if (TIER_OF.has(name)) continue;
    violations.push({ package: name, tier: tierOf(name), floor: 0, fault: 'stale-row' });
  }
  return violations;
}

export const TIERS_FILE = 'scripts/lib/tiers.ts';

/** One edit per fault, and never "raise the floor": the floor is derived, so the only two moves
 * are writing the sentence or moving the package. */
export function floorFindingFor(violation: FloorViolation): Finding {
  if (violation.fault === 'stale-row') {
    // A row for a name the table does not carry is the same fault as a row for a package at its
    // floor — a waiver protecting nothing — but it is a different sentence, and a `fix:` that
    // describes the wrong one is half an instruction. Deleting is right either way: if the package
    // it MEANT is above its floor, the undeclared rule says so on the next run, by name.
    const why =
      violation.tier === UNLISTED_TIER
        ? 'names no package in the tier table'
        : `sits at tier ${violation.tier}, the lowest its own imports allow`;
    return {
      code: 'X_TIER_FLOOR_STALE',
      cause:
        `FLOOR_ABOVE keeps a row for "${violation.package}" that ${why} — a waiver for a ` +
        'position nothing holds reads as a rule still in force',
      fix: `delete the "${violation.package}" row from FLOOR_ABOVE in ${TIERS_FILE}`,
      at: TIERS_FILE,
    };
  }
  const missing =
    violation.fault === 'blank-reason'
      ? 'its FLOOR_ABOVE row states no reason'
      : 'FLOOR_ABOVE has no row for it';
  return {
    code: 'X_TIER_FLOOR_UNDECLARED',
    cause:
      `${violation.package} sits at tier ${violation.tier} and its own imports allow tier ` +
      `${violation.floor} — ${missing}`,
    fix:
      `write the "${violation.package}" row in FLOOR_ABOVE in ${TIERS_FILE}, saying what moving ` +
      `it to tier ${violation.floor} would LEGALISE, or move it to tier ${violation.floor} in ` +
      'TIERS and in the two prose tables scripts/tier-table-drift.test.ts pins (CLAUDE.md, ' +
      'docs/architecture/01-package-map.md)',
    at: TIERS_FILE,
  };
}
