// `x doctor`'s guard listing: the copies of shipped guards this app's `guards/` still holds. Every
// shipped guard runs from the installed framework (`guards-built-in.ts`), so none is ever missing;
// a copy runs in its place and never receives a fix, so each is listed with its diff and the edit
// that resolves it (`guards-vendored.ts`). Never in the VERDICT: a warning beside it.

// why: Bun exposes no path-join primitive; Bun.file takes one already joined.
import { join } from 'node:path';
import { guardPaths } from './guards';
import { vendoredPath } from './guards-built-in';
import { resolvingEdit, type VendoredCopy, vendoredCopy, vendoredFinding } from './guards-vendored';
import { msg } from './messages';
import type { CommandResult, Finding, JsonValue } from './output';
import { SHIPPED_GUARD_NAMES } from './templates/scaffold-guards';

/** A guard file as the app holds it, path relative to the app root. */
export interface HeldGuard {
  readonly path: string;
  readonly source: string;
}

/**
 * The rule, pure: which held guards carry a shipped name, each judged against the shipped guard. A
 * guard with a name the framework never shipped is the app's own — `app-<name>` after the migration.
 */
export function vendoredShippedGuards(held: readonly HeldGuard[]): readonly VendoredCopy[] {
  const paths = held.map(({ path }) => path);
  const copies: VendoredCopy[] = [];
  for (const name of SHIPPED_GUARD_NAMES) {
    const path = vendoredPath(paths, name);
    const source = held.find((guard) => guard.path === path)?.source;
    if (path !== undefined && source !== undefined) copies.push(vendoredCopy(name, path, source));
  }
  return copies;
}

/** The I/O half: the same enumeration the `boundaries` step runs, so the two cannot disagree. */
export async function shippedGuardsProbe(root: string): Promise<readonly VendoredCopy[]> {
  const paths = await guardPaths(root);
  const held = await Promise.all(
    paths.map(async (path) => ({ path, source: await Bun.file(join(root, path)).text() })),
  );
  return vendoredShippedGuards(held);
}

/** One warning per copy — the code the `boundaries` step lists too — so the exit status stays. */
export const vendoredGuardWarnings = (copies: readonly VendoredCopy[]): readonly Finding[] =>
  copies.map(vendoredFinding);

/**
 * The listing, on a result `x doctor` already decided: `data.guards` for a machine — `missing`
 * always empty now, `differs` each edited copy with the edit that resolves it and its diff,
 * `vendored` every copy — and for a person, one line and an edit per copy. `ok`, the summary and
 * the findings are returned as they came.
 */
export function withGuardListing(
  result: CommandResult,
  copies: readonly VendoredCopy[],
): CommandResult {
  const data = typeof result.data === 'object' && result.data !== null ? result.data : {};
  const lines =
    copies.length === 0
      ? []
      : [
          msg('cli.doctor.guardsDiffer', { count: copies.length }),
          ...copies.map((copy) => `  ${resolvingEdit(copy)}`),
        ];
  const guards: JsonValue = {
    missing: [],
    differs: copies
      .filter(({ identical }) => !identical)
      .map((copy) => ({ name: copy.name, refresh: resolvingEdit(copy), diff: copy.diff ?? '' })),
    vendored: copies.map(({ name }) => name),
  };
  return {
    ...result,
    data: { ...(data as Record<string, JsonValue>), guards },
    ...(lines.length === 0 ? {} : { lines: [...(result.lines ?? []), ...lines] }),
  };
}
