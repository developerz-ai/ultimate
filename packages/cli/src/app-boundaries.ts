// App-level import boundaries: the rules that keep the static path from paying for the app path
// (axiom 6) and keep layers from collapsing into each other.
//
// The three surface rules are `@ultimat3/render`'s `checkSurfaceBoundary` — the same check the
// build runs, transitive, naming the whole chain. The two layer rules below stay here because no
// package owns them: `service.ts` is not a primitive, and a route's ban on the database is about
// app layout, not about rendering.
//
// Runtime imports only: `Bun.Transpiler.scanImports` sees what survives type erasure, which is
// exactly the distinction the `app/ -> api/` rule needs (`import type` is allowed, a value
// import is not).

// Bun ships no `Bun.*` path API: `joinPath` reaches a file on disk with the host's separator.
import { join as joinPath } from 'node:path';
// The POSIX variants resolve specifiers against import-graph keys, which are POSIX on every host.
import { dirname, join, normalize, relative } from 'node:path/posix';
import type { BoundaryRule, ImportGraph } from '@ultimat3/render';
import { checkSurfaceBoundary, importGraph, SURFACES } from '@ultimat3/render';
import type { Finding } from './output';

export const BOUNDARY_CODES = [
  'X_BOUNDARY_SITE_TO_APP',
  'X_BOUNDARY_SHARED_LEAF',
  'X_BOUNDARY_APP_TO_API',
  'X_BOUNDARY_ROUTE_TO_DB',
  'X_BOUNDARY_SERVICE_TO_HTTP',
] as const;

export type BoundaryCode = (typeof BOUNDARY_CODES)[number];

export interface SourceFile {
  /** POSIX path relative to the app root, e.g. `apps/web/site/pricing/page.tsx`. */
  readonly path: string;
  readonly source: string;
}

const CODE_OF: Readonly<Record<BoundaryRule, BoundaryCode>> = {
  'site-imports-app': 'X_BOUNDARY_SITE_TO_APP',
  'shared-is-a-leaf': 'X_BOUNDARY_SHARED_LEAF',
  'app-imports-api-at-runtime': 'X_BOUNDARY_APP_TO_API',
};

/**
 * The one rule → diagnostic-code mapping. `x verify` reports a surface violation as a finding and
 * `x fix boundary` re-reports the same violation as a cut; a second copy of this table is the two
 * commands drifting onto different codes for one edge.
 */
export const boundaryCodeOf = (rule: BoundaryRule): BoundaryCode => CODE_OF[rule];

const docs = (code: BoundaryCode): string => `https://ultimate.dev/errors/${code}`;

const isRoute = (path: string): boolean => /\/(page|layout|route)\.[cm]?tsx?$/.test(path);
const isService = (path: string): boolean => /\/service\.[cm]?ts$/.test(path);
const isDbSpecifier = (specifier: string): boolean =>
  /(^|\/)packages\/db($|\/)/.test(specifier) ||
  specifier.endsWith('/db') ||
  /^@[^/]+\/db$/.test(specifier) ||
  specifier === 'drizzle-orm';
const isHttpSpecifier = (specifier: string): boolean =>
  specifier === '@ultimat3/http' || /(^|\/)http($|\/)/.test(specifier);

/** The transpiler rejects a shebang, and an app's `bin/` entry points legitimately have one. */
export const stripShebang = (source: string): string =>
  source.startsWith('#!') ? source.slice(source.indexOf('\n') + 1) : source;

/** Bun's transpiler is the parser; a regex fallback would miss re-exports and dynamic imports. */
export function scanRuntimeImports(file: SourceFile): readonly string[] {
  const loader = file.path.endsWith('x') ? 'tsx' : 'ts';
  const transpiler = new Bun.Transpiler({ loader });
  return transpiler.scanImports(stripShebang(file.source)).map((entry) => entry.path);
}

const CANDIDATE_SUFFIXES = ['', '.ts', '.tsx', '/index.ts', '/index.tsx'] as const;

/**
 * Resolve a relative specifier onto a real graph key. Extensions matter here and only here: an
 * edge that does not land on a key is a dead end, and the transitive walk stops one hop short.
 */
export function resolveSpecifier(
  fromFile: string,
  specifier: string,
  keys: ReadonlySet<string>,
): string {
  if (!specifier.startsWith('.')) return specifier;
  const base = normalize(join(dirname(fromFile), specifier));
  for (const suffix of CANDIDATE_SUFFIXES) {
    if (keys.has(`${base}${suffix}`)) return `${base}${suffix}`;
  }
  return base;
}

/**
 * The specifier `fromFile` must write to reach `target` — `resolveSpecifier` run backwards, and
 * what every import of a file has to become once that file moves. Extensionless, because that is
 * the form `CANDIDATE_SUFFIXES` resolves and the form every app source already writes.
 */
export function relativeSpecifier(fromFile: string, target: string): string {
  const path = relative(dirname(fromFile), target).replace(/\.[cm]?tsx?$/, '');
  return path.startsWith('.') ? path : `./${path}`;
}

interface ScannedFile {
  readonly path: string;
  readonly imports: readonly string[];
}

function scan(files: readonly SourceFile[]): readonly ScannedFile[] {
  const keys = new Set(files.map((file) => file.path));
  return files.map((file) => ({
    path: file.path,
    imports: scanRuntimeImports(file).map((specifier) =>
      resolveSpecifier(file.path, specifier, keys),
    ),
  }));
}

function graphOf(scanned: readonly ScannedFile[]): ImportGraph {
  const record: Record<string, readonly string[]> = {};
  for (const file of scanned) record[file.path] = file.imports;
  return importGraph(record);
}

const surfaceFindings = (graph: ImportGraph): readonly Finding[] =>
  checkSurfaceBoundary(graph).map((violation) => {
    const code = boundaryCodeOf(violation.rule);
    return {
      code,
      cause: violation.cause,
      fix: violation.fix,
      docs: docs(code),
      at: violation.importer,
    };
  });

/**
 * The surface names, from `@ultimat3/render`'s own list rather than a copy: a resource can never
 * be called one, because the directory carrying that name is the surface itself.
 */
const SURFACE_NAMES: ReadonlySet<string> = new Set<string>(SURFACES);

/**
 * `apps/web/app/posts/service.ts` → `posts`: the primitive a generator would be told to make.
 *
 * `undefined` at a surface ROOT, where the directory above the file is the surface. The old
 * answer there was the surface's own name, so `X_BOUNDARY_ROUTE_TO_DB` on `apps/web/site/page.tsx`
 * said `x g query site` — a runnable line that generates seven files and a `sites` table for a
 * landing page whose only problem is one import. A fix that does the wrong thing successfully is
 * worse than one that refuses, so the caller names the file and asks for a name instead.
 */
function subjectOf(path: string): string | undefined {
  const parent = path.split('/').at(-2);
  return parent === undefined || SURFACE_NAMES.has(parent) ? undefined : parent;
}

/**
 * `x g query posts` where the path names a resource, `x g query <name>` where it names a surface.
 * The placeholder form is the shape `MissingPositionalError` already hands out (`x g route
 * <name>`) and the one the `errors` step leaves unjudged in that slot — an open positional, where
 * a reader substituting a word makes the line run. The path rides in the `#` comment because a
 * `fix:` is copied on its own, and `Finding.at` is a field an agent pasting one line never sees.
 */
const generate = (kind: 'query' | 'action', path: string, then: string): string =>
  `x g ${kind} ${subjectOf(path) ?? '<name>'}   # ${then} ${path}`;

/**
 * Both fixes are one runnable line, with the rest of the instruction behind a `#` — a fix a
 * caller has to edit before it runs is prose, and prose is what "errors are instructions" bans.
 */
function layerFindings(scanned: readonly ScannedFile[]): readonly Finding[] {
  const findings: Finding[] = [];
  for (const file of scanned) {
    for (const specifier of file.imports) {
      if (isRoute(file.path) && isDbSpecifier(specifier)) {
        findings.push({
          code: 'X_BOUNDARY_ROUTE_TO_DB',
          cause: `route imports the database ("${specifier}") — routes call actions and queries`,
          fix: generate('query', file.path, 'then call it from'),
          docs: docs('X_BOUNDARY_ROUTE_TO_DB'),
          at: file.path,
        });
      }
      if (isService(file.path) && isHttpSpecifier(specifier)) {
        findings.push({
          code: 'X_BOUNDARY_SERVICE_TO_HTTP',
          cause: `service imports HTTP ("${specifier}") — a service that knows about requests cannot be reused by a job`,
          fix: generate('action', file.path, 'read the request there and pass plain values to'),
          docs: docs('X_BOUNDARY_SERVICE_TO_HTTP'),
          at: file.path,
        });
      }
    }
  }
  return findings;
}

/**
 * Check every app source file against both rule sets. Pure — callers do the I/O — so the dev
 * server can run this on every save and `x verify` can run it over a full file list.
 */
export function checkImportRules(files: readonly SourceFile[]): readonly Finding[] {
  const scanned = scan(files);
  return [...surfaceFindings(graphOf(scanned)), ...layerFindings(scanned)];
}

const APP_GLOBS = ['apps/*/{site,app,api,shared}/**/*.{ts,tsx}'];

/**
 * Read every source file under an app's site, app, api and shared surfaces (`APP_GLOBS`). The
 * only I/O in this module, and the one definition of "which files are the app's sources" —
 * `checkAppBoundaries` reads through this, and so does `x fix boundary`, never a second glob.
 */
export async function readAppSources(root: string): Promise<readonly SourceFile[]> {
  const files: SourceFile[] = [];
  for (const pattern of APP_GLOBS) {
    const glob = new Bun.Glob(pattern);
    for await (const path of glob.scan({ cwd: root, absolute: false })) {
      if (path.includes('node_modules') || path.includes('.test.')) continue;
      const posix = path.split('\\').join('/');
      files.push({ path: posix, source: await Bun.file(joinPath(root, posix)).text() });
    }
  }
  return files;
}

/** The resolved import graph over a file set — what `checkSurfaceBoundary` walks. */
export function appImportGraph(files: readonly SourceFile[]): ImportGraph {
  return graphOf(scan(files));
}

/** Read an app's sources and check them. */
export async function checkAppBoundaries(root: string): Promise<readonly Finding[]> {
  return checkImportRules(await readAppSources(root));
}
