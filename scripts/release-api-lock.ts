// The fourth file a bump derives: `scripts/lib/public-api.lock.json`, rewritten the way
// `bun run scripts/public-api.ts --write` rewrites it, so the lock's baseline is always the release
// just cut. Run AFTER the manifests and the changelog promotion: the lock records the new version,
// and a `BREAKING —` entry just moved into `docs/changelog/<version>.md` still declares its break.

import type { Finding } from './lib/log';
import { LOCK_PATH, renderLock } from './lib/public-api-breaks';
import type { PublicApiReport } from './public-api';
import { BREAK_CODE, publicApiReport, UNSCANNED_CODE } from './public-api';

/** The write as an operator runs it alone — the `fix:` of a bump whose lock step failed. */
export const API_LOCK_COMMAND = 'bun run scripts/public-api.ts --write --json';

/** What `--dry-run` prints for it, beside `RELEASE_WRITES`' three lines. */
export const plannedApiLockLine = (): string =>
  `  ${'api-lock'.padEnd(9)} would write ${LOCK_PATH} — every exported symbol's declaration hash (${API_LOCK_COMMAND})`;

export interface ApiLockOutcome {
  /** The one report line: what moved, or what could not. */
  readonly line: string;
  /** Present when no lock was written: the release is not done until it is. */
  readonly finding?: Finding;
}

/**
 * Write the lock for the tree at `root`. A surface that cannot be read is a finding carrying the
 * report's own cause and fix; an undeclared break still pending is written as the lock held it
 * (`nextLock`), so it keeps reporting after the release rather than being laundered by it.
 */
export async function writeApiLock(
  root: string,
  read: (root: string) => Promise<PublicApiReport> = publicApiReport,
): Promise<ApiLockOutcome> {
  const report = await read(root);
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
  const pending = report.findings.filter((one) => one.code === BREAK_CODE).length;
  return {
    line: `  ${'api-lock'.padEnd(9)} ${LOCK_PATH} recorded ${report.symbols} symbols at ${report.next.version}${pending > 0 ? ` — ${pending} undeclared break(s) still reported (${API_LOCK_COMMAND})` : ''}`,
  };
}
