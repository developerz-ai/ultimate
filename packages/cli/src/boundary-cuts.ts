// The pure planner behind `x fix boundary`: turns every `BoundaryViolation` chain that touches a
// target file into a printable cut — the one edge to delete — and, when relocating a `shared/`
// module is what removes that edge, the `git mv` plus every import specifier the move invalidates.
// No I/O: the caller has already read the sources and built the graph.

import type { BoundaryRule, BoundaryViolation, ImportGraph, Surface } from '@ultimat3/render';
import { checkSurfaceBoundary, surfaceOf } from '@ultimat3/render';
import type { BoundaryCode } from './app-boundaries';
import { boundaryCodeOf, relativeSpecifier, resolveSpecifier } from './app-boundaries';

/** One specifier the move invalidates: where it is written, what it names, what it must become. */
export interface SpecifierEdit {
  /** The file to edit, at the path it holds once the move is applied. */
  readonly file: string;
  /** The file the specifier resolves to today — how a caller finds it among that file's imports. */
  readonly imported: string;
  /** Its replacement, relative to `file`'s own directory after the move. */
  readonly specifier: string;
}

/** Generated only when moving the module is what removes the violated edge. */
export interface BoundarySplit {
  readonly module: string;
  readonly surface: Surface;
  readonly to: string;
  /** `git mv <module> <to>` — runnable as-is from the app root. */
  readonly command: string;
  /** Direct importers of `module` — the files whose specifier needs the new path. */
  readonly importers: readonly string[];
  /** The other half of the repair: every specifier `command` alone would leave dangling. */
  readonly edits: readonly SpecifierEdit[];
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
 * Every specifier the move breaks: each direct importer's path onto `module`, and `module`'s own
 * relative imports, which travel with the file and stop resolving from its new directory. A move
 * published without them is a repair that leaves the tree not building.
 */
function specifierEdits(
  graph: ImportGraph,
  module: string,
  to: string,
  importers: readonly string[],
): readonly SpecifierEdit[] {
  const keys = new Set(graph.keys());
  const edits: SpecifierEdit[] = importers.map((file) => ({
    file,
    imported: module,
    specifier: relativeSpecifier(file, to),
  }));
  for (const ref of graph.get(module) ?? []) {
    // Only edges that land on a scanned file: a bare package specifier does not move with the
    // file, and the graph never held the text of one, so a rewrite for it would be a guess.
    if (!keys.has(ref.file)) continue;
    // Sibling surfaces sit at the same depth, so a `../` specifier survives the move untouched.
    const written = relativeSpecifier(module, ref.file);
    if (resolveSpecifier(to, written, keys) === ref.file) continue;
    edits.push({ file: to, imported: ref.file, specifier: relativeSpecifier(to, ref.file) });
  }
  return edits;
}

/**
 * A relocation repairs a violation only when the module lands on the same surface as the file it
 * imports — that is what turns the flagged cross-surface edge into a legal same-surface one.
 * `site-imports-app` never qualifies: a module `site/` reaches carries the identical `site/ →
 * app/` edge into `site/` with it, so the move would relocate the file and fix nothing.
 */
const relocationRepairs = (violation: BoundaryViolation, surface: Surface): boolean =>
  violation.rule === 'shared-is-a-leaf' && surfaceOf(violation.imported) === surface;

/**
 * The `shared/` fattening remedy. One surface reaching `module` means it was never shared, so
 * the cut is mechanical. Two or more means it really is shared and a human has to decide which
 * part goes where — never invent a split the graph cannot justify.
 */
function planSplit(
  graph: ImportGraph,
  violation: BoundaryViolation,
  surfaces: readonly Surface[],
): BoundarySplit | null {
  if (surfaces.length !== 1) return null;
  const [surface] = surfaces;
  if (surface === undefined || !relocationRepairs(violation, surface)) return null;
  const module = violation.importer;
  const to = relocate(module, surface);
  const importers = directImporters(graph, module);
  return {
    module,
    surface,
    to,
    command: `git mv ${module} ${to}`,
    importers,
    edits: specifierEdits(graph, module, to, importers),
  };
}

/** The move alone is half a repair, so it is published with every rewrite it forces. */
const splitEdit = (split: BoundarySplit): string =>
  split.edits.length === 0
    ? split.command
    : `${split.command}   # then ${split.edits
        .map((edit) => `in ${edit.file}, ${edit.imported} → '${edit.specifier}'`)
        .join('; ')}`;

/**
 * No relocation clears this one, so the instruction is the edit itself: which import to delete,
 * and the two ways out — hoist what the module needs into the module, or invert the call so the
 * surface that reaches it passes the value in.
 */
function manualEdit(violation: BoundaryViolation, surfaces: readonly Surface[]): string {
  const reach = surfaces.length === 0 ? 'no surface' : surfaces.join(' and ');
  return `${violation.importer} is reached by ${reach}, so relocating it keeps the edge: delete the import of ${violation.imported} in ${violation.importer} — move what it needs into ${violation.importer}, or have the caller pass it in`;
}

function editFor(
  violation: BoundaryViolation,
  split: BoundarySplit | null,
  surfaces: readonly Surface[],
): string {
  if (split !== null) return splitEdit(split);
  if (violation.rule === 'app-imports-api-at-runtime') return violation.fix;
  if (surfaceOf(violation.importer) === 'shared') return manualEdit(violation, surfaces);
  return `delete the import of ${violation.imported} in ${violation.importer}`;
}

function toCut(violation: BoundaryViolation, graph: ImportGraph): BoundaryCut {
  const module = violation.importer;
  const surfaces = surfaceOf(module) === 'shared' ? surfacesReaching(graph, module) : [];
  const split = planSplit(graph, violation, surfaces);
  return {
    code: boundaryCodeOf(violation.rule),
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
