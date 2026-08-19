// One rule: every published workspace is in the root build graph. `bun run typecheck` is `tsc -b`,
// which compiles referenced projects and nothing else — so a package no reference names is a
// package the gate's `typecheck` step reports green over without having read a line of it.

// Bun ships no equivalent: `join` builds the host-separator path from the scan root to the config.
// Nothing else here is `node:` — the read is `Bun.file`, and its rejection is also the answer for a
// root that has no `tsconfig.json` at all, so an `existsSync` ahead of it was a second question
// with one answer.
import { join } from 'node:path';
import { docsFor } from './error-codes';
import type { Finding } from './output';
import { maskLiterals, stripComments } from './ts-scan';

const ROOT_TSCONFIG = 'tsconfig.json';

/**
 * `./packages/cli`, `packages/cli/` and `packages/cli` are one project; the JSON allows all three.
 * Exported because "is this project already referenced?" is asked in three places — here,
 * `scripts/new-package.ts` when it adds an entry, and `scripts/reference-app-gate.ts` when it
 * checks an app — and a spelling one of them treats as a match and another does not is how the
 * scaffolder appends a duplicate entry the check already considered present.
 */
export const normalizeReferencePath = (path: string): string =>
  path.replace(/^\.\//, '').replace(/\/+$/, '');

/**
 * A tsconfig is JSONC and `JSON.parse` is not, so the comments and trailing commas `tsc` accepts —
 * and `tsc --init` writes — are removed before the parse. `Bun.file().json()` rejects both, and
 * the rejection was mapped to "this root does not use project references": the check went dark on
 * exactly the roots most likely to have been written by hand, while `typecheck` stayed green over
 * every package it then skipped. `stripComments` is `ts-scan.ts`'s, so a `//` inside a string is a
 * URL and not a comment; the trailing-comma pass reads MASKED text for the same reason.
 */
function parseJsonc(text: string): unknown {
  const uncommented = stripComments(text);
  const masked = maskLiterals(uncommented);
  const chars = [...uncommented];
  for (let i = 0; i < masked.length; i += 1) {
    if (masked[i] !== ',') continue;
    let next = i + 1;
    while (next < masked.length && /\s/.test(masked[next] as string)) next += 1;
    if (masked[next] === '}' || masked[next] === ']') chars[i] = ' ';
  }
  return JSON.parse(chars.join('')) as unknown;
}

/**
 * `undefined` means "this root does not use project references" — a different repo shape, not an
 * empty graph. A scaffolded app is that shape (`extends` + `include`, no references at all), and
 * telling its author to add an entry to a list that does not exist is a fix that makes the build
 * worse. A tsconfig that will not parse EVEN AS JSONC is `typecheck`'s to report, with tsc's own
 * message — this check has no code that would mean "the file is broken" and must not borrow one
 * that means something else.
 */
async function referencedPaths(root: string): Promise<ReadonlySet<string> | undefined> {
  const payload: unknown = await Bun.file(join(root, ROOT_TSCONFIG))
    .text()
    .then(parseJsonc)
    .catch(() => undefined);
  const references =
    typeof payload === 'object' && payload !== null
      ? (payload as { references?: unknown }).references
      : undefined;
  if (!Array.isArray(references)) return undefined;
  return new Set(
    references.flatMap((entry: unknown) => {
      const value =
        typeof entry === 'object' && entry !== null
          ? (entry as { path?: unknown }).path
          : undefined;
      return typeof value === 'string' ? [normalizeReferencePath(value)] : [];
    }),
  );
}

/**
 * The edit, spelled out: the array to add to, the entry to add, and the command that proves it
 * took. `tsc -b` is the same one the gate's `typecheck` step runs, so a reader who runs the fix
 * runs the check.
 */
export const unreferencedFinding = (dir: string): Finding => ({
  code: 'X_PACKAGE_UNREFERENCED',
  cause: `packages/${dir} is a published workspace and ${ROOT_TSCONFIG} has no reference to it, so tsc -b never builds it`,
  fix: `add { "path": "./packages/${dir}" } to "references" in ${ROOT_TSCONFIG}, then run bunx tsc -b --pretty false`,
  docs: docsFor('X_PACKAGE_UNREFERENCED'),
  at: ROOT_TSCONFIG,
});

/**
 * Published workspaces only. A private package is not a shipped contract and a generated app's
 * `packages/*` are all private, so this asks nothing of an app that never publishes — the same
 * line `checkPublishShape` already draws.
 */
export async function checkRootReferences(
  root: string,
  dirs: readonly string[],
): Promise<readonly Finding[]> {
  const referenced = await referencedPaths(root);
  if (referenced === undefined) return [];
  return dirs
    .filter((dir) => !referenced.has(`packages/${dir}`))
    .map((dir) => unreferencedFinding(dir));
}
