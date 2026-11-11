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
//
// The browser-transport rule rides the same read: `boundary-findings.ts`'s `appBoundaryFindings`
// hands the files read here to `app-transport.ts`, so a raw `fetch(` in an island is a finding of
// this step with no second walk of the app.

// Bun ships no `Bun.*` path API: `joinPath` reaches a file on disk with the host's separator.
import { join as joinPath } from 'node:path';
// The POSIX variants resolve specifiers against import-graph keys, which are POSIX on every host.
import { dirname, join, normalize, relative } from 'node:path/posix';
import { ADAPTER_PORTS, ERROR_DOCS_URL, SURFACES } from '@ultimat3/core';
import type { BoundaryRule, ImportGraph, ImportRef } from '@ultimat3/render';
import { checkSurfaceBoundary, importGraph, surfaceOf } from '@ultimat3/render';
import { loaderImportFindings } from './app-loader-imports';
import { commentSafe } from './comment-safe';
import { scanRuntimeImports, stripShebang } from './import-scan';
import type { Finding } from './output';
import { hasPathSegment } from './path-segments';
import { toPosix } from './posix-path';
import { quoteArg } from './shell-quote';

export const BOUNDARY_CODES = [
  'X_BOUNDARY_SITE_TO_APP',
  'X_BOUNDARY_SHARED_LEAF',
  'X_BOUNDARY_APP_TO_API',
  'X_BOUNDARY_ROUTE_TO_DB',
  'X_BOUNDARY_SERVICE_TO_HTTP',
  'X_BOUNDARY_SURFACE_IMPORT',
  'X_BOUNDARY_ADAPTER_IMPORT',
  'X_BOUNDARY_LOADER_IMPORT',
  // `package-boundaries.ts`'s: it reads `packages/`, which this module's surface graph never holds.
  'X_BOUNDARY_PACKAGE_TO_APP',
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
  // Every other crossing `SURFACE_SPECS` does not allow: the table is the rule (`@ultimat3/render`).
  'surface-imports-surface': 'X_BOUNDARY_SURFACE_IMPORT',
};

/**
 * The one rule → diagnostic-code mapping. `x verify` reports a surface violation as a finding and
 * `x fix boundary` re-reports the same violation as a cut; a second copy of this table is the two
 * commands drifting onto different codes for one edge.
 */
export const boundaryCodeOf = (rule: BoundaryRule): BoundaryCode => CODE_OF[rule];

const isRoute = (path: string): boolean => /\/(page|layout|route)\.[cm]?tsx?$/.test(path);
const isService = (path: string): boolean => /\/service\.[cm]?ts$/.test(path);
/**
 * A slice's `repo.ts` counts: it is the typed handle one hop away, and a page reading it skips the
 * query that carries the read's policy, bound and cache tag — the scaffold's own dashboard showed
 * every post to a viewer holding `dashboard:read` alone. Matched as a whole module name, resolved
 * (`…/repo.ts`), NodeNext-spelled (`./repo.js`, `.mjs`, `.cjs`) or bare (`../post/repo`), so
 * `report` and `repository` are names, not repos. A `repo-<part>` module is the same repo split at
 * the file ceiling (`repo-window.ts`): without it the split was a door around this rule.
 */
const isRepoSpecifier = (specifier: string): boolean =>
  /(^|\/)repo(-[a-z0-9]+)*(\/index)?(\.[cm]?[jt]sx?)?$/.test(specifier);
const isDbSpecifier = (specifier: string): boolean =>
  /(^|\/)packages\/db($|\/)/.test(specifier) ||
  specifier.endsWith('/db') ||
  /^@[^/]+\/db$/.test(specifier) ||
  specifier === 'drizzle-orm' ||
  isRepoSpecifier(specifier);
/**
 * `node:http` and `node:https` are HTTP too, and the anchor could not reach them: `http` had to
 * follow a `/` or start the string, and a `node:` specifier has a colon there. So the one spelling
 * that needs no dependency at all — a service reaching straight for the runtime's own client — was
 * the one spelling this rule could not see. Matched on the boundary character rather than by
 * listing every prefix, and still anchored at both ends: `node:http2-fake` and
 * `@ultimat3/https-client` are names, not HTTP.
 */
const isHttpSpecifier = (specifier: string): boolean =>
  specifier === '@ultimat3/http' || /(^|[/:])https?($|\/)/.test(specifier);

export { scanRuntimeImports, stripShebang };

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
  if (!specifier.startsWith('.')) return workspaceKey(specifier, keys) ?? specifier;
  const base = normalize(join(dirname(fromFile), specifier));
  for (const suffix of CANDIDATE_SUFFIXES) {
    if (keys.has(`${base}${suffix}`)) return `${base}${suffix}`;
  }
  return base;
}

/**
 * `@<scope>/<app>/<rest>` → `apps/<app>/<rest>` when that lands on an app source: the spelling one
 * app workspace reaches another by (`x new`'s root alias `@<app>/*` → `packages/*\/src`, then
 * `apps/*`). Left unresolved, `apps/api/site/` importing `@acme/web/app/…` was an edge to nowhere
 * and `X_BOUNDARY_SITE_TO_APP` never fired. Matched against the graph's own keys — a framework or
 * package specifier lands on none — so a workspace whose package name differs from its directory
 * is the one spelling this cannot see.
 */
const workspaceKey = (specifier: string, keys: ReadonlySet<string>): string | undefined => {
  const [, app, rest] = /^@[^/]+\/([^/]+)\/(.+)$/.exec(specifier) ?? [];
  if (app === undefined || rest === undefined) return undefined;
  const base = `apps/${app}/${rest}`;
  return CANDIDATE_SUFFIXES.map((suffix) => `${base}${suffix}`).find((key) => keys.has(key));
};

/**
 * The specifier `fromFile` must write to reach `target` — `resolveSpecifier` run backwards, and
 * what every import of a file has to become once that file moves. Extensionless, because that is
 * the form `CANDIDATE_SUFFIXES` resolves and the form every app source already writes.
 */
export function relativeSpecifier(fromFile: string, target: string): string {
  // Through `toPosix` even over the POSIX `relative`: a key spelt `apps\web\…` is ONE segment to
  // it, and the specifier came out `./apps\web\…` — an import no host resolves.
  const path = relative(dirname(toPosix(fromFile)), toPosix(target)).replace(/\.[cm]?tsx?$/, '');
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

/** `apps/<ws>/…` → `<ws>`, or `undefined` outside an app workspace. */
const workspaceOf = (path: string): string | undefined => /^apps\/([^/]+)\//.exec(path)?.[1];

/**
 * An `app/` module reaching a SIBLING app's `api/` registry. `app/ → api/` is types-only inside
 * one app because that app's `api/index.ts` imports its own `app/` slices — a value edge back is a
 * cycle. Across workspaces there is none: `apps/admin` projecting `apps/web`'s actions through its
 * `api` is the documented pattern. Such an edge enters the graph as declaration-only, which the
 * table admits for `app` and still refuses for `site` (`SURFACE_SPECS`).
 */
const isSiblingRegistry = (from: string, to: string): boolean => {
  const own = workspaceOf(from);
  const other = workspaceOf(to);
  return (
    own !== undefined &&
    other !== undefined &&
    own !== other &&
    surfaceOf(from) === 'app' &&
    surfaceOf(to) === 'api'
  );
};

function graphOf(scanned: readonly ScannedFile[]): ImportGraph {
  const record: Record<string, readonly ImportRef[]> = {};
  for (const file of scanned) {
    record[file.path] = file.imports.map((to) => ({
      file: to,
      type: isSiblingRegistry(file.path, to),
    }));
  }
  return importGraph(record);
}

const surfaceFindings = (graph: ImportGraph): readonly Finding[] =>
  checkSurfaceBoundary(graph).map((violation) => {
    const code = boundaryCodeOf(violation.rule);
    return {
      code,
      cause: violation.cause,
      fix: violation.fix,
      docs: ERROR_DOCS_URL,
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
 *
 * BOTH halves come from the scanned path, so both are hostile: the subject is an ARGUMENT and goes
 * through `quoteArg` — a directory named `posts; id` emitted a fix that ran `id` — and the comment
 * goes through `commentSafe`. `<name>` alone stays literal: it is a placeholder a reader replaces,
 * and `'<name>'` would be pasted as a resource actually called that.
 */
const generate = (kind: 'query' | 'action', path: string, then: string): string => {
  const subject = subjectOf(path);
  const named = subject === undefined ? '<name>' : quoteArg(subject);
  return `x g ${kind} ${named}   # ${then} ${commentSafe(path)}`;
};

/** The slice a route's import lands in, or `undefined` for a package like `@acme/db`. */
const sliceOfImport = (path: string, specifier: string): string | undefined => {
  // Resolved already where `scan` knew the file, and still relative where it did not.
  const target = specifier.startsWith('.') ? normalize(join(dirname(path), specifier)) : specifier;
  const [, surface, slice, rest] = /^apps\/[^/]+\/([^/]+)\/([^/]+)\/(.+)$/.exec(target) ?? [];
  return surface !== undefined && SURFACE_NAMES.has(surface) && rest !== undefined
    ? slice
    : undefined;
};

/**
 * A read through a database import. Into a slice, the query belongs there: without `--feature` a
 * singular name wrote 14 files, a new entity and a table nobody asked for. A route named for its
 * slice takes `<slice>-read`, since a query named as the entity collides with its import. With no
 * slice to read, a new one is what the fix has to name.
 */
const routeToDbFix = (path: string, specifier: string): string => {
  const then = `then call it from ${commentSafe(path)}`;
  const subject = subjectOf(path);
  const named = subject === undefined ? '<name>' : quoteArg(subject);
  const slice = sliceOfImport(path, specifier);
  if (slice === undefined) return `x g resource ${named}   # ${then}`;
  const query = subject === slice || subject === `${slice}s` ? quoteArg(`${slice}-read`) : named;
  return `x g query ${query} --feature ${quoteArg(slice)}   # ${then}`;
};

/** A package's `./adapter` subpath: the installers `runtime.ts` and the boot own, never an app module. */
const ADAPTER_SUBPATH = /^@ultimat3\/[a-z-]+\/adapter$/;

/**
 * The `runtime.ts` field an import of `specifier` stands in for: the port named after its package
 * (`@ultimat3/jobs/adapter` → `jobs`), else that package's first row. A real field, never a
 * placeholder — the fix's runnable half is pasted as it stands.
 */
const portOf = (specifier: string): string => {
  const pkg = specifier.slice(0, -'/adapter'.length);
  const rows = ADAPTER_PORTS.filter((row) => row.pkg === pkg);
  const named = rows.find((row) => `@ultimat3/${row.port}` === pkg);
  return (named ?? rows[0])?.port ?? 'jobs';
};

/**
 * Both fixes are one runnable line, with the rest of the instruction behind a `#` — a fix a
 * caller has to edit before it runs is prose, and prose is what "errors are instructions" bans.
 */
function layerFindings(scanned: readonly ScannedFile[]): readonly Finding[] {
  const findings: Finding[] = [];
  for (const file of scanned) {
    for (const specifier of file.imports) {
      // `file.imports` is runtime imports only: `import type { Gateway }` from an adapter is fine.
      if (ADAPTER_SUBPATH.test(specifier)) {
        findings.push({
          code: 'X_BOUNDARY_ADAPTER_IMPORT',
          cause: `an app module imports "${specifier}" at runtime — its installers are the boot's, and one called from here races it (X_RUNTIME_DRIVER_SPLIT)`,
          fix: `export const runtime = { ${quoteArg(portOf(specifier))}: yourDriver } satisfies RuntimeOverrides;   # in apps/web/runtime.ts, then delete the import from ${commentSafe(file.path)}`,
          docs: ERROR_DOCS_URL,
          at: file.path,
        });
      }
      if (isRoute(file.path) && isDbSpecifier(specifier)) {
        findings.push({
          code: 'X_BOUNDARY_ROUTE_TO_DB',
          cause: `route imports the database ("${specifier}")${isRepoSpecifier(specifier) ? ', through a repo' : ''} — routes call actions and queries`,
          fix: routeToDbFix(file.path, specifier),
          docs: ERROR_DOCS_URL,
          at: file.path,
        });
      }
      if (isService(file.path) && isHttpSpecifier(specifier)) {
        findings.push({
          code: 'X_BOUNDARY_SERVICE_TO_HTTP',
          cause: `service imports HTTP ("${specifier}") — a service that knows about requests cannot be reused by a job`,
          fix: generate('action', file.path, 'read the request there and pass plain values to'),
          docs: ERROR_DOCS_URL,
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
  return [
    ...surfaceFindings(graphOf(scanned)),
    ...layerFindings(scanned),
    ...loaderImportFindings(files),
  ];
}

const APP_GLOBS = ['apps/*/{site,app,api,shared}/**/*.{ts,tsx}'];

/**
 * Read every source file under an app's site, app, api and shared surfaces (`APP_GLOBS`). The
 * only I/O in this module, and the one definition of "which files are the app's sources" —
 * `appBoundaryFindings` reads through this, and so does `x fix boundary`, never a second glob.
 */
export async function readAppSources(
  root: string,
  /** `tests`: the same surfaces' `.test.` files instead — read by the loader rule alone. */
  which: 'sources' | 'tests' = 'sources',
): Promise<readonly SourceFile[]> {
  const files: SourceFile[] = [];
  for (const pattern of APP_GLOBS) {
    const glob = new Bun.Glob(pattern);
    for await (const path of glob.scan({ cwd: root, absolute: false })) {
      if (hasPathSegment(path, 'node_modules')) continue;
      if (path.includes('.test.') !== (which === 'tests')) continue;
      const posix = toPosix(path);
      files.push({ path: posix, source: await Bun.file(joinPath(root, posix)).text() });
    }
  }
  return files;
}

/** The resolved import graph over a file set — what `checkSurfaceBoundary` walks. */
export function appImportGraph(files: readonly SourceFile[]): ImportGraph {
  return graphOf(scan(files));
}
