// The pure planner behind `x fix boundary`: turns every `BoundaryViolation` chain that touches
// a target file into a printable cut — the one edge to delete — and, when a `shared/` module
// only ever serves one surface, the `git mv` that gets it out of `shared/` before a human has
// to work that out by hand. No I/O: the caller has already read the sources and built the graph.

import type { BoundaryRule, BoundaryViolation, ImportGraph, Surface } from '@ultimat3/render';
import { checkSurfaceBoundary, surfaceOf } from '@ultimat3/render';
import type { BoundaryCode } from './app-boundaries';

// `checkSurfaceBoundary` reports a `rule`; a `Finding` needs one of the CLI's own `X_BOUNDARY_*`
// codes. `app-boundaries.ts` keeps the identical mapping privately for its own findings — three
// literals duplicated here rather than exported, so that file's surface stays exactly the two
// functions this planner actually needs (the sources, the graph).
const CODE_OF: Readonly<Record<BoundaryRule, BoundaryCode>> = {
  'site-imports-app': 'X_BOUNDARY_SITE_TO_APP',
  'shared-is-a-leaf': 'X_BOUNDARY_SHARED_LEAF',
  'app-imports-api-at-runtime': 'X_BOUNDARY_APP_TO_API',
};

/** Generated only when exactly one surface reaches the offending `shared/` module. */
export interface BoundarySplit {
  readonly module: string;
  readonly surface: Surface;
  readonly to: string;
  /** `git mv <module> <to>` — runnable as-is from the app root. */
  readonly command: string;
  /** Direct importers of `module` — the files whose specifier needs the new path. */
  readonly importers: readonly string[];
}

export interface BoundaryCut {
  readonly code: BoundaryCode;
  readonly rule: BoundaryRule;
  readonly entry: string;
  /** The file to edit. */
  readonly at: string;
  /** The single edge a caller can delete to clear this violation. */
  readonly edge: { readonly from: string; readonly to: string };
  readonly chain: readonly string[];
  readonly cause: string;
  readonly edit: string;
  readonly split: BoundarySplit | null;
}

const involves = (violation: BoundaryViolation, target: string): boolean =>
  violation.entry === target || violation.importer === target || violation.chain.includes(target);

function reverseGraph(graph: ImportGraph): ReadonlyMap<string, ReadonlySet<string>> {
  const reverse = new Map<string, Set<string>>();
  for (const [file, refs] of graph) {
    for (const ref of refs) {
      const predecessors = reverse.get(ref.file) ?? new Set<string>();
      predecessors.add(file);
      reverse.set(ref.file, predecessors);
    }
  }
  return reverse;
}

/** Files with a specifier that resolves straight onto `module` — exactly who `git mv` breaks. */
function directImporters(graph: ImportGraph, module: string): readonly string[] {
  const found: string[] = [];
  for (const [file, refs] of graph) {
    if (refs.some((ref) => ref.file === module)) found.push(file);
  }
  return found.sort();
}

/**
 * Every non-`shared/` surface that transitively reaches `module`, through any number of further
 * `shared/` hops. That is what "actually reach" means: a `shared/` re-export only counts once
 * the walk lands outside `shared/` entirely.
 */
function surfacesReaching(graph: ImportGraph, module: string): readonly Surface[] {
  const reverse = reverseGraph(graph);
  const seen = new Set<string>([module]);
  const queue: string[] = [module];
  const surfaces = new Set<Surface>();
  while (queue.length > 0) {
    const current = queue.shift();
    if (current === undefined) break;
    for (const predecessor of reverse.get(current) ?? []) {
      const surface = surfaceOf(predecessor);
      if (surface !== null && surface !== 'shared') surfaces.add(surface);
      if (seen.has(predecessor)) continue;
      seen.add(predecessor);
      queue.push(predecessor);
    }
  }
  return [...surfaces].sort();
}

/** `apps/web/shared/ui/panel.tsx` relocated under `app/` → `apps/web/app/ui/panel.tsx`. */
const relocate = (path: string, surface: Surface): string =>
  path.replace(/(^|\/)shared\//, `$1${surface}/`);

/**
 * The `shared/` fattening remedy. One surface reaching `module` means it was never shared, so
 * the cut is mechanical. Two or more means it really is shared and a human has to decide which
 * part goes where — never invent a split the graph cannot justify.
 */
function planSplit(
  graph: ImportGraph,
  module: string,
  surfaces: readonly Surface[],
): BoundarySplit | null {
  if (surfaces.length !== 1) return null;
  const [surface] = surfaces;
  if (surface === undefined) return null;
  const to = relocate(module, surface);
  return {
    module,
    surface,
    to,
    command: `git mv ${module} ${to}`,
    importers: directImporters(graph, module),
  };
}

function editFor(
  violation: BoundaryViolation,
  split: BoundarySplit | null,
  surfaces: readonly Surface[],
): string {
  if (split !== null) return split.command;
  if (violation.rule === 'app-imports-api-at-runtime') return violation.fix;
  if (surfaceOf(violation.importer) === 'shared') {
    const reach = surfaces.length === 0 ? 'no surface' : surfaces.join(' and ');
    return `${violation.importer} is reached by ${reach} — split it by hand, then delete the import of ${violation.imported} there`;
  }
  return `delete the import of ${violation.imported} in ${violation.importer}`;
}

function toCut(violation: BoundaryViolation, graph: ImportGraph): BoundaryCut {
  const module = violation.importer;
  const eligible =
    (violation.rule === 'shared-is-a-leaf' || violation.rule === 'site-imports-app') &&
    surfaceOf(module) === 'shared';
  const surfaces = eligible ? surfacesReaching(graph, module) : [];
  const split = eligible ? planSplit(graph, module, surfaces) : null;
  return {
    code: CODE_OF[violation.rule],
    rule: violation.rule,
    entry: violation.entry,
    at: violation.importer,
    edge: { from: violation.importer, to: violation.imported },
    chain: violation.chain,
    cause: violation.cause,
    edit: editFor(violation, split, surfaces),
    split,
  };
}

/**
 * Every boundary violation that touches `target`, turned into a printable cut. Pure — the
 * caller has already read the app's sources and built the graph (`readAppSources` +
 * `appImportGraph`), so this runs the same way in a test as it does in the CLI.
 */
export function planBoundaryCuts(target: string, graph: ImportGraph): readonly BoundaryCut[] {
  return checkSurfaceBoundary(graph)
    .filter((violation) => involves(violation, target))
    .map((violation) => toCut(violation, graph));
}
