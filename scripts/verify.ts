#!/usr/bin/env bun
// The gate for the framework repo itself: `x verify`, run at the repo root. The step list, the
// runner, the report and the exit code all come from @ultimat3/cli — a contributor and a user see
// the same steps because there is only one list. This file adds the two rules a package monorepo
// enforces that the CLI cannot know on its own: the tier table, and its generated manifest.
//
//   bun run scripts/verify.ts [--json] [--verbose] [--workers N] [--only <step>[,<step>…]]
//   bun run scripts/verify.ts --only unit --shard i/n [--timings file]   # one CI runner's slice
//   bun run scripts/verify.ts merge <part.json…> [--json]                # the parts, as one verdict
//
// The last two are how CI runs this gate on several runners and still gets ONE verdict: each part
// is `--only` (and `--shard` for the parallel suites), and `merge` is red for a step no part ran.
// `x verify` has both, but refuses the repo root (`X_NOT_IN_APP`) and carries no host checks, so
// they are spelled here too — same readers, same merge, this file's `HOST_CHECKS` under them.
//
// `--workers` is the CLI's own flag, passed through: the test steps shard over `cpus` by default,
// and on a shared machine that width was measured to take the whole gate down (OOM-killed twice
// on 2026-09-07 beside two other suites). It narrows the WIDTH of the run, never the gate.

import { join } from 'node:path';
import type { HostCheck, VerifyStepName } from '@ultimat3/cli';
import {
  checkErrorCodeDocs,
  checkErrorCodeRegistry,
  checkFlagReads,
  collectDeclaredCodes,
  exec,
  exitCodeFor,
  registeredErrorCodes,
  render,
  runVerify,
  SPECS,
  VERIFY_STEPS,
} from '@ultimat3/cli';
import { isUltimateError, renderThrowable } from '@ultimat3/core';
// The leaf, not the barrel (DX ledger #10): a guard must load while a package is mid-edit.
import { checkErrorCodesThrown } from '../packages/cli/src/error-unthrown';
import { BadFlagError, MissingPositionalError } from '../packages/cli/src/errors';
import { readVerifyFloor } from '../packages/cli/src/verify-floor';
import { mergeParts, parsePart, VerifyMergeInputError } from '../packages/cli/src/verify-merge';
import { stepStream } from '../packages/cli/src/verify-progress';
import { readTimings } from '../packages/cli/src/verify-shard';
import { VERIFY_STEP_NAMES } from '../packages/cli/src/verify-step';
import { writeErrorLine } from '../packages/cli/src/write-line';
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
import { chartVersionFindings } from './chart-version';
import { docCommandFindings } from './doc-commands';
import { docFixFindings } from './doc-fixes';
import { docPathFindings } from './doc-paths';
import { errorStatusCompleteness } from './error-map';
import { errorRendering } from './error-render';
import { fixProseFindings } from './fix-prose';
import { gateStepFindings } from './gate-steps';
import { generatorCountFindings } from './generator-counts';
import { frameworkCatalogFindings } from './i18n-catalog';
import { imageContractFindings } from './image-contract';
import { flagBool, parseScriptArgs } from './lib/args';
import { checkConfigImports, configImportFindingFor } from './lib/config-import';
import { report, writeOut } from './lib/log';
import { repoRoot } from './lib/run';
import { REPO_GATE, readVerifyArgs, VERIFY_SUBCOMMANDS } from './lib/verify-args';
import { llmsTxtFindings } from './llms-txt';
import { DEFAULT_OUT, frameworkManifestDrift } from './manifest';
import { readmeFenceFindings } from './readme-fences';
import { releaseFactFindings } from './release-facts';
import { publishListFindings } from './release-workflow';
import { checkRoadmap } from './roadmap';
import { sealCallFindings } from './seal-calls';
import { setupCommandFindings } from './setup-commands';
import { bareErrorFindings } from './test-bare-error';
import { testFixFindings } from './test-fix-citations';
import { testTypecheckFindings } from './test-typecheck-gate';
import { throwFindings } from './to-throw-returns';
import { versionStampFindings } from './version-stamps';
import { frameDocFindings } from './wiki-frames';
import { wikiTableFindings } from './wiki-tables';

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
export const tierBoundaries: HostCheck = async (root) => {
  // One scan for both halves of the tier rule. Two would transpile 4,000 files twice for an answer
  // read off the same specifiers.
  const source = await collectSourceFiles(root);
  return [
    ...checkBoundaries(source).map(findingFor),
    // The FLOOR half of the same table: a package sitting above the lowest tier its own imports
    // allow needs a written reason, because `scripts/lib/tiers.ts` claimed that placement was
    // "checked by this file's own rule" while nothing computed a floor at all.
    ...floorFindings(source),
    ...checkSharedLeaf(await collectSharedFiles(root)).map(sharedLeafFindingFor),
    ...checkAdminFlattener(await collectAdminFiles(root)).map(adminFlattenerFindingFor),
    // One config loader: an `import(` of an app's `app.config.ts` outside `app-config-load.ts`.
    ...checkConfigImports(source).map(configImportFindingFor),
    ...(await frameworkCatalogFindings(root)),
    ...(await imageContractFindings(root)),
    // The CLI's own declarations, held to each other: a flag the parser accepts that no file reads is
    // a promise `x help` prints with nothing behind it. `x deploy --critical` said "forces clients to
    // reload" and reached no reader outside the plan JSON. Host-side, because a generated app ships no
    // `packages/cli/src` — and on `boundaries` rather than an eighteenth step, for the reason the
    // `errors` step's comment already gives: `VerifyStepName` is a closed union the CLI owns.
    ...(await checkFlagReads(SPECS, join(root, 'packages', 'cli', 'src'))),
    // One cipher call: a package above tier 0 seals through `seal()` / `open()` in
    // `@ultimat3/core`, never its own `subtle.encrypt`. A text rule, so it rides here.
    ...(await sealCallFindings(root)),
  ];
};

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
export const errorCodeDocs: HostCheck = async (root) => {
  const known = new Set([...(await registeredErrorCodes()), ...(await hostOwnedCodes(root))]);
  return [
    ...(await checkErrorCodeDocs(root, ERROR_REFERENCE)),
    ...(await checkErrorCodeRegistry(root, ERROR_REFERENCE, known)),
    ...(await checkErrorCodesThrown(root, ERROR_REFERENCE)),
  ];
};

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
 * handed to a reader already holding one.
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
export const errorContract: HostCheck = async (root) => [
  ...(await errorCodeDocs(root)),
  ...(await errorRendering(root)),
  ...(await errorStatusCompleteness(root)),
  ...(await docFixFindings(root)),
  ...(await testFixFindings(root)),
  ...(await bareErrorFindings(root)),
  ...(await throwFindings(root)),
  ...(await fixProseFindings(root)),
];

/**
 * The `manifest` step's host half: four rules, all asking that step's own question — does a
 * committed file still describe this tree? The generated manifest is the original. The other three
 * are hand-maintained files that claim something about the repo and were checked by nothing:
 *
 * | Rule | The claim, and what it cost | Source of truth |
 * |---|---|---|
 * | `publishListFindings` | `.github/workflows/release.yml` publishes every package — it does not, and `@ultimat3/flags` has never been on npm | `publishOrder(listWorkspaces())` |
 * | `benchClaimFindings` | `CLAUDE.md`'s realtime figures are what was measured | `scripts/bench/results/*.json` |
 * | `wikiTableFindings` | every `wiki/` table renders as a table | the GFM row rule |
 * | `frameDocFindings` | `wiki/Realtime.md` names the frames the wire actually sends | `FRAME_KINDS` |
 * | `chartVersionFindings` | `docker/helm/Chart.yaml` is on the lockstep version — it sat at 0.0.1, and `appVersion` IS the default image tag | the publishable workspaces' version |
 * | `docCommandFindings` | every `` `x …` `` on a page an agent reads is an invocation this build can run | `loadCommandCatalog()` |
 * | `docPathFindings` | every backticked `packages/…`, `scripts/…` or `docs/…` path on a published page exists — eight package CLAUDE.md files named `dev-*` modules 22.0.0 had renamed | the tree, and the two tracked apps |
 * | `gateStepFindings` | a page stating how many steps `x verify` runs, or enumerating them, describes this build's gate — 17 documented against 18 shipped, in 20 files, through a whole major | `VERIFY_STEP_NAMES` |
 * | `versionStampFindings` | one page stamps a version, it is the shipped one, and the workspaces agree | every workspace manifest |
 * | `readmeFenceFindings` | a fenced `ts`/`tsx` example in a package README typechecks | `tsc`, on a ratchet |
 * | `testTypecheckFindings` | this repo's TEST sources typecheck — every package config excludes them, so `tsc -b` reads none of the 966 | `tsc -p tsconfig.tests.json`, on a ratchet |
 * | `generatorCountFindings` | a documented `N files` for `x new` / `x g resource` is what the generator still emits — five had gone stale and were corrected by hand | `planNewApp()` / `generate()`, the planners `--dry-run` calls |
 * | `releaseFactFindings` | the package COUNT ten pages restate is the count on disk; `SECURITY.md` claimed 28 two majors late | `listWorkspaces()` |
 * | `setupCommandFindings` | a page stating what a scaffolded app's `bin/setup` runs, or how many steps it is, describes the script `x new` writes — `x db seed` was in the script and in no CI path, and four pages hand-copy the list | `binSetup()` in `templates/scaffold-docs.ts` |
 * | `llmsTxtFindings` | `llms.txt`'s package and wiki lists are generated — they were not, and `@ultimat3/notify` was missing | `listWorkspaces()`, `wiki/_Sidebar.md`, `wiki/Home.md` |
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
export const frameworkFiles: HostCheck = async (root) => [
  ...(await frameworkManifest(root)),
  ...(await publishListFindings(root)),
  ...(await benchClaimFindings(root)),
  ...(await wikiTableFindings(root)),
  ...(await frameDocFindings(root)),
  ...(await chartVersionFindings(root)),
  ...(await docCommandFindings(root)),
  ...(await docPathFindings(root)),
  ...(await gateStepFindings(root)),
  ...(await versionStampFindings(root)),
  ...(await readmeFenceFindings(root)),
  ...(await testTypecheckFindings(root)),
  ...(await generatorCountFindings(root)),
  ...(await releaseFactFindings(root)),
  ...(await setupCommandFindings(root)),
  ...(await llmsTxtFindings(root)),
];

export const HOST_CHECKS: Partial<Record<VerifyStepName, HostCheck>> = {
  boundaries: tierBoundaries,
  errors: errorContract,
  manifest: frameworkFiles,
  roadmap: checkRoadmap,
};

/**
 * `merge <part.json…>`: the parts CI ran on separate runners, folded by the CLI's own `mergeParts`
 * under this repo's `x.verify.json`. Green only when every step of the gate is in exactly one part
 * (or in every shard of one split) — a step no part ran is `X_VERIFY_MERGE_INCOMPLETE`.
 */
export async function mergeGateParts(root: string, files: readonly string[]) {
  if (files.length === 0) {
    throw new MissingPositionalError({
      command: 'verify merge',
      positional: 'part.json…',
      example: 'bun run verify merge parts/*.json --json',
    });
  }
  const parts = await Promise.all(
    files.map(async (file) => {
      const handle = Bun.file(file);
      // An unmatched `parts/*.json` arrives as that literal: refused by name, never an ENOENT.
      if (!(await handle.exists())) {
        throw new VerifyMergeInputError({ file, reason: 'does not exist', command: REPO_GATE });
      }
      return parsePart(file, await handle.text(), REPO_GATE);
    }),
  );
  // No coverage riders: this root is not an app. The framework's floor is judged per package and
  // for `scripts/`, one process each, by `scripts/coverage-gate.ts` — the `packages` CI job.
  return mergeParts(parts, await readVerifyFloor(root), VERIFY_STEP_NAMES, { command: REPO_GATE });
}

if (import.meta.main) {
  const args = parseScriptArgs(Bun.argv.slice(2));
  const root = repoRoot();
  const verbose = flagBool(args, 'verbose');
  try {
    const [word, ...rest] = args.positionals;
    if (word !== undefined && !(VERIFY_SUBCOMMANDS as readonly string[]).includes(word)) {
      // A stray word used to be dropped and the whole gate ran: `verify lint` is not `--only lint`.
      throw new BadFlagError({
        flag: 'only',
        command: 'verify',
        reason: `"${word}" is not a subcommand (${VERIFY_SUBCOMMANDS.join(', ')}); a step is named with --only`,
        fix: 'bun run verify --only lint',
      });
    }
    const gate = readVerifyArgs(args);
    const result =
      word === 'merge'
        ? await mergeGateParts(root, rest)
        : await runVerify(VERIFY_STEPS, {
            root,
            runner: exec,
            hostChecks: HOST_CHECKS,
            command: REPO_GATE,
            // One line per finished step on stderr under `--json`, so a cancelled CI part's log
            // ends on the last step that finished (#589). stdout stays the one document.
            ...stepStream(args.json, writeErrorLine),
            ...(gate.only === undefined ? {} : { only: gate.only }),
            ...(gate.workers === undefined ? {} : { workers: gate.workers }),
            ...(gate.shard === undefined
              ? {}
              : {
                  shard: {
                    ...gate.shard,
                    ...(gate.timings === undefined
                      ? {}
                      : { timings: await readTimings(gate.timings, REPO_GATE) }),
                  },
                }),
          });
    // Through `writeOut`, not `process.stdout.write`: see the note there. A failing gate's JSON
    // carries each failed step's own output, which is exactly when the payload clears 64KB and
    // exactly when a developer needs it — so the truncation only ever bit the runs that mattered.
    writeOut(`${render(result, args.json, verbose)}\n`);
    process.exit(exitCodeFor(result));
  } catch (error) {
    // A refused flag, a refused shard and an unreadable part are all coded: reported in the
    // script's own shape, never as a stack trace.
    if (!isUltimateError(error)) throw error;
    const finding = { code: error.code, cause: error.cause, fix: error.fix };
    report({ ok: false, script: 'verify', summary: 'refused', findings: [finding] }, args.json);
  }
}
