// `x doctor`'s guard listing: the copies of shipped guards this app's `guards/` still holds. Every
// shipped guard runs from the installed framework (`guards-built-in.ts`), so none is ever missing;
// a copy runs in its place and never receives a fix, so each is listed with `x upgrade`, which
// migrates them (`codemods/vendored-guards.ts`). Never in the VERDICT: a warning beside it.

// why: Bun exposes no path-join primitive; Bun.file takes one already joined.
import { join } from 'node:path';
import { GUARD_DIR, guardPaths } from './guards';
import { vendoredPath, vendoredWarning } from './guards-built-in';
import { msg } from './messages';
import type { CommandResult, Finding, JsonValue } from './output';
import { SHIPPED_GUARD_NAMES, shippedGuardSources } from './templates/scaffold-guards';

/** The one command that migrates every copy. */
export const MIGRATE_GUARDS = 'x upgrade';

/** A shipped guard the app holds a copy of. */
export interface VendoredGuard {
  readonly name: string;
  /** The copy is a current template, so the migration deletes it; otherwise it is the app's edit. */
  readonly identical: boolean;
}

/** A guard file as the app holds it, path relative to the app root. */
export interface HeldGuard {
  readonly path: string;
  readonly source: string;
}

/** A checkout on Windows may write CRLF; the rule is the same text either way. */
export const sameText = (a: string, b: string): boolean =>
  a.replaceAll('\r\n', '\n') === b.replaceAll('\r\n', '\n');

/**
 * The rule, pure: which held guards carry a shipped name, and whether each is a current form of
 * it (`shippedGuardSources`). A guard with a name the framework never shipped is the app's own.
 */
export function vendoredShippedGuards(held: readonly HeldGuard[]): readonly VendoredGuard[] {
  const paths = held.map(({ path }) => path);
  const vendored: VendoredGuard[] = [];
  for (const name of SHIPPED_GUARD_NAMES) {
    const path = vendoredPath(paths, name);
    const source = held.find((guard) => guard.path === path)?.source;
    if (source === undefined) continue;
    const identical = shippedGuardSources(name).some((template) => sameText(source, template));
    vendored.push({ name, identical });
  }
  return vendored;
}

/** The I/O half: the same enumeration the `boundaries` step runs, so the two cannot disagree. */
export async function shippedGuardsProbe(root: string): Promise<readonly VendoredGuard[]> {
  const paths = (await guardPaths(root)).filter((path) => path.startsWith(`${GUARD_DIR}/`));
  const held = await Promise.all(
    paths.map(async (path) => ({ path, source: await Bun.file(join(root, path)).text() })),
  );
  return vendoredShippedGuards(held);
}

/**
 * The copies as ONE warning — the code the `boundaries` step lists too — so on `main` an
 * adopter's doctor keeps its exit status (`doctor-warnings.ts`). Empty when the app holds none.
 */
export function vendoredGuardWarnings(entries: readonly VendoredGuard[]): readonly Finding[] {
  return entries.length === 0 ? [] : [vendoredWarning(entries.map(({ name }) => name))];
}

/**
 * The listing, on a result `x doctor` already decided: `data.guards` for a machine — `missing`
 * always empty now, `differs` the edited copies, `vendored` every copy — and for a person, one
 * line and the command. `ok`, the summary and the findings are returned as they came.
 */
export function withGuardListing(
  result: CommandResult,
  entries: readonly VendoredGuard[],
): CommandResult {
  const data = typeof result.data === 'object' && result.data !== null ? result.data : {};
  const lines =
    entries.length === 0
      ? []
      : [msg('cli.doctor.guardsDiffer', { count: entries.length }), `  ${MIGRATE_GUARDS}`];
  const guards: JsonValue = {
    missing: [],
    differs: entries
      .filter(({ identical }) => !identical)
      .map(({ name }) => ({ name, refresh: MIGRATE_GUARDS })),
    vendored: entries.map(({ name }) => name),
  };
  return {
    ...result,
    data: { ...(data as Record<string, JsonValue>), guards },
    ...(lines.length === 0 ? {} : { lines: [...(result.lines ?? []), ...lines] }),
  };
}
