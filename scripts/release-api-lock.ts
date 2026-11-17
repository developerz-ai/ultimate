// The fourth file a bump derives: `scripts/lib/public-api.lock.json`, rewritten the way
// `bun run scripts/public-api.ts --write` rewrites it, so the lock's baseline is always the release
// just cut, holding nothing the tree does not. A pending undeclared break refuses the bump before its
// first write (`pendingBreaks`); the lock records the new version, and a `BREAKING —` entry just
// moved into `docs/changelog/<version>.md` still declares its break.

import type { Finding } from './lib/log';
import { LOCK_PATH, renderLock } from './lib/public-api-lock';
import type { PublicApiReport } from './public-api';
import { BREAK_CODE, publicApiReport, UNSCANNED_CODE } from './public-api';

/** The write as an operator runs it alone — the `fix:` of a bump whose lock step failed. */
export const API_LOCK_COMMAND = 'bun run scripts/public-api.ts --write --json';

/** What `--dry-run` prints for it, beside `RELEASE_WRITES`' three lines. */
export const plannedApiLockLine = (): string =>
  `  ${'api-lock'.padEnd(9)} would write ${LOCK_PATH} — every exported symbol's declaration hash and shape (${API_LOCK_COMMAND})`;

export interface ApiLockOutcome {
  /** The one report line: what moved, or what could not. */
  readonly line: string;
  /** Present when no lock was written: the release is not done until it is. */
  readonly finding?: Finding;
}

/** The surface at `root` judged as `version`: what a bump checks before its first write. */
export const readApiAt = (root: string, version: string): Promise<PublicApiReport> =>
  publicApiReport(root, { version });

/**
 * The undeclared breaks a release refuses on. Caught before it ships, a break can still be
 * reverted, or moved to `next` and declared there; once shipped, no changelog line can clear it.
 */
export const pendingBreaks = (report: PublicApiReport): readonly Finding[] =>
  report.findings.filter((one) => one.code === BREAK_CODE);

/**
 * Write the lock for the tree at `root`: the tree as it ships, nothing held. A surface that cannot
 * be read is a finding carrying the report's own cause and fix; an undeclared break still pending
 * writes nothing and is the finding, never a held entry carried into every later release.
 */
export async function writeApiLock(
  root: string,
  read: (root: string) => Promise<PublicApiReport> = publicApiReport,
): Promise<ApiLockOutcome> {
  const report = await read(root);
  const pending = pendingBreaks(report);
  const [first] = pending;
  if (first !== undefined) {
    return {
      line: `  ${'api-lock'.padEnd(9)} NOT written — ${pending.length} undeclared break(s) pending`,
      finding: first,
    };
  }
  if (report.next === undefined) {
    const [first] = report.findings;
    return {
      line: `  ${'api-lock'.padEnd(9)} NOT written — the public surface could not be read`,
      finding: {
        code: first?.code ?? UNSCANNED_CODE,
        cause: `${LOCK_PATH} was not rewritten by this bump: ${first?.cause ?? 'the public surface could not be read'}`,
        fix: first?.fix ?? API_LOCK_COMMAND,
        at: LOCK_PATH,
      },
    };
  }
  await Bun.write(`${root}/${LOCK_PATH}`, renderLock(report.next));
  return {
    line: `  ${'api-lock'.padEnd(9)} ${LOCK_PATH} recorded ${report.symbols} symbols at ${report.next.version}`,
  };
}
