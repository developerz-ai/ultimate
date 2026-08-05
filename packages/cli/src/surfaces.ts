// App-level import boundaries: the rules that keep the static path from paying for the app path
// (axiom 6) and keep layers from collapsing into each other. Reported as `x verify` findings, so
// these codes are never thrown — they arrive as data with a fix command attached.
//
// Runtime imports only: `Bun.Transpiler.scanImports` sees what survives type erasure, which is
// exactly the distinction the `app/ -> api/` rule needs (`import type` is allowed, a value import
// is not).

import { dirname, join, normalize } from 'node:path/posix';
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

export type Surface = 'site' | 'app' | 'api' | 'shared' | 'unknown';

const docs = (code: BoundaryCode): string => `https://ultimate.dev/errors/${code}`;

export function surfaceOf(path: string): Surface {
  const parts = path.split('/');
  for (const part of parts) {
    if (part === 'site' || part === 'app' || part === 'api' || part === 'shared') return part;
  }
  return 'unknown';
}

const isRoute = (path: string): boolean => /\/(page|layout|route)\.[cm]?tsx?$/.test(path);
const isService = (path: string): boolean => /\/service\.[cm]?ts$/.test(path);
const isDbSpecifier = (specifier: string): boolean =>
  /(^|\/)packages\/db($|\/)/.test(specifier) ||
  specifier.endsWith('/db') ||
  /^@[^/]+\/db$/.test(specifier) ||
  specifier === 'drizzle-orm';
const isHttpSpecifier = (specifier: string): boolean =>
  specifier === '@ultimat3/http' || /(^|\/)http($|\/)/.test(specifier);

/** Resolve a relative specifier against its importer so the surface can be read from the path. */
export function resolveSpecifier(fromFile: string, specifier: string): string {
  if (!specifier.startsWith('.')) return specifier;
  return normalize(join(dirname(fromFile), specifier));
}

/** The transpiler rejects a shebang, and an app's `bin/` entry points legitimately have one. */
export const stripShebang = (source: string): string =>
  source.startsWith('#!') ? source.slice(source.indexOf('\n') + 1) : source;

/** Bun's transpiler is the parser; a regex fallback would miss re-exports and dynamic imports. */
export function scanRuntimeImports(file: SourceFile): readonly string[] {
  const loader = file.path.endsWith('x') ? 'tsx' : 'ts';
  const transpiler = new Bun.Transpiler({ loader });
  return transpiler.scanImports(stripShebang(file.source)).map((entry) => entry.path);
}

function violation(code: BoundaryCode, input: { at: string; cause: string; fix: string }): Finding {
  return { code, cause: input.cause, fix: input.fix, docs: docs(code), at: input.at };
}

/**
 * Check every app source file against the surface rules. Pure — callers do the I/O — so the dev
 * server can run this on every save and `x verify` can run it over a full file list.
 */
export function checkSurfaceRules(files: readonly SourceFile[]): readonly Finding[] {
  const findings: Finding[] = [];
  for (const file of files) {
    const from = surfaceOf(file.path);
    for (const specifier of scanRuntimeImports(file)) {
      const resolved = resolveSpecifier(file.path, specifier);
      const to = surfaceOf(resolved);

      if (from === 'site' && to === 'app') {
        findings.push(
          violation('X_BOUNDARY_SITE_TO_APP', {
            at: file.path,
            cause: `site/ imports "${specifier}" from app/ — the marketing bundle would inherit the app graph`,
            fix: `move the shared part into shared/ and import it from both, then: x verify --json`,
          }),
        );
      }
      if (from === 'shared' && (to === 'app' || to === 'site')) {
        findings.push(
          violation('X_BOUNDARY_SHARED_LEAF', {
            at: file.path,
            cause: `shared/ imports "${specifier}" from ${to}/ — shared/ is a leaf, it may not import a surface`,
            fix: `invert the dependency: pass the ${to}/ value in as a prop or argument`,
          }),
        );
      }
      if (from === 'app' && to === 'api') {
        findings.push(
          violation('X_BOUNDARY_APP_TO_API', {
            at: file.path,
            cause: `app/ has a runtime import of "${specifier}" from api/ — only \`import type\` is allowed`,
            fix: `call the generated typed client instead, and change the import to \`import type\``,
          }),
        );
      }
      if (isRoute(file.path) && isDbSpecifier(resolved)) {
        findings.push(
          violation('X_BOUNDARY_ROUTE_TO_DB', {
            at: file.path,
            cause: `route imports the database ("${specifier}") — routes call actions and queries`,
            fix: `x g query ${file.path.split('/').at(-2) ?? 'rows'} and call it from the route`,
          }),
        );
      }
      if (isService(file.path) && isHttpSpecifier(resolved)) {
        findings.push(
          violation('X_BOUNDARY_SERVICE_TO_HTTP', {
            at: file.path,
            cause: `service imports HTTP ("${specifier}") — a service that knows about requests cannot be reused by a job`,
            fix: `take the values the service needs as arguments; let the action read the request`,
          }),
        );
      }
    }
  }
  return findings;
}

const APP_GLOBS = ['apps/*/{site,app,api,shared}/**/*.{ts,tsx}'];

/** Read an app's sources and check them. The only I/O in this module. */
export async function checkAppBoundaries(root: string): Promise<readonly Finding[]> {
  const files: SourceFile[] = [];
  for (const pattern of APP_GLOBS) {
    const glob = new Bun.Glob(pattern);
    for await (const path of glob.scan({ cwd: root, absolute: false })) {
      if (path.includes('node_modules') || path.includes('.test.')) continue;
      const posix = path.split('\\').join('/');
      files.push({ path: posix, source: await Bun.file(join(root, posix)).text() });
    }
  }
  return checkSurfaceRules(files);
}
