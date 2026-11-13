// The framework repo's host checks: the rules `x verify` runs at this root on top of its own, one
// list per step. Each step's checks run side by side (`lib/host-check-run.ts`) and answer in list
// order, so the report is the one the serial run gave; `verify-host-checks.test.ts` holds that.
// Split out of `scripts/verify.ts`, which keeps the entry point and re-exports every name here.

import { join } from 'node:path';
import type { HostCheck, VerifyStepName } from '@ultimat3/cli';
import {
  checkErrorCodeDocs,
  checkErrorCodeRegistry,
  checkFlagReads,
  collectDeclaredCodes,
  registeredErrorCodes,
  SPECS,
} from '@ultimat3/cli';
import { renderThrowable } from '@ultimat3/core';
// The leaf, not the barrel (DX ledger #10): a guard must load while a package is mid-edit.
import { checkErrorCodesThrown } from '../packages/cli/src/error-unthrown';
import { adapterPortFindings } from './adapter-ports';
import { adoptionClaimFindings } from './adoption-claims';
import { benchClaimFindings } from './bench-claims';
import {
  adminFlattenerFindingFor,
  checkAdminFlattener,
  checkBoundaries,
  checkSharedLeaf,
  collectAdminFiles,
  collectSharedFiles,
  collectSourceFiles,
  findingFor,
  floorFindings,
  sharedLeafFindingFor,
} from './boundaries';
import { boundaryRuleDocFindings } from './boundary-rule-docs';
import { chartVersionFindings } from './chart-version';
import { cliOutboundFindings } from './cli-outbound';
import { derivedDocCountFindings } from './derived-doc-counts';
import { docCommandFindings } from './doc-commands';
import { docFixAgreementFindings } from './doc-fix-agreement';
import { docFixFindings } from './doc-fixes';
import { docPathFindings } from './doc-paths';
import { docTestPathFindings } from './doc-test-paths';
import { dockerfileTemplateFindings } from './dockerfile-template';
import { errorStatusCompleteness } from './error-map';
import { errorRendering } from './error-render';
import { fixProseFindings } from './fix-prose';
import { gateStepFindings } from './gate-steps';
import { generatorCountFindings } from './generator-counts';
import { frameworkCatalogFindings } from './i18n-catalog';
import { imageContractFindings } from './image-contract';
import { instrumentSlotFindings } from './instrument-slots';
import { keyedHasherFindings } from './keyed-hasher';
import { knownGapLinkFindings } from './known-gaps-links';
import { checkConfigImports, configImportFindingFor } from './lib/config-import';
import { allOf, atMost, compilerWidth, oneAtATime } from './lib/host-check-run';
import { stabilityFindings } from './lib/stability-findings';
import { llmsTxtFindings } from './llms-txt';
import { DEFAULT_OUT, frameworkManifestDrift } from './manifest';
import { opsUidFindings } from './ops-uid-docs';
import { packageFrontFindings } from './package-front';
import { privateNameFindings } from './private-names';
import { productionAppsFindings } from './production-apps';
import { publicApiFindings } from './public-api';
import { readmeFactsFindings } from './readme-facts';
import { readmeFenceFindings } from './readme-fences';
import { readmeSampleFindings } from './readme-sample';
import { releaseFactFindings } from './release-facts';
import { publishListFindings } from './release-workflow';
import { checkRoadmap } from './roadmap';
import { sealCallFindings } from './seal-calls';
import { setupCommandFindings } from './setup-commands';
import { bareErrorFindings } from './test-bare-error';
import { testDiscoveryFindings } from './test-discovery';
import { testFixFindings } from './test-fix-citations';
import { realSleepFindings } from './test-real-sleep';
import { testTypecheckFindings } from './test-typecheck-gate';
import { throwFindings } from './to-throw-returns';
import { tsconfigPathFindings } from './tsconfig-paths';
import { versionStampFindings } from './version-stamps';
import { wikiAnchorFindings } from './wiki-anchors';
import { wikiFenceFindings } from './wiki-fences';
import { frameDocFindings } from './wiki-frames';
import { wikiTableFindings } from './wiki-tables';

/**
 * The tier table's two halves, ceiling and floor, as ONE check over one scan: `allImportsOf`
 * memoises specifiers per file object, and a fixture root is read fresh on every call
 * (`corpus.ts`), so two checks would transpile it twice for an answer read off the same imports.
 */
const tierTable: HostCheck = async (root) => {
  const source = await collectSourceFiles(root);
  return [
    ...checkBoundaries(source).map(findingFor),
    // The FLOOR half of the same table: a package sitting above the lowest tier its own imports
    // allow needs a written reason, because `scripts/lib/tiers.ts` claimed that placement was
    // "checked by this file's own rule" while nothing computed a floor at all.
    ...floorFindings(source),
  ];
};

/**
 * Five rules on one step. The tier table: a package may import only from a strictly lower tier.
 * The `shared/` leaf: an example app's `shared/` may hold types from `app/` but never a runtime
 * edge into it — `x verify` inside the app already checks that, and this repo's own gate must
 * too, because the reference-app job is advisory and this one blocks. `@ultimat3/admin`'s one
 * flattener: `packages/admin/CLAUDE.md` names `entity-columns.ts` as the only file that may read
 * `$meta` or call `$describe()` — stated there since it shipped, and unenforced until this line.
 * The framework catalog: `packages/i18n/src/catalogs/en.json` still answers every key framework
 * source renders, and still describes only screens that exist — 27 `t('admin.…')` keys had no
 * entry and an `admin.nav.*` block nothing reads did, so every admin screen rendered `⟦key⟧`.
 *
 * The image contract: `docker/Dockerfile` must build and ship one libc family, and must prove its
 * entrypoint in the stage that ships it. Neither was true — the build base was musl and the runtime
 * glibc, so every container of every build exited `exec /app/x: no such file or directory` while
 * the build reported green, because the `--version` guard ran on the build stage. `docker build`
 * runs on no PR, so this text rule is the only thing between that and the next release.
 *
 * The catalog and image rules ride here for the reason this step's own CLI comment gives:
 * `VerifyStepName` is a closed union owned by `@ultimat3/cli`, and a generated app would inherit an
 * eighteenth step only this repo can run. This is already the slot for "conventions this repo makes
 * about its own source that the framework cannot know" — the flattener rule is not a tier rule
 * either — and it runs third, before any suite, which is where a millisecond-cost text rule belongs.
 */
export const BOUNDARY_CHECKS: readonly HostCheck[] = [
  tierTable,
  async (root) => checkSharedLeaf(await collectSharedFiles(root)).map(sharedLeafFindingFor),
  async (root) => checkAdminFlattener(await collectAdminFiles(root)).map(adminFlattenerFindingFor),
  // One config loader: an `import(` of an app's `app.config.ts` outside `app-config-load.ts`.
  async (root) => checkConfigImports(await collectSourceFiles(root)).map(configImportFindingFor),
  frameworkCatalogFindings,
  imageContractFindings,
  // A tracked app's image installs from manifests only: its deps stage is the scaffold template's.
  dockerfileTemplateFindings,
  // The CLI's own declarations, held to each other: a flag the parser accepts that no file reads is
  // a promise `x help` prints with nothing behind it. `x deploy --critical` said "forces clients to
  // reload" and reached no reader outside the plan JSON. Host-side, because a generated app ships no
  // `packages/cli/src` — and on `boundaries` rather than an eighteenth step, for the reason the
  // `errors` step's comment already gives: `VerifyStepName` is a closed union the CLI owns.
  (root) => checkFlagReads(SPECS, join(root, 'packages', 'cli', 'src')),
  // One cipher call: a package above tier 0 seals through `seal()` / `open()` in
  // `@ultimat3/core`, never its own `subtle.encrypt`. A text rule, so it rides here.
  sealCallFindings,
  // One keyed hash: every HMAC through `hmac()` in `@ultimat3/core`, never a keyed
  // `Bun.CryptoHasher` (a Bun 1.4.4 bug throws a stale EC error through one). A text rule.
  keyedHasherFindings,
  // No telemetry: every host `packages/cli/src` spells is reserved or an allowlist row with a why.
  cliOutboundFindings,
  // No private adopter name in a tracked file or path; the names are the CI secret, unset a skip.
  (root) => privateNameFindings(root, process.env),
  // wiki/Stability.md: the major window, Highlights, no break on main, the deprecation window.
  stabilityFindings,
  // One instrumentation bus: no package exports a `set*Observer`/`set*Sink`/`set*Exporter` slot
  // or a `recent*()` ring buffer beside core's `subscribe()` (`X_INSTRUMENT_SLOT_FORBIDDEN`).
  instrumentSlotFindings,
  // One way to swap a backend: every ADAPTER_PORTS row ships its runtime.ts field, binding,
  // ./adapter export, conformance suite and wiki section, and no barrel exports an installer
  // (`X_ADAPTER_PORT_INCOMPLETE`, scripts/adapter-ports.ts).
  adapterPortFindings,
];

export const tierBoundaries: HostCheck = allOf(BOUNDARY_CHECKS);

/**
 * Why a generation failure is described through `renderThrowable` and not `error instanceof Error
 * ? error.message : String(error)`, which is what stood here. BOTH halves of that spelling can
 * throw while describing a throw, in the one branch with nothing left to report with:
 * `instanceof` runs a `Proxy`'s `getPrototypeOf` trap (measured — `verify.test.ts` throws from
 * one), `.message` is an ordinary property read and so may be a throwing getter, and `String(x)`
 * dies on a null-prototype object (`No default value`) or any `toString` that throws.
 *
 * `String(aSymbol)` is NOT one of them and answers `'Symbol(nope)'` — it is `${aSymbol}` that
 * throws, which is a different spelling and a different site. Stated because the audit that found
 * this line said Symbol, and a reason that is not true is worse than no reason.
 *
 * Named and exported so the hostile value is a test argument rather than a mocked module;
 * `scripts/registry-audit.ts`'s `failureDetail` is the same shape for the same reason.
 */
export const manifestFailureCause = (error: unknown): string =>
  `the framework manifest could not be generated: ${renderThrowable(error)}`;

/**
 * The framework's own manifest is generated from the packages: it must still generate, and the
 * committed copy must still match. Regenerating without comparing proves only that the generator
 * runs — a step that cannot fail, which is worse than no step at all.
 */
export const frameworkManifest: HostCheck = async (root) => {
  let drift: readonly string[];
  try {
    drift = await frameworkManifestDrift(root);
  } catch (error) {
    return [
      {
        // Not `X_MANIFEST_STALE`: nothing here is out of date. The generator refused to run, and
        // that is a failed gate step — `X_MANIFEST_STALE` belongs to a committed `openapi.json`
        // the code has moved past, `X_MANIFEST_DRIFT` to a committed manifest.
        code: 'X_VERIFY_FAILED',
        cause: manifestFailureCause(error),
        fix: 'bun run manifest',
        at: DEFAULT_OUT,
      },
    ];
  }
  if (drift.length === 0) return [];
  return [
    {
      code: 'X_MANIFEST_DRIFT',
      cause: `${DEFAULT_OUT} no longer describes the code: ${drift.join(', ')}`,
      fix: 'bun run manifest',
      at: DEFAULT_OUT,
    },
  ];
};

/**
 * The reference page every shipped `X_*` code must appear on. A framework monorepo publishes one
 * and a generated app does not, so naming it is the host's job — the CLI owns the rule, this repo
 * owns the file it is checked against.
 */
export const ERROR_REFERENCE = 'wiki/Error-Codes.md';

/**
 * The codes this repo's own gate emits. `scripts/` never ships, so no package may register
 * `X_ROADMAP_STATUS_MISSING` or `X_BOUNDARY_VIOLATION` — but the reference documents them, and a
 * rule that demanded a registration would push a contributor-only code into every generated app.
 * Scanned rather than listed, so a new script code needs no second edit here; a *documented* code
 * that neither a package nor a script declares is still the ghost row the registry check exists
 * to catch.
 *
 * The exemption follows the code's *declaration*, not every file that names it: a code a package
 * declares and a script merely throws — `X_BUN_VERSION` — is the package's to register, and
 * exempting it because `scripts/setup.ts` mentions it would waive the rule for a shipped code.
 */
const hostOwnedCodes = async (root: string): Promise<readonly string[]> =>
  (await collectDeclaredCodes(root))
    .filter((site) => site.at.startsWith('scripts/'))
    .map((site) => site.code);

/**
 * Both halves of the reference's contract, on one step. Every shipped code has a row here, and
 * every row this page presents as live resolves through `x errors explain` — the second half is
 * what stops the page documenting a code the registry never heard of.
 */
export const errorCodeDocs: HostCheck = allOf([
  (root) => checkErrorCodeDocs(root, ERROR_REFERENCE),
  async (root) => {
    const known = new Set([...(await registeredErrorCodes()), ...(await hostOwnedCodes(root))]);
    return checkErrorCodeRegistry(root, ERROR_REFERENCE, known);
  },
  (root) => checkErrorCodesThrown(root, ERROR_REFERENCE),
]);

/**
 * The `errors` step's host half: the reference page's three rules, the rule that an error factory
 * may not die formatting its own message, and the rule that `@ultimat3/http`'s status table stays
 * closed. Five rules on one step, the same shape `boundaries` already carries — a rule about
 * errors belongs on the errors step, not on an eighteenth one an agent has to learn the name of.
 *
 * `docFixFindings` is the reference page's THIRD rule and the one nothing enforced: the CLI's
 * `checkErrorFixes` resolves cited commands for `fix:` literals in shipped SOURCE, and the page an
 * agent is sent to when it hits a code was held to coverage and registration only. So a `Fix` cell
 * could print `x db query "select id …"` — and `x db` has no `query`, which is a second failure
 * handed to a reader already holding one. `docFixAgreementFindings` is its FOURTH: a runnable Fix
 * cell can still name a remedy its throw sites no longer register, on a ratchet that only falls.
 *
 * `testFixFindings`, `bareErrorFindings` and `throwFindings` join it because all three are the same
 * contract one file set further on. `checkErrorFixes` holds every `fix:` in `src/` to being runnable and skips tests, so a
 * fixture error, a helper that builds one and an assertion pinning a fix string were unchecked —
 * and `x schema show` and `x logs tail` are what that costs. `throwFindings` is the other half of
 * an error assertion: bun's synchronous `toThrow` PASSES when the callback returns an Error rather
 * than throwing one, and this repo exports 196 functions that return one. `bareErrorFindings` is the rule itself in
 * that file set: `CLAUDE.md` says never throw a bare `Error` and the enforced check skips tests, so
 * 422 sites sat under a green gate — a convention that is not a build error does not exist.
 * `fixProseFindings` holds the same `fix:` lines to OPENING with a command or a code shape, on a
 * per-package ratchet: the rule says a fix is a command, and 987 lines were sentences.
 *
 * The completeness rule is deliberately NOT its own step: `VerifyStepName` is a closed union owned
 * by `@ultimat3/cli`, and a generated app would inherit a step name that only this repo can run.
 * It blocks `x verify` either way, which is what "enforced, not documented" asks for.
 */
export const ERROR_CHECKS: readonly HostCheck[] = [
  errorCodeDocs,
  errorRendering,
  errorStatusCompleteness,
  docFixFindings,
  docFixAgreementFindings,
  testFixFindings,
  bareErrorFindings,
  realSleepFindings,
  throwFindings,
  fixProseFindings,
];

export const errorContract: HostCheck = allOf(ERROR_CHECKS);

/**
 * The `manifest` step's host half: every rule below asks that step's own question — does a
 * committed file still describe this tree? The generated manifest is the original; each other rule
 * holds a hand-maintained file that claimed something about the repo and was checked by nothing:
 *
 * | Rule | The claim, and what it cost | Source of truth |
 * |---|---|---|
 * | `publishListFindings` | `.github/workflows/release.yml` publishes every package — it does not, and `@ultimat3/flags` has never been on npm | `publishOrder(listWorkspaces())` |
 * | `benchClaimFindings` | `CLAUDE.md`'s realtime figures are what was measured | `scripts/bench/results/*.json` |
 * | `wikiTableFindings` | every `wiki/` table renders as a table | the GFM row rule |
 * | `frameDocFindings` | `wiki/Realtime.md` names the frames the wire actually sends | `FRAME_KINDS` |
 * | `chartVersionFindings` | `docker/helm/Chart.yaml` is on the lockstep version — it sat at 0.0.1, and `appVersion` IS the default image tag | the publishable workspaces' version |
 * | `docCommandFindings` | every `` `x …` `` on a page an agent reads is an invocation this build can run | `loadCommandCatalog()` |
 * | `docTestPathFindings` | every `bun test <path>` on a page an agent reads is anchored with `./` — bare, Bun reads it as a substring filter and also runs `examples/dummy/packages/<pkg>` under the wrong config; ~40 pages wrote it while CLAUDE.md said "always `./`" | the spans `scanDocSpans` reads |
 * | `tsconfigPathFindings` | every TypeScript subpath a package exports has its `tsconfig.base.json` `paths` row — nine v31 `./adapter` subpaths resolved in the apps and were TS2307 at the root | each package manifest's `exports` |
 * | `docPathFindings` | every backticked `packages/…`, `scripts/…` or `docs/…` path on a published page exists — eight package CLAUDE.md files named `dev-*` modules 22.0.0 had renamed | the tree, and the two tracked apps |
 * | `gateStepFindings` | a page stating how many steps `x verify` runs, or enumerating them, describes this build's gate — 17 documented against 18 shipped, in 20 files, through a whole major | `VERIFY_STEP_NAMES` |
 * | `versionStampFindings` | one page stamps a version, it is the shipped one, and the workspaces agree | every workspace manifest |
 * | `readmeFenceFindings` | a fenced `ts`/`tsx` example in a package README typechecks | `tsc`, on a ratchet |
 * | `testTypecheckFindings` | this repo's TEST sources typecheck — every package config excludes them, so `tsc -b` reads none of the 966 | `tsc -p tsconfig.tests.json`, on a ratchet |
 * | `testDiscoveryFindings` | a test file the gate's discovery never yields, or one outside the one convention — *.spec.*, *_spec.*, *_test.* and *.test.{js,jsx} are invisible to the glob, while a __tests__/ path whose basename the glob matches IS yielded by it and run by the gate, so it is refused for the convention it breaks; a colliding basename names no test file at all | `TEST_GLOB` in packages/cli/src/test-select.ts, and the ignore policy in packages/cli/src/test-ignores.ts |
 * | `generatorCountFindings` | a documented `N files` for `x new` / `x g resource` is what the generator still emits — five had gone stale and were corrected by hand | `planNewApp()` / `generate()`, the planners `--dry-run` calls |
 * | `derivedDocCountFindings` | the component, seam-row and stage counts a page states are the derived ones | the ui component files, the shipped ladder rows, PIPELINE_STAGES |
 * | `releaseFactFindings` | the package COUNT ten pages restate is the count on disk; `SECURITY.md` claimed 28 two majors late | `listWorkspaces()` |
 * | `setupCommandFindings` | a page stating what a scaffolded app's `bun run setup` runs, or how many steps it is, describes the script `x new` writes — `x db seed` was in the script and in no CI path, and four pages hand-copy the list | `binSetup()` in `templates/scaffold-bin.ts` |
 * | `llmsTxtFindings` | `llms.txt`'s package and wiki lists are generated — they were not, and `@ultimat3/notify` was missing | `listWorkspaces()`, `wiki/_Sidebar.md`, `wiki/Home.md` |
 * | `wikiFenceFindings` | a fenced `ts`/`tsx` example on a wiki page typechecks — `readmeFenceFindings` read package READMEs only (sweep 11). Runs AFTER it: both compile in one fixture directory | `tsc`, on a ratchet |
 * | `wikiAnchorFindings` | every `Page#anchor` link lands on a heading of its page | the target page's heading slugs |
 * | `knownGapLinkFindings` | each Known-Gaps `[B<n>]` link resolves to its backlog row and names its issue | the plan files |
 * | `opsUidFindings` | a uid `docs/ops` states is the one its image runs | `RUNTIME_UID`, `docker/helm/values.yaml` |
 * | `boundaryRuleDocFindings` | `02-boundaries.md`'s rule count and code table match the boundary rules | `BOUNDARY_CODES` |
 * | `readmeSampleFindings` | the root README's code sample is the `examples/dummy` file it quotes | that file |
 * | `readmeFactsFindings` | the root README's facts table (packages, gate steps, coverage, tests, codes) is the tree's | `listWorkspaces()`, `VERIFY_STEP_NAMES`, `COVERAGE_PINS`, the manifest |
 * | `adoptionClaimFindings` | no published page says who uses Ultimate outside the generated production-apps block | `PRODUCTION_APPS`, through that block |
 * | `productionAppsFindings` | README, FAQ and Compared say the same thing about who uses it — README said no production use while the FAQ said yes | `PRODUCTION_APPS` |
 * | `packageFrontFindings` | a publishable package's npm page opens on a sentence, install, example and wiki page, with `keywords` | each `package.json` |
 * | `publicApiFindings` | every exported symbol of every package entry and subpath still has the declaration `scripts/lib/public-api.lock.json` hashed, or a `BREAKING —` changelog entry says why not. Report-only this release: warnings on stderr, no findings | the emitted `.d.ts` of each entry |
 *
 * `testTypecheckFindings` rides HERE and not on `typecheck`, which is where it belongs by meaning:
 * that step takes no host findings at all (`packages/cli/src/cmd-verify.ts` calls `hostFindings`
 * on four steps, and `typecheck` is not one), and widening it is that package's edit rather than a
 * rider on this one. This is the step that already carries the other `tsc`-on-a-ratchet rule, and
 * it asks the same question both do: does a committed file still describe this tree?
 *
 * None of them is a step of its own, for the reason the `errors` step's comment already gives:
 * `VerifyStepName` is a closed union owned by `@ultimat3/cli`, and a generated app would inherit an
 * eighteenth step that only this repo can run. `package-shape` would have been the natural home for
 * the publish list, but the CLI's step takes no host findings — widening it is that package's edit.
 */
const fenceFixtures = oneAtATime();

/**
 * The four rules that start a `tsc` share one pool, `compilerWidth()` wide: each compiler is
 * threaded, so on 4 cores a second one beside it buys no overlap and starves `biome` and this
 * process's one JS thread. CI's static part, `taskset -c 0-3`, 2026-11-13: 67-72 s pooled, 79-90 s
 * with all three chains at once, 77-86 s on main. Inside the fence lock, so a fence rule waiting
 * its turn on the directory holds no compiler slot.
 */
const compiler = atMost(compilerWidth());

export const MANIFEST_CHECKS: readonly HostCheck[] = [
  frameworkManifest,
  publishListFindings,
  benchClaimFindings,
  wikiTableFindings,
  frameDocFindings,
  chartVersionFindings,
  docCommandFindings,
  docTestPathFindings,
  tsconfigPathFindings,
  docPathFindings,
  gateStepFindings,
  versionStampFindings,
  // Both fence rules compile in one fixture directory, and each wipes it first: one at a time.
  fenceFixtures(compiler(readmeFenceFindings)),
  testDiscoveryFindings,
  compiler(testTypecheckFindings),
  generatorCountFindings,
  derivedDocCountFindings,
  releaseFactFindings,
  setupCommandFindings,
  llmsTxtFindings,
  fenceFixtures(compiler(wikiFenceFindings)),
  wikiAnchorFindings,
  knownGapLinkFindings,
  opsUidFindings,
  boundaryRuleDocFindings,
  readmeSampleFindings,
  readmeFactsFindings,
  productionAppsFindings,
  adoptionClaimFindings,
  packageFrontFindings,
  // ~4 s of `.d.ts` emit; side by side with the rest where the cores allow another compiler.
  compiler((root) => publicApiFindings(root)),
];

export const frameworkFiles: HostCheck = allOf(MANIFEST_CHECKS);

export const HOST_CHECKS: Partial<Record<VerifyStepName, HostCheck>> = {
  boundaries: tierBoundaries,
  errors: errorContract,
  manifest: frameworkFiles,
  roadmap: checkRoadmap,
};
