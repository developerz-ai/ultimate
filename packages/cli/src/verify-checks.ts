// What each named gate step actually checks, in cost order. Split from `cmd-verify.ts`, which is
// now the `x verify` command surface alone: the list is the definition of shippable and grows with
// the framework, while the command that runs it does not.

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { ERROR_DOCS_URL } from '@ultimat3/core';
import type { Manifest } from '@ultimat3/manifest';
import {
  AGENTS_MD_FILENAME,
  assertNoDrift,
  MANIFEST_FILENAME,
  verifyContract,
} from '@ultimat3/manifest';
import type { MetaIssue } from '@ultimat3/seo';
import { validateMeta } from '@ultimat3/seo';
import { checkAgentsMd } from './app-agents-md';
import { checkAppBoundaries } from './app-boundaries';
import { envExampleFindings } from './app-env';
import { appManifest, readAppManifest } from './app-manifest';
import { OPENAPI_FILE, openApiJson } from './app-openapi';
import { policyFindings } from './app-permissions';
import { APP_CONFIG_FILE } from './app-root';
import { checkBudgets, readBuildStats } from './budgets';
import { checkDestructiveMigrations } from './db-destructive';
import { checkUngeneratableMigrations } from './db-ungeneratable';
import { checkDocumentStyles, documentSurfaces } from './document-styles';
import { checkErrorCodeResolution, checkErrorFixReport } from './error-contract';
import { guardFindings } from './guards';
import { catalogFindings } from './i18n-registration';
import { liveRouteFindings } from './live-routes';
import { msg } from './messages';
import type { Finding } from './output';
import { findingFrom } from './output';
import { checkMigrationDrift } from './schema-drift';
import { scanSiteMeta } from './seo-meta';
import { floorProblemFindings, readVerifyFloor } from './verify-floor';
import type { VerifyStep } from './verify-step';
import { fromExec, fromFindings, hostFindings } from './verify-step';
import { TEST_STEPS } from './verify-tests';
import { checkFileSizes, checkPackageShape, hasWorkspacePackages } from './workspace-checks';
import { checkWorkspaceDependencies } from './workspace-graph';

/** The one file that makes the `roadmap` step answerable, and therefore what `applies` reads. */
const ROADMAP_FILE = join('docs', 'idea', '14-roadmap.md');

/** The whole contract, in cost order. Every check the framework knows how to make lives here. */
export const VERIFY_STEPS: readonly VerifyStep[] = [
  {
    name: 'typecheck',
    summary: 'tsc -b across every project the root references',
    async run(ctx) {
      const result = await ctx.runner(['bunx', 'tsc', '-b', '--pretty', 'false'], {
        cwd: ctx.root,
      });
      return fromExec(result, {
        code: 'X_TYPECHECK_FAILED',
        cause: 'the project does not typecheck',
        fix: 'bunx tsc -b --pretty false',
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
      const result = await ctx.runner(['bunx', 'biome', 'check', '.'], { cwd: ctx.root });
      return fromExec(result, {
        code: 'X_LINT_FAILED',
        cause: 'biome reported problems',
        fix: 'bunx biome check --write .',
      });
    },
  },
  {
    name: 'boundaries',
    summary: "surface, layer and package-tier imports, and the app's own guards",
    // An app's `guards/` rides here rather than becoming an eighteenth step, for the reason the
    // seam already states: a host adds findings to a step, it can never add, remove, reorder or
    // skip one — so "green" keeps meaning exactly what it meant. This is the step whose host slot
    // already carries "rules this repo makes about itself that the framework cannot know" (the
    // monorepo's tier table arrives through it), and it runs third, before any suite, so a
    // convention failure is reported in seconds rather than after the tests.
    //
    // Discovered, not registered: `guardFindings` reads the directory. A guard that had to
    // announce itself is a guard an app can forget to announce, which is the coupling axiom 8's
    // extension model rejects.
    run: async (ctx) =>
      fromFindings([
        ...(await checkAppBoundaries(ctx.root)),
        ...(await guardFindings(ctx.root)),
        ...(await hostFindings(ctx, 'boundaries')),
      ]),
  },
  {
    name: 'filesize',
    summary: 'one file, one job',
    run: async (ctx) => fromFindings(await checkFileSizes(ctx.root)),
  },
  {
    name: 'package-shape',
    summary: 'every package ships the same contract files',
    applies: (ctx) => hasWorkspacePackages(ctx.root),
    // The dependency rule rides here rather than becoming a twentieth step because it is this
    // step's own question — what does a workspace owe the repo it lives in? — asked of the
    // manifest's `dependencies` instead of its `files`. It is deliberately NOT inside
    // `checkPackageShape`: `scripts/release.ts --check` calls that one to ask whether the tree is
    // at the version a tag claims, and an undeclared import is not that question.
    run: async (ctx) =>
      fromFindings([
        ...(await checkPackageShape(ctx.root)),
        ...(await checkWorkspaceDependencies(ctx.root)),
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
  ...TEST_STEPS,
  {
    name: 'drift',
    summary:
      'entity declarations vs migrations, every destructive statement declared, and every statement no declaration carries',
    // Only an app owns migrations; a package monorepo's `packages/db` is the driver, not a schema.
    // Source, not database: the gate runs in CI with nothing listening, and the database half is
    // the post-migrate verification `runMigrations` performs where a connection is already open.
    //
    // The destructive rail rides here rather than becoming an eighteenth step because it asks this
    // step's own question — do the committed migrations still describe what the app is doing to its
    // schema? — off the same directory, in the same pass, with no database either.
    applies: async (ctx) => existsSync(join(ctx.root, APP_CONFIG_FILE)),
    run: async (ctx) =>
      fromFindings([
        ...(await checkMigrationDrift(ctx.root)),
        ...(await checkDestructiveMigrations(ctx.root)),
        // The third rail, and the one the other two cannot see: a hand-written statement is
        // recorded by no snapshot and hashed by no source, so both halves above are green over SQL
        // a squash silently drops. Same directory, same reader, no database — this step's own
        // question, which is why it is not an eighteenth step.
        ...(await checkUngeneratableMigrations(ctx.root)),
      ]),
  },
  {
    name: 'contract-diff',
    summary: 'the published contract vs the committed manifest',
    // Either file is a published contract on its own: `openapi.json` generates the typed client,
    // so gating on the manifest alone let a stale spec ship a wrong client unchecked.
    applies: async (ctx) =>
      existsSync(join(ctx.root, MANIFEST_FILENAME)) || existsSync(join(ctx.root, OPENAPI_FILE)),
    async run(ctx) {
      const committed = await readAppManifest(ctx.root);
      const { manifest, findings } = await appManifest(ctx.root);
      return fromFindings([
        ...findings,
        ...(committed === undefined ? [] : contractFindings(committed, manifest)),
        ...(await specFindings(ctx.root, manifest)),
      ]);
    },
  },
  {
    name: 'budgets',
    summary:
      'per-route JS bytes and LCP, the global style layer every document carries, and the routes that boot nothing to receive their live rows',
    // The global-style assertion rides here rather than becoming an eighteenth step, because this
    // step already asks the one question it asks: what does the document this build emits actually
    // contain? It is also the same app load — `appManifest` fills render's stylesheet registry on
    // its way through — so a separate step would pay for a second one to answer half a question.
    //
    // A repo with no `app.config.ts` is the framework monorepo, which renders no documents and has
    // no stylesheet registry to read; there is nothing for either half to weigh.
    applies: async (ctx) => existsSync(join(ctx.root, APP_CONFIG_FILE)),
    async run(ctx) {
      // No stats file is NOT "nothing to weigh" — it is every declared budget unmeasured, which is
      // the case `checkBudgets` already names per route (`X_BUDGET_UNMEASURED`). Skipping the half
      // entirely is how a step that has never run once reported green: `.x/` is gitignored, so no
      // CI run and neither gated app has ever had a `build-stats.json` for it to read.
      //
      // Handed over as `undefined` and never as `?? { routes: [] }`: "no build has run here" and
      // "a build ran and could not weigh this route" are two different instructions, and only the
      // caller knows which of them is true. The step still does not BUILD — measuring here would
      // make `x verify` a static build on every run (8.2s on `dummy/social-media-clone`, and 5.9s
      // to a hard `X_PRERENDER_FAILED` on `examples/dummy`), and it would be a second builder
      // beside `apps/web/prerender.ts`, which is where an app reads `SITE_ORIGIN`.
      const stats = await readBuildStats(ctx.root);
      // The load's own findings, FIRST and never dropped. A module that would not import registers
      // no route, so its budget is missing from the manifest and every route it declared reads as
      // `X_BUDGET_UNMEASURED` — the symptom, pointing the reader at `x build` for a file that will
      // not compile. `contract-diff` reports these too when it applies; two red steps naming one
      // broken module is honest, and one of them silently green over it is the false green.
      const { manifest, findings } = await appManifest(ctx.root);
      return fromFindings([
        ...findings,
        ...checkDocumentStyles(documentSurfaces()),
        // The third rider, and the same question this step already asks one level down: what
        // JavaScript does this route's document boot? A live read with no island is a route
        // whose answer is "none", which no suite can fail on — the page renders, at 200.
        ...(await liveRouteFindings(ctx.root)),
        ...checkBudgets(manifest, stats),
      ]);
    },
  },
  {
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
      return {
        ok: scan.findings.length === 0 && report.ok,
        findings: [...scan.findings, ...report.issues.map(seoFinding)],
      };
    },
  },
  {
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
  },
  {
    name: 'policy',
    summary: 'every permission this app grants or requires is one it declares',
    // A repo with no `app.config.ts` is the framework monorepo, which declares no roles and
    // registers no routes — SKIPPED there, never passed, for the reason `i18n` gives: a step that
    // answers `ok` about nothing is the vacuous green these checks exist to refuse.
    applies: async (ctx) => existsSync(join(ctx.root, APP_CONFIG_FILE)),
    run: async (ctx) => fromFindings(await policyFindings(ctx.root)),
  },
  {
    name: 'manifest',
    summary: 'the files an agent reads: generated facts, hand-written conventions, the env example',
    // No `applies`. The drift half has nothing to compare against until `x manifest` has run
    // once, and says so by finding nothing — but `AGENTS.md` is required of every repo the gate
    // runs in, so the step always has a question to answer and must never report as skipped.
    //
    // `.env.example` joins this step rather than becoming an eighteenth: the question is the same
    // one — "does a committed, generated file still describe the code?" — and the step list is the
    // definition of shippable, so it grows only when a genuinely new question needs asking.
    //
    // `x.verify.json` is here for that same question and no other: this step judges the floor
    // FILE, `runVerify` judges the suites against it. A name the gate does not run can never
    // vanish, so a typo in the floor covers nothing — which is the false green the floor exists to
    // close, and it is only visible if something reads the file for its own sake.
    async run(ctx) {
      const agents = await checkAgentsMd(ctx.root);
      const findings = [
        ...manifestMissingFindings(ctx.root),
        ...(await driftFindings(ctx.root)),
        ...(await envExampleFindings(ctx.root)),
        ...floorProblemFindings(await readVerifyFloor(ctx.root)),
        ...agents.findings,
        ...(await hostFindings(ctx, 'manifest')),
      ];
      // Warnings are not findings: `AGENTS.md` tabulating a route table is a smell a human
      // judges, not a build error. They ride in `output`, which `--json` carries verbatim.
      const output = agents.warnings.map((warning) => `${AGENTS_MD_FILENAME}: ${warning}`);
      return {
        ok: findings.length === 0,
        findings,
        ...(output.length === 0 ? {} : { output: output.join('\n') }),
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
 * The half that had never been asked: is the file there at all? `driftFindings` returns nothing
 * when it is absent — correctly, it has nothing to compare — and `AGENTS.md` line 3 tells an agent
 * that facts live in `x.manifest.json`, `x dev` prints its path, and `x manifest` is the only
 * thing that writes it. Nothing ran it: after `x new`, `bin/setup` and all thirteen generators,
 * `find . -name '*.manifest.json'` returned nothing while this step reported green (#F7).
 *
 * An app root, never this repo: the framework monorepo emits `framework.manifest.json` and has no
 * `x.manifest.json` to be missing, so the `app.config.ts` is what decides — the same discriminator
 * `drift`, `budgets`, `seo`, `i18n` and `policy` each use.
 */
function manifestMissingFindings(root: string): readonly Finding[] {
  if (!existsSync(join(root, APP_CONFIG_FILE))) return [];
  if (existsSync(join(root, MANIFEST_FILENAME))) return [];
  return [
    {
      code: 'X_MANIFEST_MISSING',
      cause: `${MANIFEST_FILENAME} does not exist, so every fact an agent reads about this app — route table, action schemas, policies, error codes — is unavailable`,
      fix: 'x manifest',
      docs: ERROR_DOCS_URL,
      at: MANIFEST_FILENAME,
    },
  ];
}

/** `assertNoDrift` throws `X_MANIFEST_DRIFT`; a step reports, so the error becomes a finding. */
async function driftFindings(root: string): Promise<readonly Finding[]> {
  const path = join(root, MANIFEST_FILENAME);
  if (!existsSync(path)) return [];
  const { manifest, findings } = await appManifest(root);
  try {
    await assertNoDrift({ manifest, path });
    return findings;
  } catch (error) {
    return [...findings, { ...findingFrom(error), at: MANIFEST_FILENAME }];
  }
}

/** A breaking change is allowed — with a major bump. `verifyContract` is the one that decides. */
function contractFindings(before: Manifest, after: Manifest): readonly Finding[] {
  try {
    verifyContract({ before, after });
    return [];
  } catch (error) {
    return [{ ...findingFrom(error), at: MANIFEST_FILENAME }];
  }
}

/** The typed client is generated from `openapi.json`, so a stale spec ships a wrong client. */
async function specFindings(root: string, manifest: Manifest): Promise<readonly Finding[]> {
  const path = join(root, OPENAPI_FILE);
  if (!existsSync(path)) return [];
  if ((await Bun.file(path).text()) === openApiJson(manifest)) return [];
  return [
    {
      code: 'X_MANIFEST_STALE',
      cause: `${OPENAPI_FILE} does not match the actions the code registers`,
      fix: 'x manifest',
      docs: ERROR_DOCS_URL,
      at: OPENAPI_FILE,
    },
  ];
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
