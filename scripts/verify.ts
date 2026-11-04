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
  checkFlagReads,
  exec,
  exitCodeFor,
  render,
  runVerify,
  SPECS,
  VERIFY_STEPS,
} from '@ultimat3/cli';
import { isUltimateError, renderThrowable } from '@ultimat3/core';
import { requireBunVersion } from '../packages/cli/src/app-root';
import { BadFlagError, MissingPositionalError } from '../packages/cli/src/errors';
import { readVerifyFloor } from '../packages/cli/src/verify-floor';
import { mergeParts, parsePart, VerifyMergeInputError } from '../packages/cli/src/verify-merge';
import { measurePace } from '../packages/cli/src/verify-pace';
import { withVerifyProgress } from '../packages/cli/src/verify-progress';
import { readTimings } from '../packages/cli/src/verify-shard';
import { VERIFY_STEP_NAMES } from '../packages/cli/src/verify-step';
import { writeErrorLine } from '../packages/cli/src/write-line';
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
import { cliOutboundFindings } from './cli-outbound';
import { frameworkCatalogFindings } from './i18n-catalog';
import { imageContractFindings } from './image-contract';
import { flagBool, parseScriptArgs } from './lib/args';
import { CHANGELOG_PATH } from './lib/changelog-format';
import { breakingOnMainFindings, targetBranch } from './lib/changelog-highlights';
import { checkConfigImports, configImportFindingFor } from './lib/config-import';
import type { Finding } from './lib/log';
import { report, writeOut } from './lib/log';
import { repoRoot } from './lib/run';
import { stabilityFindings, todayUtc } from './lib/stability-findings';
import { REPO_GATE, readVerifyArgs, VERIFY_SUBCOMMANDS } from './lib/verify-args';
// The two host-check halves this gate wires onto its steps live in `scripts/lib/`, one file each:
// the `errors` step's and the `manifest` step's committed-file rules. The `errors` step's half is
// re-exported below so every importer of this module keeps ONE import site, and so the gate's own
// row in `docs/architecture/guards.md` still names the codes it raises — `scripts/guards-doc.ts`
// reads a guard's row from its own text plus the `scripts/lib/*` modules it imports, one level
// down.
import { errorContract } from './lib/verify-errors';
import { committedFiles } from './lib/verify-manifest';
import { DEFAULT_OUT, frameworkManifestDrift } from './manifest';
import { privateNameFindings } from './private-names';
import { checkRoadmap } from './roadmap';
import { sealCallFindings } from './seal-calls';

export { ERROR_REFERENCE, errorCodeDocs, errorContract } from './lib/verify-errors';

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
 *
 * EVERY RULE HERE IS ABOUT THE TREE, and none reads the environment: a scan of a tree answers the
 * same way for every caller, so its answer is a fact about the tree. TWO rules could not keep that
 * promise, and both are the RUN's answers, not the tree's — each is asked of the run that owns the
 * fact, and each is wired onto this same step:
 *
 * - the private-name guard — `privateNames` below: the secret is a fact about the RUN.
 * - the no-break-on-main rule — `breaksOnMain` below: WHERE this change is landing is a fact about
 *   the RUN, and only the run knows it. The changelog's `BREAKING —` entries under `[Unreleased]`
 *   are the tree's half, and they stay here; the branch is not.
 *
 * The stability rule is asked HERE with an explicit empty environment, so this scan reads no
 * environment at all — `stabilityFindings` falls back to `Bun.env` when it is handed none
 * (`scripts/lib/stability-findings.ts`), and a rule whose answer varies by the process that asked
 * is the defect this file's split exists to prevent.
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
    // No telemetry: every host `packages/cli/src` spells is reserved or an allowlist row with a why.
    ...(await cliOutboundFindings(root)),
    // wiki/Stability.md: the major window, Highlights, the deprecation window. Asked with an
    // explicit empty environment, so this scan reads none: the no-break-on-main half is the RUN's
    // question and lives in `breaksOnMain` below.
    ...(await stabilityFindings(root, { env: {} })),
  ];
};

/**
 * The private-name guard, in the RUN that performs it. Two rules, about different things:
 *
 * - The SCAN: no tracked file or path may carry a private adopter's name. The names are a CI
 *   secret, so unset is a skip that says so — a scan that read nothing must never read as a scan.
 * - The CONFIGURATION: on a push to main the secret must ARRIVE, or the scan skips and the guard
 *   passes while reading nothing.
 *
 * The second is a fact about the RUN, and the guard asks for it EXPLICITLY:
 * `scripts/private-names.ts` raises `X_PRIVATE_NAMES_UNSET` only when
 * `ULTIMATE_PRIVATE_NAMES_REQUIRED` is `1` and the names are empty — never inferred from the
 * event, because a unit job on a push to main runs this guard with no secret and must skip.
 * `.github/workflows/ci.yml` sets that flag on the part that runs `boundaries` on a push to
 * `main`, and hands that part the secret; every other job, the `packages` one included, is
 * handed neither.
 *
 * The failure this split repairs was on the tree BEFORE it: the repo gate's TREE scan
 * (`tierBoundaries`) read `process.env`, so "does this tree have boundary violations" depended
 * on WHICH PROCESS asked, and the `packages (1/2)` job — a push to main handed no secret on
 * purpose — was red for a rule that was not its own. On THAT tree the guard inferred its
 * requirement from the push event, so the tree scan carried it; on this tree the guard asks for
 * the flag and the tree scan asks for nothing. `scripts/verify.test.ts`'s repo-gate assertion
 * failed with `X_PRIVATE_NAMES_UNSET` at `.github/workflows/ci.yml`, against a tree with no
 * boundary violation in it.
 *
 * The rule is asked of the job that owns the secret: the gate's `boundaries` step runs this with
 * `process.env` (see `HOST_CHECKS` below), where the secret arrives and the scan is real. The
 * rule is NOT weakened — `scripts/private-names.test.ts` pins both halves, and the finding still
 * fires for the run that requires the names and arrives without them.
 *
 * The environment is a parameter with a default rather than a read of `process.env` in the body,
 * so a test can hand this rule a CI-shaped environment and watch it answer: `process.env` is
 * process-wide state, and a test that mutates it leaves the next test reading a machine it did
 * not choose.
 */
export const privateNames = async (
  root: string,
  env: Readonly<Record<string, string | undefined>> = process.env,
): Promise<readonly Finding[]> => privateNameFindings(root, env);

/**
 * The no-break-on-main rule, in the RUN that performs it — the second rule whose answer is a fact
 * about the run and not about the tree.
 *
 * From v30, `main` ships minors and patches only while the major window is closed: a `BREAKING —`
 * entry under `[Unreleased]` waits on `next`. The changelog's entries are the TREE's half and stay
 * in `tierBoundaries`; WHERE this change is landing is the RUN's half, and only the run knows it —
 * the pull request's base branch (`GITHUB_BASE_REF`), else the pushed branch (`GITHUB_REF_NAME` on
 * a push), else nothing (a local run reads no branch and the rule stays silent).
 *
 * It lived inside `tierBoundaries` until this split, which is how the tree scan read the
 * environment: `stabilityFindings` falls back to `Bun.env` when it is handed no environment, so the
 * tree's answer varied by the process that asked — the same defect the private-name guard had, and
 * the same fix: the rule is asked of the run that owns the fact. It is NOT weakened. The gate's
 * `boundaries` step runs this with `process.env` (see `HOST_CHECKS` below), where the branch
 * arrives, and the finding still fires for a break headed to `main` inside a closed window.
 *
 * The environment is a parameter with a default rather than a read of `process.env` in the body, so
 * a test can hand this rule a CI-shaped environment and watch it answer: `process.env` is
 * process-wide state, and a test that mutates it leaves the next test reading a machine it did not
 * choose.
 */
export const breaksOnMain = async (
  root: string,
  env: Readonly<Record<string, string | undefined>> = process.env,
): Promise<readonly Finding[]> => {
  const changelog = await Bun.file(`${root}/${CHANGELOG_PATH}`)
    .text()
    .catch(() => '');
  return breakingOnMainFindings({
    changelog,
    target: targetBranch(env),
    today: todayUtc(),
  });
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
 * The `manifest` step's host half: the generated manifest — the original — and every committed
 * file that claims something about this repo, each checked against the tree it describes.
 *
 * The two halves live in two files because they are two jobs: the generated manifest is this
 * repo's own artifact and is checked here, beside the gate; the committed files are a list of
 * rules, and `scripts/lib/verify-manifest.ts` holds them.
 */
export const frameworkFiles: HostCheck = async (root) => [
  ...(await frameworkManifest(root)),
  ...(await committedFiles(root)),
];

export const HOST_CHECKS: Partial<Record<VerifyStepName, HostCheck>> = {
  // THREE host checks on one step, and the split is the repair: `tierBoundaries` answers about the
  // TREE, `privateNames` and `breaksOnMain` about the RUN — only the run that carries the secret
  // can be asked whether the secret arrived, and only the run knows which branch this change is
  // landing on. Merged here so the step still reports every half.
  boundaries: async (root) => [
    ...(await tierBoundaries(root)),
    ...(await privateNames(root)),
    ...(await breaksOnMain(root)),
  ],
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
    // The runtime first, as `x` itself does (`dispatch`): this script calls `runVerify` directly
    // and so skipped that check. A gate on a Bun below the pin is not the gate CI runs — on Bun
    // 1.4.0 (oven-sh/bun#40578, fixed in 1.4.1) every browser barrel bundles to an empty
    // `export { … }` and `scripts/browser-barrel.test.ts` goes red over code nobody changed, after
    // the whole gate has run. One coded line, before any step, names the cause instead.
    requireBunVersion(Bun.version);
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
        : // Progress on stderr in either render — a line per finished step, a heartbeat while one
          // runs — so a cancelled CI part's log ends where it hung (#589) and a harness that
          // kills on silence never kills a healthy gate. stdout stays the one document.
          await withVerifyProgress(writeErrorLine, async (progress) =>
            runVerify(VERIFY_STEPS, {
              root,
              runner: exec,
              hostChecks: HOST_CHECKS,
              command: REPO_GATE,
              // The deadlines at this machine's pace: a 2-core fleet box is not a 4-core CI runner.
              pace: measurePace(),
              ...(gate.only === undefined ? {} : { only: gate.only }),
              ...(gate.workers === undefined ? {} : { workers: gate.workers }),
              ...progress,
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
            }),
          );
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
