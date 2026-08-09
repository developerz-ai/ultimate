// Loading an app into the framework's own registries. The CLI owns no second definition of what
// a primitive is: `entity()`, `job()` and `task()` register on import, and `registerActions` /
// `registerQueries` / `registerRoute` name the rest — so `x manifest`, `x routes` and `x verify`
// read exactly the tables the running server reads.

import { relative, sep } from 'node:path';
import { registerActions } from '@ultimat3/action';
import type { ErrorCodeFact } from '@ultimat3/manifest';
import { registerQueries } from '@ultimat3/query';
import { isRouteConfig, registerRoute } from '@ultimat3/render';
import type { Finding } from './output';
import { findingFrom } from './output';

/** Every place an app keeps code the framework has to see. */
const APP_GLOBS = [
  'apps/*/{site,app,api,shared}/**/*.{ts,tsx}',
  'apps/*/*.{ts,tsx}',
  'packages/*/src/**/*.ts',
] as const;

export interface LoadedApp {
  readonly root: string;
  /** App-root-relative POSIX paths of every module that imported, sorted. */
  readonly files: readonly string[];
  /** Flattened `*_ERROR_CODES` exports — the one fact no registry holds. */
  readonly errorCodes: readonly ErrorCodeFact[];
  /** Modules that would not import, and primitives that would not register. */
  readonly findings: readonly Finding[];
}

// `import()` caches, but a registry rejects a second registration of the same name — so a file
// is registered exactly once per process. `x dev` rescans on every save and must not trip on it.
const registered = new Set<string>();
// A registration failure is sticky: the file is never retried, so the finding is replayed.
const failures = new Map<string, Finding>();

/** Test seam, and what `x dev` would call if it ever restarted the registries in-process. */
export function resetAppLoad(): void {
  registered.clear();
  failures.clear();
}

export async function loadApp(root: string): Promise<LoadedApp> {
  const files: string[] = [];
  const codes = new Map<string, ErrorCodeFact>();
  const findings: Finding[] = [];

  for (const pattern of APP_GLOBS) {
    for await (const absolute of new Bun.Glob(pattern).scan({ cwd: root, absolute: true })) {
      if (absolute.includes('node_modules') || absolute.includes('.test.')) continue;
      const file = relative(root, absolute).split(sep).join('/');
      let module: Record<string, unknown>;
      try {
        module = (await import(absolute)) as Record<string, unknown>;
      } catch (error) {
        findings.push({ ...findingFrom(error), at: file });
        continue;
      }
      files.push(file);
      collectErrorCodes(module, file, codes);
      const finding = await register(absolute, file, module);
      if (finding !== undefined) findings.push(finding);
    }
  }

  files.sort();
  return {
    root,
    files,
    errorCodes: [...codes.values()].sort((a, b) => a.code.localeCompare(b.code)),
    findings,
  };
}

/** Registers a module once; every later call replays whatever the first one reported. */
async function register(
  absolute: string,
  file: string,
  module: Record<string, unknown>,
): Promise<Finding | undefined> {
  const previous = failures.get(absolute);
  if (previous !== undefined) return previous;
  if (registered.has(absolute)) return undefined;
  registered.add(absolute);
  try {
    const config = module['config'];
    if (isRouteConfig(config)) {
      // The build counts boundaries from the compiled JSX; before a build there is only the
      // source, and `render: 'stream'` is rejected without one — so count them in the text.
      const source = await Bun.file(absolute).text();
      registerRoute({ file, config, suspenseBoundaries: countSuspense(source) });
    }
    registerActions(module);
    registerQueries(module);
    return undefined;
  } catch (error) {
    const finding: Finding = { ...findingFrom(error), at: file };
    failures.set(absolute, finding);
    return finding;
  }
}

const countSuspense = (source: string): number => source.match(/<Suspense[\s/>]/g)?.length ?? 0;

/** `packages/db/src/errors.ts` → `packages/db`; `apps/web/app/posts/errors.ts` → `apps/web`. */
const workspaceOf = (file: string): string => file.split('/').slice(0, 2).join('/');

function collectErrorCodes(
  module: Record<string, unknown>,
  file: string,
  into: Map<string, ErrorCodeFact>,
): void {
  for (const [name, value] of Object.entries(module)) {
    if (!name.endsWith('ERROR_CODES') || !Array.isArray(value)) continue;
    for (const code of value) {
      if (typeof code === 'string' && code.startsWith('X_')) {
        into.set(code, { code, package: workspaceOf(file) });
      }
    }
  }
}
