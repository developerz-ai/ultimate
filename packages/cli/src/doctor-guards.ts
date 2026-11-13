// `x doctor`'s guard listing: the shipped guards this app's `guards/` does not hold, and the ones
// it holds in a form that is not the current template — each with the command that writes it.
// Never in the VERDICT: every shipped guard is the app's copy ("delete this file to drop the
// rule"), so a missing one is a warning beside it (`data.warnings`) and an edited one a listing.

// why: Bun exposes no path-join primitive; Bun.file takes one already joined.
import { join } from 'node:path';
import { ERROR_DOCS_URL } from '@ultimat3/core';
import { GUARD_DIR, guardPaths } from './guards';
import { msg } from './messages';
import type { CommandResult, Finding, JsonValue } from './output';
import { SHIPPED_GUARD_NAMES, shippedGuardSource } from './templates/scaffold-guards';

export interface MissingGuard {
  readonly name: string;
  /** The command that writes it, with its test. Then `x verify` says what it finds. */
  readonly add: string;
}

/** The rule, pure: which shipped names have no file among the guards an app holds. */
export function missingShippedGuards(present: readonly string[]): readonly MissingGuard[] {
  const held = new Set(present.map((path) => path.replace(/\.tsx?$/, '')));
  return SHIPPED_GUARD_NAMES.filter((name) => !held.has(`${GUARD_DIR}/${name}`)).map((name) => ({
    name,
    add: `x g guard ${name}`,
  }));
}

export const MISSING_GUARD = 'X_SHIPPED_GUARD_MISSING';

/**
 * A missing shipped guard as a WARNING, one per guard: the gate does not hold this app to that
 * rule, and "no findings — environment is shippable" alone said nothing of it. A warning and not a
 * finding, so on `main` an adopter's doctor keeps its exit status (`doctor-warnings.ts`).
 */
export function missingGuardWarnings(entries: readonly GuardListingEntry[]): readonly Finding[] {
  return entries
    .filter((entry): entry is MissingGuard => 'add' in entry)
    .map(({ name, add }) => ({
      code: MISSING_GUARD,
      cause: `${GUARD_DIR}/${name}.ts is not in this app, so x verify does not hold it to the shipped ${name} rule`,
      fix: `${add} && x verify --only boundaries --json`,
      docs: ERROR_DOCS_URL,
      at: `${GUARD_DIR}/${name}.ts`,
    }));
}

export interface DifferingGuard {
  readonly name: string;
  /** Rewrites the guard and its test from the current template. Review the diff, then keep it. */
  readonly refresh: string;
}

/** One line of the listing: a shipped guard the app lacks, or holds in another form. */
export type GuardListingEntry = MissingGuard | DifferingGuard;

/** A guard file as the app holds it, path relative to the app root. */
export interface HeldGuard {
  readonly path: string;
  readonly source: string;
}

/** A checkout on Windows may write CRLF; the rule is the same text either way. */
const sameText = (a: string, b: string): boolean =>
  a.replaceAll('\r\n', '\n') === b.replaceAll('\r\n', '\n');

/**
 * The rule, pure: which held guards carry a shipped name and are not that guard's current
 * template. A guard with a name the framework never shipped is the app's own, and has no template.
 */
export function differingShippedGuards(held: readonly HeldGuard[]): readonly DifferingGuard[] {
  const differing: DifferingGuard[] = [];
  for (const { path, source } of held) {
    const name = path.slice(`${GUARD_DIR}/`.length).replace(/\.tsx?$/, '');
    const template = shippedGuardSource(name);
    if (template === undefined || sameText(source, template)) continue;
    differing.push({ name, refresh: `x g guard ${name} --force` });
  }
  return differing;
}

/** The I/O half: the same enumeration the `boundaries` step runs, so the two cannot disagree. */
export async function shippedGuardsProbe(root: string): Promise<readonly GuardListingEntry[]> {
  const paths = await guardPaths(root);
  const held = await Promise.all(
    paths.map(async (path) => ({ path, source: await Bun.file(join(root, path)).text() })),
  );
  const entries: GuardListingEntry[] = [
    ...missingShippedGuards(paths),
    ...differingShippedGuards(held),
  ];
  return entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

/**
 * The listing, on a result `x doctor` already decided: `data.guards` for a machine; for a person,
 * a line per differing guard — a missing one's command is its warning's line, never printed twice.
 * `ok`, the summary and the findings are returned as they came.
 */
export function withGuardListing(
  result: CommandResult,
  entries: readonly GuardListingEntry[],
): CommandResult {
  const data = typeof result.data === 'object' && result.data !== null ? result.data : {};
  const missing = entries.filter((entry): entry is MissingGuard => 'add' in entry);
  const differs = entries.filter((entry): entry is DifferingGuard => 'refresh' in entry);
  const lines = [
    ...(differs.length === 0
      ? []
      : [
          msg('cli.doctor.guardsDiffer', { count: differs.length }),
          ...differs.map(({ refresh }) => `  ${refresh}`),
        ]),
  ];
  const guards: JsonValue = {
    missing: missing.map(({ name, add }) => ({ name, add })),
    differs: differs.map(({ name, refresh }) => ({ name, refresh })),
  };
  return {
    ...result,
    data: { ...(data as Record<string, JsonValue>), guards },
    ...(lines.length === 0 ? {} : { lines: [...(result.lines ?? []), ...lines] }),
  };
}
