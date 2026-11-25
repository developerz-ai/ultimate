// An import that failed inside an installed package, explained from the app's side: the app module
// that pulled the package in, the chain to the failing import, and the edit or install that clears
// it. The bare finding names a file under `node_modules`, which no reader can edit.
// Loaded only when a load has already failed (`app-load.ts`).

// why: Bun ships no path API; the failing module is named app-root-relative and walked absolute.
import { resolve } from 'node:path';
import type { UnresolvedImport } from './app-load-unresolved';
import { realPath, unresolvedImport } from './app-load-unresolved';
import type { DevOnlyCut } from './dev-only-imports';
import { devOnlyCut, devOnlyFix, isDevOnlySpecifier, scannedModules } from './dev-only-imports';
import type { ChainStep } from './evaluated-walk';
import { createEvaluatedGraph } from './evaluated-walk';
import type { Finding } from './output';
import { findingFrom } from './output';
import { hasPathSegment, isPathUnder } from './path-segments';
import { posixRelative } from './posix-path';

/** `…/node_modules/@ultimat3/cli/src/index.ts` → `@ultimat3/cli/src/index.ts`, under any linker. */
const shown = (path: string): string => path.replace(/^.*\bnode_modules\//, '');

/** What the app does to reach the package: the module to edit, its import, and the way down. */
interface Entry {
  readonly at: string;
  readonly specifier: string;
  /** App-root-relative: the module to edit first, the failing module last. */
  readonly chain: readonly string[];
  /** The import by which the chain leaves the app: `specifier`, unless the edit is further up. */
  readonly leavesBy: string;
  /** The gate's own cut, when the import that leaves the app is one no role may load. */
  readonly cut?: DevOnlyCut;
}

/**
 * The last module of the app's own on the chain, and what it imports out of the app. When that is a
 * development entry the edit is the gate's (`devOnlyCut`): a kit outside the scan is not what moves.
 */
async function entryOf(
  steps: readonly ChainStep[],
  root: string,
  scanned: () => Promise<ReadonlySet<string>>,
): Promise<Entry | undefined> {
  const paths = steps.map((step) => posixRelative(root, step.path));
  const own = steps.findLastIndex(
    (step, index) =>
      isPathUnder(root, step.path) && !hasPathSegment(paths[index] ?? '', 'node_modules'),
  );
  const leavesBy = steps[own + 1]?.specifier;
  if (own === -1 || leavesBy === undefined) return undefined;
  const cut = isDevOnlySpecifier(leavesBy)
    ? devOnlyCut(steps.slice(0, own + 1), await scanned())
    : undefined;
  const from = cut?.index ?? own;
  return {
    at: paths[from] ?? '',
    specifier: cut?.into ?? leavesBy,
    chain: paths.slice(from),
    leavesBy,
    ...(cut === undefined ? {} : { cut }),
  };
}

/** The finding told from `entry`: the install's fix, unless the app's import is the defect. */
function retold(found: UnresolvedImport, entry: Entry): Finding {
  const { at, specifier, leavesBy, cut } = entry;
  const brings = specifier === leavesBy ? '' : `, which brings in "${leavesBy}"`;
  const refused = cut === undefined ? '' : ', a development entry no role may load';
  const chain = [...entry.chain.map(shown), found.specifier].join(' → ');
  return {
    code: 'X_APP_IMPORT_UNRESOLVED',
    cause: `${at} imports "${specifier}"${brings}${refused}, and that reaches ${found.missing}: ${chain}`,
    fix: cut === undefined ? found.fix : devOnlyFix(at, cut, leavesBy),
    at,
    meta: { specifier: found.specifier, chain: [...entry.chain] },
  };
}

/**
 * One scan's explanations. The graph is shared: a package that would not load fails every module
 * that reaches it, and each is explained over the same parsed edges.
 */
export function dependencyImports(
  root: string,
): (error: unknown, file: string) => Promise<Finding> {
  const base = realPath(resolve(root));
  const graph = createEvaluatedGraph();
  let modules: Promise<ReadonlySet<string>> | undefined;
  // Globbed at most once, however many modules fail.
  const scanned = (): Promise<ReadonlySet<string>> => {
    modules ??= scannedModules(base);
    return modules;
  };
  return async (error, file) => {
    const found = unresolvedImport(error, root);
    if (found?.referrer === undefined) return { ...findingFrom(error), at: file };
    const target = realPath(found.referrer);
    const walk = await graph.walk([realPath(resolve(base, file))], (edge) =>
      edge.target() === target ? 'stop' : 'follow',
    );
    const entry = await entryOf(walk.chainTo(target), base, scanned);
    if (entry !== undefined) return retold(found, entry);
    // Reached through an import no source spells (`import(variable)`): the module the load was
    // importing is still the one its reader can open.
    return {
      code: 'X_APP_IMPORT_UNRESOLVED',
      cause: `importing ${file}: ${posixRelative(base, target)} imports ${found.missing}`,
      fix: found.fix,
      at: file,
      meta: { specifier: found.specifier },
    };
  };
}
