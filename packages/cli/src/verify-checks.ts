// What each named gate step actually checks, in cost order. Split from `cmd-verify.ts`, which is
// now the `x verify` command surface alone: the list is the definition of shippable and grows with
// the framework, while the command that runs it does not.

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { APP_CONFIG_FILE, ERROR_DOCS_URL } from '@ultimat3/core';
import { AGENTS_MD_FILENAME } from '@ultimat3/manifest';
import type { MetaIssue } from '@ultimat3/seo';
import { llmsDescriptionIssues, validateMeta } from '@ultimat3/seo';
import { checkAgentsMd } from './app-agents-md';
import { readAppSources } from './app-boundaries';
import { envExampleFindings } from './app-env';
import { loadApp } from './app-load';
import { appManifest } from './app-manifest';
import { policyFindings } from './app-permissions';
import { asyncPageFindings } from './async-pages';
import { appBoundaryFindings } from './boundary-findings';
import { checkBudgets, readBuildStats } from './budgets';
import { checkClientDrift } from './client-emit-drift';
import { checkDestructiveMigrations } from './db-destructive';
import { checkRollingMigrations } from './db-rolling';
import { checkUngeneratableMigrations } from './db-ungeneratable';
import { checkDocumentStyles, documentSurfaces } from './document-styles';
import { driftOutcome } from './drift-store';
import { checkErrorCodeResolution, checkErrorFixReport } from './error-contract';
import { withUnprovenFloor } from './exercise-floor-report';
import { guardReport, guardWarningLine } from './guards';
import { catalogFindings } from './i18n-registration';
import { isrQueryAdvice } from './isr-query-advice';
import { readJobBudgetFindings } from './job-budget';
import { unregisteredJobFindings } from './job-registration';
import { LINT_ARGV, lintOutcome } from './lint-findings';
import { liveRouteFindings } from './live-routes';
import { blockedByLoad, withLoadFindings } from './load-findings';
import {
  hasCommittedContract,
  manifestMissingFindings,
  manifestStaleness,
} from './manifest-staleness';
import { mcpLockFindings } from './mcp-lock-findings';
import { msg } from './messages';
import { checkLockHeavyMigrations } from './migration-lock-check';
import type { Finding } from './output';
import { retainUnsweptFindings } from './retain-sweep';
import { checkMigrationDrift } from './schema-drift';
import {
  checkSchemaDump,
  undeclaredIndexFindings,
  undeclaredIndexWarnings,
} from './schema-dump-drift';
import { cardRouteFindings } from './seo-cards';
import { scanSiteMeta } from './seo-meta';
import { quoteArg } from './shell-quote';
import { loadSiteSettings } from './site-config';
import { readStaticReport } from './static-report';
import { unknownToolGateFindings } from './tool-gate-names';
import { measureIfStale } from './verify-budgets-build';
import { contractDiffStep } from './verify-contract-diff';
import { nestedAppRootFindings } from './verify-drift-owner';
import { exerciseStep } from './verify-exercise';
import { floorProblemFindings, readVerifyFloor } from './verify-floor';
import { mcpMountFindings } from './verify-mcp-mount';
import { nativeFormWarnings } from './verify-native-form';
import { roleLoadFindings } from './verify-role-load';
import type { VerifyStep } from './verify-step';
import { fromExec, fromFindings, hostFindings } from './verify-step';
import { TEST_STEPS } from './verify-tests';
import { typecheckArgs } from './verify-typecheck';
import { checkPackageShape, fileSizeReport, hasWorkspacePackages } from './workspace-checks';
import { checkExternalDependencies } from './workspace-external-deps';
import { checkWorkspaceDependencies } from './workspace-graph';

/** The one file that makes the `roadmap` step answerable, and therefore what `applies` reads. */
const ROADMAP_FILE = join('docs', 'idea', '14-roadmap.md');

/** Where `exercise` joins the suites: directly after `job`, as `VERIFY_STEP_NAMES` holds it. */
const AFTER_JOB = TEST_STEPS.findIndex((step) => step.name === 'job') + 1;

/** The whole contract, in cost order. Every check the framework knows how to make lives here. */
export const VERIFY_STEPS: readonly VerifyStep[] = [
  {
    name: 'typecheck',
    summary: 'tsc -b across every project the root references, tsc -p . where it references none',
    // `typecheckBin` (`x.verify.json`, beside `agentsMdMaxBytes`) swaps the binary and nothing
    // else: same invocation, same output format to parse, same `X_TYPECHECK_FAILED` finding either
    // way. Absent means `tsc` — the only checker every app already has, since `typescript` is a
    // framework dependency and a drop-in replacement is the app's own devDependency to add, never
    // a default this step could assume. `-b` or `-p .` is `typecheckArgs`' call (#450).
    async run(ctx) {
      const floor = await readVerifyFloor(ctx.root);
      const argv = await typecheckArgs(ctx.root, floor?.typecheckBin ?? 'tsc');
      const result = await ctx.runner(['bunx', ...argv], { cwd: ctx.root });
      return fromExec(result, {
        code: 'X_TYPECHECK_FAILED',
        cause: 'the project does not typecheck',
        // Joined, never spliced: `typecheckBin` is a value from the app's `x.verify.json`.
        fix: ['bunx', ...argv.map(quoteArg)].join(' '),
      });
    },
  },
  {
    name: 'lint',
    // Only what biome actually enforces. It claimed "no default exports" while the rule was off
    // (it is not in `recommended`) and "no raw colours" over a file type biome ignores entirely —
    // two thirds of the line were enforced by nothing. `noDefaultExport` is now on in `biome.json`;
    // the colour rule is `packages/ui/src/tokens/tokens.test.ts`, and rides on the `unit` step.
    summary: 'biome: format, no any, no default exports, no unused imports',
    async run(ctx) {
      return lintOutcome(await ctx.runner(LINT_ARGV, { cwd: ctx.root }));
    },
  },
  {
    name: 'boundaries',
    summary:
      "surface, layer and package-tier imports, one browser transport, and the app's own guards",
    // An app's `guards/` rides here rather than becoming a step of its own, for the reason the
    // seam already states: a host adds findings to a step, it can never add, remove, reorder or
    // skip one — so "green" keeps meaning exactly what it meant. This is the step whose host slot
    // already carries "rules this repo makes about itself that the framework cannot know" (the
    // monorepo's tier table arrives through it), and it runs third, before any suite, so a
    // convention failure is reported in seconds rather than after the tests.
    //
    // Discovered, not registered: `guardFindings` reads the directory. A guard that had to
    // announce itself is a guard an app can forget to announce, which is the coupling axiom 8's
    // extension model rejects.
    //
    // ONE read of the app's surface files for the whole step: the import rules, the transport
    // rule and every guard are handed the same text. The guards used to walk and read the tree a
    // second time (`guard-sources.ts`).
    //
    // A report-only guard's findings ride as warnings, as the filesize band does: listed, never red.
    async run(ctx) {
      const sources = await readAppSources(ctx.root);
      const guards = await guardReport(ctx.root, sources);
      return {
        ...fromFindings([
          ...(await appBoundaryFindings(ctx.root, sources)),
          ...guards.findings,
          ...(await hostFindings(ctx, 'boundaries')),
        ]),
        ...(guards.warnings.length === 0
          ? {}
          : { warnings: guards.warnings.map(guardWarningLine) }),
      };
    },
  },
  {
    name: 'filesize',
    summary: 'one file, one job',
    // The band below the ceiling rides as warnings: listed in `--json` on a pass, never a failure.
    run: async (ctx) => {
      const { findings, warnings } = await fileSizeReport(ctx.root);
      return {
        ...fromFindings(findings),
        warnings: warnings.map(
          (warning) =>
            `${warning.path}: ${warning.lines} lines, ${warning.ceiling - warning.lines} under the ${warning.ceiling} line ceiling — plan the split`,
        ),
      };
    },
  },
  {
    name: 'package-shape',
    summary: 'every package ships the same contract files',
    applies: (ctx) => hasWorkspacePackages(ctx.root),
    // The dependency rule rides here rather than becoming a step of its own because it is this
    // step's own question — what does a workspace owe the repo it lives in? — asked of the
    // manifest's `dependencies` instead of its `files`. It is deliberately NOT inside
    // `checkPackageShape`: `scripts/release.ts --check` calls that one to ask whether the tree is
    // at the version a tag claims, and an undeclared import is not that question.
    run: async (ctx) =>
      fromFindings([
        ...(await checkPackageShape(ctx.root)),
        ...(await checkWorkspaceDependencies(ctx.root)),
        ...(await checkExternalDependencies(ctx.root)),
      ]),
  },
  {
    name: 'errors',
    summary: 'every X_* code has a runnable fix and a docs page',
    // The fix-line half runs anywhere source does. The docs half needs a reference page to check
    // against, and which file that is belongs to the host repo — hence `hostFindings`.
    //
    // The coverage line rides in `output`, which `--json` carries verbatim: a scan without a
    // parser cannot read every fix, and a step that reports only findings claims a completeness
    // it does not have. "checked 412, could not read 27" is what a reader can act on.
    async run(ctx) {
      const report = await checkErrorFixReport(ctx.root);
      // The third rule on this step, and the one that is about the code rather than the fix: a
      // `code:` reached through a name nothing in its own file declares is a code no reader of the
      // set can see — not the manifest, not the reference page's coverage rule, not
      // `x errors explain`. It runs here because it needs source and nothing else (#277).
      const findings = [
        ...report.findings,
        ...(await checkErrorCodeResolution(ctx.root)),
        ...(await hostFindings(ctx, 'errors')),
      ];
      return {
        ...fromFindings(findings),
        output: msg('cli.verify.fixCoverage', {
          checked: report.checked,
          unreadable: report.unreadable,
        }),
      };
    },
  },
  ...TEST_STEPS.slice(0, AFTER_JOB),
  // Every step that loads the app stands down while the load is red: the cause is `manifest`'s,
  // and what a half-filled registry looks like is not a finding (`load-findings.ts`).
  // The floor's verdict on the report the child wrote rides on the step (`exercise-floor-report.ts`).
  blockedByLoad(withUnprovenFloor(exerciseStep)),
  ...TEST_STEPS.slice(AFTER_JOB),
  blockedByLoad({
    name: 'drift',
    summary:
      'entity declarations vs migrations, every destructive statement declared, every statement no declaration carries, and the committed schema dump',
    // Only an app owns migrations; a package monorepo's `packages/db` is the driver, not a schema.
    // Source, not database: the gate runs in CI with nothing listening, and the database half is
    // the post-migrate verification `runMigrations` performs where a connection is already open.
    //
    // The destructive rail rides here rather than becoming a step of its own because it asks this
    // step's own question — do the committed migrations still describe what the app is doing to its
    // schema? — off the same directory, in the same pass, with no database either.
    applies: async (ctx) => existsSync(join(ctx.root, APP_CONFIG_FILE)),
    run: async (ctx) => {
      // Loaded first: the drivers the app's modules construct are what decide (`drift-store.ts`).
      await loadApp(ctx.root);
      // A store owning its own schema skips the five migration rails, never the client one.
      return driftOutcome(ctx.root, {
        schema: async () => [
          ...(await checkMigrationDrift(ctx.root)),
          ...(await checkDestructiveMigrations(ctx.root)),
          // Beside it, the same shape: a statement that stops a live table's writes for a full scan
          // must take the two-step form or say so. Judged only past `LOCK_HEAVY_SINCE`.
          ...(await checkLockHeavyMigrations(ctx.root)),
          // The third rail, and the one the other two cannot see: a hand-written statement is
          // recorded by no snapshot and hashed by no source, so both halves above are green over SQL
          // a squash silently drops. Same directory, same reader, no database — this step's own
          // question, which is why it is not a step of its own.
          ...(await checkUngeneratableMigrations(ctx.root)),
          // The fourth, and the only one that opens a database — a scratch embedded one it boots
          // itself, so CI still needs nothing listening: the committed `packages/db/schema/` against
          // what replaying the migrations produces, and that dump loaded back (`X_SCHEMA_DUMP_DRIFT`).
          ...(await checkSchemaDump(ctx.root, ctx.env ?? Bun.env)),
          // The fifth: what the previous release would trip over during a roll. Off until the app
          // sets `rollingSince` in `x.verify.json`, since an applied migration cannot gain a marker.
          ...(await checkRollingMigrations(ctx.root)),
          // The sixth: one migration owner. A nested `app.config.ts` is a second app root — its own
          // registry, migrations and image (`X_APP_ROOT_NESTED`, `verify-drift-owner.ts`).
          ...(await nestedAppRootFindings(ctx.root)),
        ],
        // Beside the schema rails, advice and not a verdict on `main`: an index the dump holds that
        // no snapshot or entity declares (`X_DB_INDEX_UNDECLARED`). `REFUSE_UNDECLARED_INDEX`
        // in `drift-store.ts` is the `next` switch that makes it a finding.
        advice: {
          findings: () => undeclaredIndexFindings(ctx.root),
          warnings: () => undeclaredIndexWarnings(ctx.root),
        },
        // The seventh: a generated client (`x client`) against its own stamp — a source document that
        // moved (`X_CLIENT_STALE`) or a body edited by hand (`X_CLIENT_EDITED`). No database.
        client: () => checkClientDrift(ctx.root),
      });
    },
  }),
  blockedByLoad(contractDiffStep),
  blockedByLoad({
    name: 'budgets',
    summary:
      'per-route JS bytes, the global style layer every document carries, and the routes that boot nothing to receive their live rows',
    // The global-style assertion rides here rather than becoming a step of its own, because this
    // step already asks the one question it asks: what does the document this build emits actually
    // contain? It is also the same app load — `appManifest` fills render's stylesheet registry on
    // its way through — so a separate step would pay for a second one to answer half a question.
    //
    // A repo with no `app.config.ts` is the framework monorepo, which renders no documents and has
    // no stylesheet registry to read; there is nothing for either half to weigh.
    applies: async (ctx) => existsSync(join(ctx.root, APP_CONFIG_FILE)),
    async run(ctx) {
      // No stats file is NOT "nothing to weigh" — it is every declared budget unmeasured. So the
      // step MEASURES first, whenever the stats are missing, of an earlier rule, or older than the
      // newest app source (`verify-budgets-build.ts`): `x verify` alone is the gate, on a fresh
      // tree too, and a heavier island is never weighed at the bytes of a build before it.
      //
      // Only then, never on every run: an unedited tree pays nothing, and a rebuild after an edit costs
      // one static build (8.2 s on `dummy/social-media-clone`, As of 2026-11). The builder is
      // `x build`, spawned through `ctx.runner` so it is a tagged child under this step's deadline
      // (`stepTimeoutMs.budgets` overrides). A failing build — `examples/dummy`'s old 5.9 s was a
      // hard `X_PRERENDER_FAILED` — is red under the build's own findings, unchanged. `SITE_ORIGIN`
      // shapes canonical and og:url, never script bytes, and the build writes `.x/verify-static`,
      // so a deployable `.x/static` built with the real origin is never replaced.
      // A failed build's findings stand in for the per-route weighing below, which would only
      // repeat them as `X_BUDGET_UNMEASURED` per route; the other riders still answer.
      const measured = await measureIfStale(ctx);
      const stats = await readBuildStats(ctx.root);
      // The report beside the stats, for the one thing `checkBudgets` reads off it: a route the
      // build rendered and could not weigh because its island was handed props over the cap is
      // reported under `X_ISLAND_PROPS_INVALID` — the build's own sentence, naming the prop and
      // its bytes — and not as an `X_BUDGET_UNMEASURED` whose fix is to go and read this file.
      const report = await readStaticReport(ctx.root);
      // Reached only over a clean load (`blockedByLoad`): a route a broken module never registered
      // is the load's finding on `manifest`, never one `X_BUDGET_UNMEASURED` per route here.
      const { manifest } = await appManifest(ctx.root);
      const outcome = fromFindings([
        ...checkDocumentStyles(documentSurfaces()),
        // The third rider, and the same question this step already asks one level down: what
        // JavaScript does this route's document boot? A live read with no island is a route
        // whose answer is "none", which no suite can fail on — the page renders, at 200.
        ...(await liveRouteFindings(ctx.root)),
        // The fourth: a data read in an async Page rather than in `load` (`async-pages.ts`).
        ...asyncPageFindings(),
        ...(measured.findings.length > 0
          ? measured.findings
          : checkBudgets(manifest, stats, report?.unmeasured)),
      ]);
      // What no build can weigh, said out loud rather than dropped (`measure-paths.ts`).
      const notes = (report?.unmeasured ?? [])
        .filter((one) => one.weighable === false)
        .map((one) => `not weighed: ${one.reason}`);
      const output = [measured.output, outcome.output, ...notes]
        .filter((line) => line !== undefined)
        .join('\n');
      return output === '' ? outcome : { ...outcome, output };
    },
  }),
  blockedByLoad({
    name: 'seo',
    summary: 'every indexable site/ route has a title and a description a search result can render',
    // The SEO checkers shipped in `@ultimat3/seo` with no caller anywhere — `validateMeta` and its
    // asserts were reachable only by an app that called them itself, which is what
    // `packages/seo/src/errors.ts`'s own header said. This is the caller.
    //
    // Its own step rather than a rider on `budgets`: that step asks what a document WEIGHS and
    // this one asks what it SAYS, and a missing `<title>` reported under `budgets` would hand the
    // reader a fix for the wrong question (axiom 4). It costs no second app load — `loadApp`
    // imports each module once per process, so this runs on the registries `budgets` just filled.
    applies: async (ctx) => existsSync(join(ctx.root, APP_CONFIG_FILE)),
    async run(ctx) {
      const scan = await scanSiteMeta(ctx.root);
      // No `baseUrl`: an app declares no base URL anywhere (`packages/core/src/config.ts` has no
      // such key), so canonical checks are skipped rather than run against an origin this file
      // invented. `seo-meta.ts` spells out why that is the honest half.
      const report = validateMeta(scan.records);
      // `/llms.txt` lists these pages by description: while it is on, a page without one is red.
      const llms =
        (await loadSiteSettings(ctx.root)).llms === false
          ? []
          : llmsDescriptionIssues(scan.records);
      // The scan filled the route table, so the advice costs no second load. Rides here because
      // this is the step about public, shared-cache pages; it never fails it.
      const warnings = await isrQueryAdvice(ctx.root);
      // A declared `og.capture` that names no site/ route: the card convention's build error.
      const cards = cardRouteFindings(scan.records);
      return {
        ok: scan.findings.length === 0 && report.ok && llms.length === 0 && cards.length === 0,
        findings: [...scan.findings, ...[...report.issues, ...llms].map(seoFinding), ...cards],
        ...(warnings.length === 0 ? {} : { warnings }),
      };
    },
  }),
  blockedByLoad({
    name: 'i18n',
    summary: 'every string this app renders resolves — in the catalogs AND in the registry',
    // Its own step rather than a rider on `boundaries`, by that step's own test: a rider must ask
    // the SAME question off the same data, and "did this import cross a line?" is not "did this
    // declaration reach the running app?". Reported under `boundaries`, `X_CATALOG_UNREGISTERED`
    // would send a reader to the import graph for a bug that lives in the boot path (axiom 4).
    //
    // Both halves, because they are one question and both ship the same `⟦key⟧` to a user: a key
    // missing from a locale's catalog, and a catalog no module ever registered. `x i18n check`
    // reports exactly these findings from exactly this call, so the command and the gate cannot
    // disagree about an app.
    //
    // Beside `seo` and after `budgets` for the reason `seo` gives: `loadApp` imports each module
    // once per process, so this runs on the registries `budgets` just filled and pays for no
    // second load. A repo with no `app.config.ts` is the framework monorepo, which registers no
    // app catalogs — SKIPPED there, never passed, because a step that answers `ok` about nothing
    // is the vacuous green this check exists to refuse.
    applies: async (ctx) => existsSync(join(ctx.root, APP_CONFIG_FILE)),
    run: async (ctx) => fromFindings(await catalogFindings(ctx.root)),
  }),
  blockedByLoad({
    name: 'policy',
    summary: 'every permission this app grants or requires is one it declares',
    // A repo with no `app.config.ts` is the framework monorepo, which declares no roles and
    // registers no routes — SKIPPED there, never passed, for the reason `i18n` gives: a step that
    // answers `ok` about nothing is the vacuous green these checks exist to refuse.
    applies: async (ctx) => existsSync(join(ctx.root, APP_CONFIG_FILE)),
    run: async (ctx) => fromFindings(await policyFindings(ctx.root)),
  }),
  {
    name: 'manifest',
    summary: 'the files an agent reads: generated facts, hand-written conventions, the env example',
    // No `applies`. The drift half has nothing to compare against until `x manifest` has run
    // once, and says so by finding nothing — but `AGENTS.md` is required of every repo the gate
    // runs in, so the step always has a question to answer and must never report as skipped.
    //
    // `.env.example` joins this step rather than becoming one of its own: the question is the same
    // one — "does a committed, generated file still describe the code?" — and the step list is the
    // definition of shippable, so it grows only when a genuinely new question needs asking.
    //
    // `x.verify.json` is here for that same question and no other: this step judges the floor
    // FILE, `runVerify` judges the suites against it. A name the gate does not run can never
    // vanish, so a typo in the floor covers nothing — which is the false green the floor exists to
    // close, and it is only visible if something reads the file for its own sake.
    async run(ctx) {
      // The floor is read FIRST: it is where a repository declares its own `AGENTS.md` budget,
      // and reading it after the check would enforce the default on a repo that raised it.
      const floor = await readVerifyFloor(ctx.root);
      const agents = await checkAgentsMd(ctx.root, floor?.agentsMdMaxBytes);
      // The app's load failures, once, here — every other step that loaded it points at this one.
      const app = existsSync(join(ctx.root, APP_CONFIG_FILE));
      // Started first and awaited last: it is a child process, and it runs beside the rest.
      const roleLoad = app ? roleLoadFindings(ctx.root, ctx.runner) : Promise.resolve([]);
      const drift = await driftFindings(ctx.root);
      // Every `mcpTools()` against `tools.lock.json`: the `x mcp lock --check` of each, at once.
      const remote = app ? await mcpLockFindings(ctx.root) : { findings: [], warnings: [] };
      const findings = [
        ...(app ? await withLoadFindings(ctx.root, drift) : drift),
        // An app only: the framework monorepo declares no `defineApi`, so it has no list to be in.
        ...(existsSync(join(ctx.root, APP_CONFIG_FILE))
          ? [
              ...(await unregisteredJobFindings(ctx.root)),
              ...(await retainUnsweptFindings(ctx.root)),
              ...(await readJobBudgetFindings(ctx.root)),
              // `ai.mcp.expose: true` and no mounted `POST /mcp`: what every boot only logged.
              ...(await mcpMountFindings(ctx.root)),
              ...(await unknownToolGateFindings(ctx.root)),
              ...remote.findings,
            ]
          : []),
        // What a worker never registers: a declaration beside a component the API index does not
        // import (`verify-role-load.ts`). The boot checks jobs and tasks only, and only at boot.
        ...(await roleLoad),
        ...(await envExampleFindings(ctx.root)),
        ...floorProblemFindings(floor),
        ...agents.findings,
        ...(await hostFindings(ctx, 'manifest')),
      ];
      // Warnings are not findings: `AGENTS.md` tabulating a route table is a smell a human
      // judges, not a build error. They ride in `output`, which `--json` carries verbatim.
      const output = [
        ...agents.warnings.map((warning) => `${AGENTS_MD_FILENAME}: ${warning}`),
        ...remote.warnings,
      ];
      // A page's `<form method="post">` to an action with no `native`: a JSON dead end. Advice on
      // `main` — refusing it would redden an app that passed yesterday (X_BREAKING_ON_MAIN).
      const warnings = app ? await nativeFormWarnings(ctx.root) : [];
      return {
        ok: findings.length === 0,
        findings,
        ...(output.length === 0 ? {} : { output: output.join('\n') }),
        ...(warnings.length === 0 ? {} : { warnings }),
      };
    },
  },
  {
    name: 'roadmap',
    summary: "every roadmap milestone's status marker matches what is actually on disk",
    // A generated app ships no `docs/idea/14-roadmap.md` — only the framework monorepo does, so
    // the FILE is what decides. It keyed on `ctx.hostChecks?.roadmap` until `As of 2026-08`, which
    // is a fact about the CALL: a caller of the exported `runVerify(VERIFY_STEPS, ctx)` passing no
    // `hostChecks`, in a repo whose committed `x.verify.json` names `roadmap`, got
    // `X_VERIFY_SUITE_VANISHED` — whose `fix:` is the command that had just failed.
    applies: async (ctx) => existsSync(join(ctx.root, ROADMAP_FILE)),
    run: async (ctx) => fromFindings(await hostFindings(ctx, 'roadmap')),
  },
];

/**
 * The committed generated files against the code — `x manifest --check`'s check, through its
 * function. With no committed contract there is nothing to load an app for: an app root is told
 * its manifest is missing, and the framework monorepo (which has neither file) is told nothing.
 */
async function driftFindings(root: string): Promise<readonly Finding[]> {
  if (!hasCommittedContract(root)) return manifestMissingFindings(root);
  const { manifest, findings } = await appManifest(root);
  return [...findings, ...(await manifestStaleness(root, manifest))];
}

/**
 * One `MetaIssue` as the gate reports it. `at` is the route FILE and never the URL: every seo error
 * already names the file in its cause, and `at` is what an agent opens.
 */
const seoFinding = (issue: MetaIssue): Finding => ({
  code: issue.code,
  cause: issue.cause,
  fix: issue.fix,
  docs: ERROR_DOCS_URL,
  at: issue.file,
});
