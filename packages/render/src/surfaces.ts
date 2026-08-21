/**
 * The three surfaces plus `shared/`, and the hard import boundary between them.
 * `site/` must never reach `app/`, transitively, through any number of hops — that is
 * what makes axiom 6 ("the static path never pays for the app path") real rather than
 * aspirational. Violations are build errors, resolved through the whole chain.
 */

import type { RenderMode } from '@ultimat3/core';
import { SurfaceBoundaryError } from './errors';

export type Surface = 'site' | 'app' | 'api' | 'shared';

export const SURFACES = ['site', 'app', 'api', 'shared'] as const;

export interface SurfaceSpec {
  readonly surface: Surface;
  readonly defaultMode: RenderMode | null;
  readonly allowedModes: readonly RenderMode[];
  /** Bytes of JS a route on this surface ships before any island opts in. */
  readonly jsBaselineBytes: number;
  /** Surfaces this one may import at runtime. */
  readonly mayImport: readonly Surface[];
  /** Surfaces this one may reference with `import type` only. */
  readonly mayImportTypes: readonly Surface[];
}

export const SURFACE_SPECS = Object.freeze<Record<Surface, SurfaceSpec>>({
  site: {
    surface: 'site',
    defaultMode: 'static',
    allowedModes: ['static', 'isr', 'ssr'],
    jsBaselineBytes: 0,
    mayImport: ['shared'],
    mayImportTypes: ['shared'],
  },
  app: {
    surface: 'app',
    defaultMode: 'stream',
    allowedModes: ['stream', 'ssr'],
    jsBaselineBytes: 14_336,
    mayImport: ['shared'],
    mayImportTypes: ['shared', 'api'],
  },
  api: {
    surface: 'api',
    defaultMode: null,
    allowedModes: [],
    jsBaselineBytes: 0,
    mayImport: ['shared'],
    mayImportTypes: ['shared'],
  },
  shared: {
    surface: 'shared',
    defaultMode: null,
    allowedModes: [],
    jsBaselineBytes: 0,
    mayImport: [],
    mayImportTypes: [],
  },
});

const SURFACE_SEGMENT = /(?:^|\/)(site|app|api|shared)\//;

/** Where the surface segment is, and what follows it — the two halves of one match. */
export interface SurfaceLocation {
  readonly surface: Surface;
  /** Everything after `<surface>/`. `apps/myapp/app/dashboard/page.tsx` → `dashboard/page.tsx`. */
  readonly rest: string;
}

/**
 * The ONE reader of the surface segment, because the two readers disagreed: this regex is
 * anchored on a path separator, and the route table's `indexOf('app/')` was not — so
 * `apps/myapp/app/page.tsx` took its surface from here and its URL from the `app/` inside
 * `myapp/`, and served every route in that app one segment too deep (`/app` instead of `/`).
 */
export function locateSurface(file: string): SurfaceLocation | null {
  const normalized = normalize(file);
  const match = SURFACE_SEGMENT.exec(normalized);
  const found = match?.[1];
  if (found === undefined || match === null) return null;
  return { surface: found as Surface, rest: normalized.slice(match.index + match[0].length) };
}

/** `apps/web/site/pricing/page.tsx` → `site`. Returns null for files outside a surface. */
export function surfaceOf(file: string): Surface | null {
  return locateSurface(file)?.surface ?? null;
}

function normalize(file: string): string {
  return file.replace(/\\/g, '/').replace(/^\.\//, '');
}

export interface ImportRef {
  readonly file: string;
  /** `import type` edges cost zero bytes, so they never carry the surface boundary. */
  readonly type: boolean;
}

export type ImportGraph = ReadonlyMap<string, readonly ImportRef[]>;

/** Build a graph from a plain record; a bare string is a runtime (value) import. */
export function importGraph(
  record: Readonly<Record<string, readonly (string | ImportRef)[]>>,
): ImportGraph {
  const graph = new Map<string, readonly ImportRef[]>();
  for (const [file, imports] of Object.entries(record)) {
    graph.set(
      normalize(file),
      imports.map((i) =>
        typeof i === 'string'
          ? { file: normalize(i), type: false }
          : { ...i, file: normalize(i.file) },
      ),
    );
  }
  return graph;
}

export type BoundaryRule = 'site-imports-app' | 'shared-is-a-leaf' | 'app-imports-api-at-runtime';

export interface BoundaryViolation {
  readonly rule: BoundaryRule;
  /** The file the traversal started from — the reviewed file. */
  readonly entry: string;
  /** The file that actually writes the offending import. */
  readonly importer: string;
  /** The file it imports. */
  readonly imported: string;
  /** Full resolved chain, `entry → … → imported`. */
  readonly chain: readonly string[];
  readonly cause: string;
  readonly fix: string;
}

/**
 * Walk value-import edges from every file and report every crossing of the boundary.
 * Transitivity is the whole point: the import that costs you is three hops away from the
 * file anyone reviewed, so a direct-imports-only check finds nothing.
 */
export function checkSurfaceBoundary(graph: ImportGraph): readonly BoundaryViolation[] {
  const found = new Map<string, BoundaryViolation>();

  for (const entry of graph.keys()) {
    const entrySurface = surfaceOf(entry);
    if (entrySurface === null) continue;
    walk(graph, entry, entrySurface, found);
  }

  return [...found.values()].sort((a, b) => keyOf(a).localeCompare(keyOf(b)));
}

function keyOf(v: BoundaryViolation): string {
  return `${v.rule}|${v.importer}|${v.imported}`;
}

function walk(
  graph: ImportGraph,
  entry: string,
  entrySurface: Surface,
  found: Map<string, BoundaryViolation>,
): void {
  const seen = new Set<string>([entry]);
  const queue: string[][] = [[entry]];

  while (queue.length > 0) {
    const chain = queue.shift();
    if (chain === undefined) break;
    const current = chain[chain.length - 1];
    if (current === undefined) continue;

    for (const ref of graph.get(current) ?? []) {
      const importerSurface = surfaceOf(current);
      const importedSurface = surfaceOf(ref.file);
      const nextChain = [...chain, ref.file];

      const violation = classify({
        entry,
        entrySurface,
        importer: current,
        importerSurface,
        imported: ref.file,
        importedSurface,
        typeOnly: ref.type,
        chain: nextChain,
      });
      if (violation !== null) found.set(keyOf(violation), violation);

      // Type-only edges are erased at build time, so they cannot carry bytes onward.
      if (ref.type) continue;
      if (seen.has(ref.file)) continue;
      seen.add(ref.file);
      queue.push(nextChain);
    }
  }
}

interface ClassifyInput {
  readonly entry: string;
  readonly entrySurface: Surface;
  readonly importer: string;
  readonly importerSurface: Surface | null;
  readonly imported: string;
  readonly importedSurface: Surface | null;
  readonly typeOnly: boolean;
  readonly chain: readonly string[];
}

function classify(i: ClassifyInput): BoundaryViolation | null {
  const chainText = i.chain.join(' → ');

  if (i.entrySurface === 'site' && i.importedSurface === 'app' && !i.typeOnly) {
    return {
      rule: 'site-imports-app',
      entry: i.entry,
      importer: i.importer,
      imported: i.imported,
      chain: i.chain,
      cause: chainText,
      fix: `x fix boundary ${i.entry}   (or move ${i.imported} out of the shared graph)`,
    };
  }

  if (
    i.importerSurface === 'shared' &&
    (i.importedSurface === 'app' || i.importedSurface === 'site') &&
    !i.typeOnly
  ) {
    return {
      rule: 'shared-is-a-leaf',
      entry: i.entry,
      importer: i.importer,
      imported: i.imported,
      chain: i.chain,
      cause: `${chainText}  (shared/ is a leaf — it may not import a surface)`,
      fix: `move the shared part of ${i.imported} into shared/ and import it from ${i.importer}`,
    };
  }

  if (i.importerSurface === 'app' && i.importedSurface === 'api' && !i.typeOnly) {
    return {
      rule: 'app-imports-api-at-runtime',
      entry: i.entry,
      importer: i.importer,
      imported: i.imported,
      chain: i.chain,
      cause: `${chainText}  (app/ → api/ is types-only)`,
      fix: `change to \`import type\` in ${i.importer} and call the typed client instead`,
    };
  }

  return null;
}

/** Build-time gate. `x verify` and the dev server both call this. */
export function assertSurfaceBoundary(graph: ImportGraph): void {
  const violations = checkSurfaceBoundary(graph);
  const first = violations[0];
  if (first === undefined) return;

  const extra = violations.length > 1 ? ` (+${violations.length - 1} more)` : '';
  throw new SurfaceBoundaryError(`${first.cause}${extra}`, first.fix);
}

export function surfaceAllows(surface: Surface, mode: RenderMode): boolean {
  return SURFACE_SPECS[surface].allowedModes.includes(mode);
}
