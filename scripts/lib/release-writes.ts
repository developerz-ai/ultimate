// The three files a lockstep bump owes BEYOND the package manifests, as one table: the generated
// framework manifest, `bun.lock`'s recorded workspace facts, and the one wiki page that stamps a
// version. Each is a file the gate reads at the tag, so a bump that skips one leaves a tree
// `--check` calls stamped and `verify` then refuses — which is what v19.3.0 was.

import { checkPackageShape } from '@ultimat3/cli';
import { renderThrowable } from '@ultimat3/core';
// Upward, and the only file under `scripts/lib/` that reaches out of it: the three writes have to
// run the SAME passes `bun run manifest`, `bun run lockfile:fix` and the gate's own version-stamp
// reader run, and those live one directory up. A copy of any of them here would be a second answer
// to the question this file exists to stop asking twice.
import { correctLockfile, declaredFacts } from '../lockfile-pins';
import { buildManifest, DEFAULT_OUT, frameworkManifestDrift } from '../manifest';
import { versionStampFindings } from '../version-stamps';
import { frameworkManifestJson } from './framework-manifest';
import type { Finding } from './log';
import { readStampPages, readStamps, rewriteStamps, STAMP_PAGE } from './version-stamp-scan';

export type ReleaseWriteKind = 'manifest' | 'lockfile' | 'stamps';

/**
 * One row per write: the file, the command that performs it ALONE, and the code a tree that still
 * needs it is refused with. The code is on the row rather than chosen at the call site so the
 * refusal `--check` prints and the refusal `--bump` prints can never name two different ones.
 */
export interface ReleaseWriteSpec {
  readonly kind: ReleaseWriteKind;
  /** Repo-relative, because that is how every finding in this repo names a file. */
  readonly at: string;
  readonly command: string;
  readonly subject: string;
  readonly code: string;
}

/**
 * `framework.manifest.json` embeds every package's version, so it drifts on every bump — 32 lines
 * at 19.3.0, the 31 versions plus the `buildId` that hashes them.
 */
export const MANIFEST_WRITE: ReleaseWriteSpec = {
  kind: 'manifest',
  at: 'framework.manifest.json',
  command: 'bun run manifest',
  subject: 'every package version and the buildId that hashes them',
  code: 'X_MANIFEST_DRIFT',
};

/**
 * `bun install` will not do this one: Bun refreshes a workspace block only when that workspace's
 * own manifest changed, and `--frozen-lockfile` accepts every stale range. 235 recorded facts at
 * 19.3.0, corrected by a commit AFTER the tag was cut.
 */
export const LOCKFILE_WRITE: ReleaseWriteSpec = {
  kind: 'lockfile',
  at: 'bun.lock',
  command: 'bun run lockfile:fix',
  subject: "each workspace's own recorded version and its @ultimat3/* ranges",
  code: 'X_LOCKFILE_STALE',
};

/**
 * One line, and the only version claim in `wiki/` — the footer renders under all 46 pages, which
 * is why it is the one page allowed to stamp and the one page a release must move.
 */
export const STAMP_WRITE: ReleaseWriteSpec = {
  kind: 'stamps',
  at: 'wiki/_Footer.md',
  command: 'bun run scripts/version-stamps.ts --json',
  subject: 'the one wiki page that stamps a version',
  code: 'X_VERSION_STAMP_STALE',
};

/**
 * The set, in the order a bump performs it. Named constants rather than a keyed table: every
 * reader wants a specific one, so nothing here does a computed read of a record — `proto-index`'s
 * rule — and the union stays total without a lookup that can answer `undefined`.
 */
export const RELEASE_WRITES: readonly ReleaseWriteSpec[] = [
  MANIFEST_WRITE,
  LOCKFILE_WRITE,
  STAMP_WRITE,
];

/** One performed write: what moved, and how much of it. */
export interface ReleaseWrite {
  readonly kind: ReleaseWriteKind;
  readonly at: string;
  /** Facts that moved. `0` means the file already agreed with the stamped manifests. */
  readonly facts: number;
  readonly detail: string;
}

/**
 * A write that could not be performed, or a tree that still owes it. The `fix:` is the command
 * that performs that ONE write, never a re-run of `--bump`: a bump that has already rewritten 48
 * manifests cannot be run twice, and telling an operator to do so is advice that reds on
 * `X_DOC_CHANGELOG_SECTION_INVALID` at best and double-bumps at worst.
 */
export const releaseWriteFinding = (
  spec: ReleaseWriteSpec,
  cause: string,
  // The one case the row's own command cannot repair: a file that is not there at all. `bun run
  // lockfile:fix` on an absent `bun.lock` reads it and dies, so the caller names `bun install`.
  command: string = spec.command,
): Finding => ({ code: spec.code, cause, fix: command, at: spec.at });

/** What `--dry-run` prints: the write it would make, named by its own command. */
export const plannedWriteLine = (spec: ReleaseWriteSpec): string =>
  `  ${spec.kind.padEnd(9)} would write ${spec.at} — ${spec.subject} (${spec.command})`;

/** What a real run prints, per write. */
export const performedWriteLine = (write: ReleaseWrite): string =>
  `  ${write.kind.padEnd(9)} ${write.detail}`;

/**
 * The three files a bump owes beyond the manifests, WRITTEN — after the stamping loop, because all
 * three are derived from the stamped manifests and would otherwise record the version being left.
 *
 * v19.3.0 is why this exists. `--check 19.3.0` answered `31 packages are stamped at 19.3.0` on the
 * tag's own tree and the gate then refused it: `framework.manifest.json` embeds every package
 * version (32 lines), `bun.lock` recorded 235 facts at 19.2.0, and `wiki/_Footer.md:8` still
 * stamped v19.2.0. Nothing published, and the three writes were made by hand afterwards.
 */
export async function performReleaseWrites(
  root: string,
  version: string,
): Promise<{ readonly writes: readonly ReleaseWrite[]; readonly findings: readonly Finding[] }> {
  const writes: ReleaseWrite[] = [];
  const findings: Finding[] = [];
  try {
    const drift = await frameworkManifestDrift(root);
    await Bun.write(`${root}/${DEFAULT_OUT}`, frameworkManifestJson(await buildManifest(root)));
    writes.push({
      kind: 'manifest',
      at: MANIFEST_WRITE.at,
      facts: drift.length,
      detail:
        drift.length === 0
          ? `${DEFAULT_OUT} already described this tree`
          : `${DEFAULT_OUT} regenerated: ${drift.join(', ')}`,
    });
  } catch (error) {
    // `renderThrowable`, never `${error}`: the one branch left with nothing to report with may not
    // be the branch that throws while describing a throw.
    findings.push(
      releaseWriteFinding(
        MANIFEST_WRITE,
        `${DEFAULT_OUT} could not be regenerated: ${renderThrowable(error)}`,
      ),
    );
  }
  const lock = Bun.file(`${root}/bun.lock`);
  if (await lock.exists()) {
    const { text, edits } = correctLockfile(await lock.text(), await declaredFacts(root));
    if (edits.length > 0) await Bun.write(`${root}/bun.lock`, text);
    writes.push({
      kind: 'lockfile',
      at: LOCKFILE_WRITE.at,
      facts: edits.length,
      detail:
        edits.length === 0
          ? 'bun.lock already agreed with every package.json'
          : `bun.lock corrected ${edits.length} recorded fact(s)`,
    });
  } else {
    findings.push(
      releaseWriteFinding(
        LOCKFILE_WRITE,
        'bun.lock is not there, so no recorded workspace pin could be moved — every install of this release would resolve the previous version',
        'bun install && bun run lockfile:fix',
      ),
    );
  }
  const footer = (await readStampPages(root)).find((page) => page.path === STAMP_PAGE);
  if (footer === undefined || readStamps(footer).length === 0) {
    findings.push(
      releaseWriteFinding(
        STAMP_WRITE,
        `${STAMP_PAGE} stamps no version, so this release had nothing to move and the wiki now claims nothing about which version shipped`,
        'git checkout -- wiki/_Footer.md   # restore the footer, then: bun run scripts/version-stamps.ts --json',
      ),
    );
  } else {
    const { text, moved } = rewriteStamps(footer, version);
    if (moved > 0) await Bun.write(`${root}/${STAMP_PAGE}`, text);
    writes.push({
      kind: 'stamps',
      at: STAMP_PAGE,
      facts: moved,
      detail:
        moved === 0
          ? `${STAMP_PAGE} already stamped v${version}`
          : `${STAMP_PAGE} moved ${moved} stamp(s) to v${version}`,
    });
  }
  return { writes, findings };
}

/**
 * The same three files, ASKED rather than written — so `--check <version>` refuses at the tag
 * instead of leaving it to `verify`, which is the step that found all three at 19.3.0 two and a
 * half minutes later.
 *
 * `versionStampFindings` is the gate's own `manifest`-step reader, imported rather than restated:
 * it already reports every stale `@ultimat3/*` RANGE in `bun.lock` and every stamp gap. Only the
 * workspace's own recorded `version` is added beside it, which is the half that reader does not
 * look at — one fact reported twice reads as two problems.
 */
export async function releaseWriteFindings(root: string): Promise<readonly Finding[]> {
  const findings: Finding[] = [];
  const drift = await frameworkManifestDrift(root);
  if (drift.length > 0) {
    findings.push(
      releaseWriteFinding(
        MANIFEST_WRITE,
        `${DEFAULT_OUT} no longer describes the code: ${drift.join(', ')}`,
      ),
    );
  }
  const lock = Bun.file(`${root}/bun.lock`);
  if (await lock.exists()) {
    const { edits } = correctLockfile(await lock.text(), await declaredFacts(root));
    for (const edit of edits) {
      if (edit.kind !== 'version') continue;
      findings.push(
        releaseWriteFinding(
          LOCKFILE_WRITE,
          `bun.lock records ${edit.dir} at version ${edit.locked}, and that package.json says ${edit.declared}`,
        ),
      );
    }
  }
  findings.push(...(await versionStampFindings(root)));
  return findings;
}

/**
 * Everything `--check <version>` asks, in one function so a test can drive it over a fixture tree:
 * the 31 manifests against the tag, AND the three files derived from them. Composed here rather
 * than in the command body, because "the workflow refuses before `verify` does" is only a claim
 * until something can assert it on a tree that is not this one.
 */
export const releaseCheckFindings = async (
  root: string,
  version: string,
): Promise<readonly Finding[]> => [
  ...(await checkPackageShape(root, { release: version })),
  ...(await releaseWriteFindings(root)),
];
