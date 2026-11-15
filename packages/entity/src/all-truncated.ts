// Single responsibility: say, in development and test, that `.all()` dropped a next page — with the
// caller's line, once per line. `.all()` answers one page (`DEFAULT_PAGE_SIZE` rows unless the chain
// says `.limit(n)`), and a caller that meant "every row" learns otherwise only from a missing row.
// Refusing is a break, so the throw waits for `next`; in 31.x this is a coded `log.record` warning.

import { DEFAULT_ENVIRONMENT, logger, tryResolveEnvironment } from '@ultimat3/core';
import { DEFAULT_PAGE_SIZE } from './plan';

/** The one log message this writes: a subscriber matches `log.record`'s `message` against it. */
export const ALL_TRUNCATED = 'entity.all.truncated';

/** The warning's code, on `fields.code`. A refusal under the same code is `next`'s, not 31.x's. */
const CODE = 'X_ENTITY_ALL_TRUNCATED';

/** Sites already warned about. Bounded: past it a dev process has said enough, and stays quiet. */
const MAX_SITES = 1_000;
const warned = new Set<string>();

/** This package's own directory (`src/` or `dist/`): its frames are the chain, never the caller. */
const OWN = import.meta.dir;
const FRAME = /\(?((?:file:\/\/)?(?:\/|[A-Za-z]:[\\/])[^()]*?):(\d+):(\d+)\)?\s*$/;

/**
 * The first frame outside this package: the line that called `.all()`. Read after the page's
 * `await`, so it rides Bun's async stack — a caller that awaited the chain is named; one that
 * returned the promise un-awaited leaves no frame, and the site is `undefined`.
 */
function callSite(): string | undefined {
  const holder: { stack?: string } = {};
  Error.captureStackTrace(holder, reportTruncatedAll);
  for (const line of (holder.stack ?? '').split('\n').slice(1)) {
    const match = FRAME.exec(line);
    const file = match?.[1]?.replace(/^file:\/\//, '');
    if (file === undefined || (file.startsWith(OWN) && !file.includes('.test.'))) continue;
    const cwd = `${process.cwd()}/`;
    const shown = file.startsWith(cwd) ? file.slice(cwd.length) : file;
    return `${shown}:${match?.[2]}:${match?.[3]}`;
  }
  return undefined;
}

/**
 * Called by `.all()` with the page's `nextCursor`. Silent with no next page, when the chain said
 * `.limit(n)` (one page is what it asked for), in staging or production — the warning is for the
 * author, and staging exists to behave as production does — and for a site already warned about.
 * The stack is read only past those checks, so a production `.all()` pays nothing. `env` is the
 * test seam.
 */
export function reportTruncatedAll(
  entity: string,
  next: string | null,
  explicitLimit: boolean,
  env?: Readonly<Record<string, string | undefined>>,
): void {
  if (next === null || explicitLimit) return;
  const environment = tryResolveEnvironment(env === undefined ? undefined : { env });
  const at = environment ?? DEFAULT_ENVIRONMENT;
  if (at !== 'development' && at !== 'test') return;
  const site = callSite();
  const key = `${entity}@${site ?? '?'}`;
  if (warned.has(key) || warned.size >= MAX_SITES) return;
  warned.add(key);
  const where = site === undefined ? '' : ` at ${site}`;
  logger.warn(ALL_TRUNCATED, {
    code: CODE,
    entity,
    pageSize: DEFAULT_PAGE_SIZE,
    ...(site === undefined ? {} : { at: site }),
    cause: `${entity}.….all()${where} answered its first ${DEFAULT_PAGE_SIZE} rows and dropped the cursor to the rest`,
    fix: `${entity}.….inBatches(1000) to visit every row, one page per statement — or .limit(${DEFAULT_PAGE_SIZE}) on the chain to state that one page is meant; x g guard repo-unbounded finds every such read in a repo.ts`,
  });
}

/** TEST SEAM: forget every warned site. */
export function resetTruncatedSites(): void {
  warned.clear();
}
