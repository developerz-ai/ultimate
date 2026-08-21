#!/usr/bin/env bun
// Enforce, as a build error, that `packages/core/src/async-context.ts` holds the framework's ONE
// `AsyncLocalStorage`. A browser bundler stubs `node:async_hooks` to `{}` — Bun's `target:
// 'browser'` emits `var { AsyncLocalStorage } = (() => ({}))` — so a module-scope construction
// throws `TypeError: undefined is not a constructor` at module EVALUATION and takes every importer
// of that package with it. Core fixed its own three sites behind a lazy seam and nothing watched
// the other six (#244, #255), which is the definition of a convention rather than a rule.
//
// WHAT IT SEES, over comment-stripped source — every package, every script, and BOTH tracked
// apps, because an app's modules bundle for the browser exactly as a package's do:
//   - `new AsyncLocalStorage`, `new ALS` where `ALS` is an alias bound by an import of
//     `node:async_hooks`, and `new hooks.AsyncLocalStorage` through a namespace import;
//   - the IMPORT itself — any binding of the class, aliased or namespaced, outside the seam.
//     That second rule is what makes the first hard to walk around: a construction needs a
//     binding, and the binding is one line an alias cannot hide.
//
// WHAT IT CANNOT SEE, honestly: `await import('node:async_hooks')` and any other runtime
// resolution; the constructor stored in a variable or returned by a factory and `new`ed off that
// (`const C = hooks.AsyncLocalStorage; new C()`); and a construction inside a `.test.ts`, which is
// skipped because a test is not in anybody's bundle and this file's own fixture is one. A floor,
// not a proof — and the two runtime forms are closed by `scripts/browser-barrel.test.ts`, which
// evaluates the built chunk instead of reading it.
//
//   bun run scripts/async-context-guard.ts [--json]

import { join } from 'node:path';
import { stripComments } from '@ultimat3/cli';
import { APP_ROOTS, collectSourceFiles, type SourceFile } from './boundaries';
import { parseScriptArgs } from './lib/args';
import type { Finding } from './lib/log';
import { report } from './lib/log';
import { repoRoot } from './lib/run';

/** The one module allowed to name the class, because deferring the `new` is its whole job. */
export const ASYNC_CONTEXT_SEAM = 'packages/core/src/async-context.ts';

const CLASS = 'AsyncLocalStorage';

/** `node:async_hooks` and the bare spelling Bun also resolves. */
const HOOKS_MODULE = /^(?:node:)?async_hooks$/;

/**
 * Two ways one file can own an `AsyncLocalStorage`, and both are reported: `construction` is the
 * defect itself, `binding` is the line that makes a construction expressible under any name.
 */
export type AsyncStorageKind = 'construction' | 'binding';

export interface AsyncStorageSite {
  readonly file: string;
  readonly line: number;
  readonly kind: AsyncStorageKind;
  /** The local name — `AsyncLocalStorage`, an alias, or `<namespace>.AsyncLocalStorage`. */
  readonly name: string;
}

interface Bindings {
  /** Local names that ARE the class: `AsyncLocalStorage` itself and every alias of it. */
  readonly direct: ReadonlySet<string>;
  /** Local names of a whole-module import, which carries the class as a property. */
  readonly namespaces: ReadonlySet<string>;
  /** One `binding` finding per import that bound either — the line an alias cannot hide. */
  readonly sites: readonly AsyncStorageSite[];
}

/** `import <clause> from '<module>'`, with the clause and the module captured separately. */
const IMPORT = /\bimport\s+([^;]*?)\s*from\s*(['"])([^'"]+)\2/g;
const NAMESPACE = /\*\s+as\s+([A-Za-z_$][\w$]*)/;
const NAMED = /\{([^}]*)\}/;
/** `new Foo`, `new ns.Foo` — the generic argument and the argument list are irrelevant here. */
const CONSTRUCTION = /\bnew\s+([A-Za-z_$][\w$]*)(?:\s*\.\s*([A-Za-z_$][\w$]*))?/g;

const lineAt = (source: string, index: number): number => source.slice(0, index).split('\n').length;

/**
 * Every local name an import of `node:async_hooks` binds to the class. `CLASS` seeds `direct`
 * unconditionally: a bare `new AsyncLocalStorage` with no import in the file is either an ambient
 * global or an import this scan misread, and both deserve the finding.
 */
export function asyncStorageBindings(code: string, file: string): Bindings {
  const direct = new Set<string>([CLASS]);
  const namespaces = new Set<string>();
  const sites: AsyncStorageSite[] = [];
  for (const found of code.matchAll(IMPORT)) {
    if (!HOOKS_MODULE.test(found[3] ?? '')) continue;
    const clause = found[1] ?? '';
    const bound: string[] = [];
    const namespace = NAMESPACE.exec(clause);
    if (namespace?.[1] !== undefined) {
      namespaces.add(namespace[1]);
      bound.push(`${namespace[1]}.${CLASS}`);
    }
    for (const member of (NAMED.exec(clause)?.[1] ?? '').split(',')) {
      const parts = member.trim().split(/\s+as\s+/);
      if (parts[0]?.replace(/^type\s+/, '') !== CLASS) continue;
      direct.add(parts[1] ?? CLASS);
      bound.push(parts[1] ?? CLASS);
    }
    const line = lineAt(code, found.index);
    for (const name of bound) sites.push({ file, line, kind: 'binding', name });
  }
  return { direct, namespaces, sites };
}

/**
 * Pure, so the negative case is a fixture string rather than a defect planted in the tree. Takes
 * the files whole: the same `SourceFile[]` `bun run boundaries` already collects.
 */
export function checkAsyncStorage(files: readonly SourceFile[]): readonly AsyncStorageSite[] {
  const sites: AsyncStorageSite[] = [];
  for (const file of files) {
    if (file.path === ASYNC_CONTEXT_SEAM || file.path.includes('.test.')) continue;
    // Comments, or the seam's own prose about the defect reports itself — and `telemetry.ts` and
    // `context.ts` both explain the fix by writing the construction out.
    const code = stripComments(file.source);
    const bindings = asyncStorageBindings(code, file.path);
    sites.push(...bindings.sites);
    for (const found of code.matchAll(CONSTRUCTION)) {
      const [head, tail] = [found[1] ?? '', found[2]];
      const named = tail === undefined ? head : `${head}.${tail}`;
      const hit =
        tail === undefined
          ? bindings.direct.has(head)
          : bindings.namespaces.has(head) && tail === CLASS;
      if (!hit) continue;
      sites.push({
        file: file.path,
        line: lineAt(code, found.index),
        kind: 'construction',
        name: named,
      });
    }
  }
  return sites;
}

/**
 * The edit, at the file and line that needs it, plus the command that re-reads the tree once it is
 * made. No command can perform this repair — the replacement is a scope whose subject only the
 * author of the module knows — so it is the house's other legal shape: an edit naming a file.
 */
const fixFor = (site: AsyncStorageSite): string =>
  `edit ${site.file}:${site.line} — delete ${site.name} and open the scope through the seam instead: import { asyncContext } from '@ultimat3/core', then const scope = asyncContext<T>('what the scope carries'), scope.get() and scope.run(value, fn); re-read the tree with: bun run async-context-guard --json`;

export function asyncStorageFinding(site: AsyncStorageSite): Finding {
  const cause =
    site.kind === 'construction'
      ? `${site.file}:${site.line} constructs its own ${site.name}; a browser bundler stubs node:async_hooks to {}, so the new throws TypeError at module evaluation and every importer of that package dies with it`
      : `${site.file}:${site.line} binds ${site.name} from node:async_hooks, and ${ASYNC_CONTEXT_SEAM} is the one module in the framework that may`;
  return {
    // Core's code for the condition this rule exists to keep unreachable: a runtime with no
    // async_hooks. Reused rather than minted so the guard and the throw name one fact.
    code: 'X_ASYNC_CONTEXT_UNAVAILABLE',
    cause,
    fix: fixFor(site),
    at: `${site.file}:${site.line}`,
  };
}

/**
 * `collectSourceFiles` reaches a package's `src` and `e2e` plus `scripts/` and stops there, so an
 * app could construct its own and pass a rule stated repo-wide. A tracked app is source in
 * this repo and its modules bundle for the browser exactly as a package's do. Same two roots
 * `collectSharedFiles` in `scripts/boundaries.ts` already walks, so an app added under either
 * enters this rule by existing rather than by being listed.
 */
const APP_SOURCES = `${APP_ROOTS}/*/**/*.{ts,tsx}`;

/** Built output and installed dependencies are nobody's source, and `node_modules` symlinks loop. */
const NOT_SOURCE = /(?:^|\/)(?:node_modules|dist|\.x)\//;

async function collectAppFiles(root: string): Promise<readonly SourceFile[]> {
  const files: SourceFile[] = [];
  for await (const path of new Bun.Glob(APP_SOURCES).scan({ cwd: root, absolute: false })) {
    const posix = path.split('\\').join('/');
    if (NOT_SOURCE.test(posix)) continue;
    files.push({ path: posix, source: await Bun.file(join(root, posix)).text() });
  }
  return files;
}

/** Everything the rule reads: the framework's own source AND every app this repo tracks. */
export async function collectGuardedFiles(root: string): Promise<readonly SourceFile[]> {
  return [...(await collectSourceFiles(root)), ...(await collectAppFiles(root))];
}

/** The rule over the real tree — what the test and the command both ask. */
export async function asyncStorageSites(root: string): Promise<readonly AsyncStorageSite[]> {
  return checkAsyncStorage(await collectGuardedFiles(root));
}

if (import.meta.main) {
  const args = parseScriptArgs(Bun.argv.slice(2));
  const root = repoRoot();
  const files = await collectGuardedFiles(root);
  const sites = checkAsyncStorage(files);
  report(
    {
      ok: sites.length === 0,
      script: 'async-context-guard',
      summary:
        sites.length === 0
          ? `${files.length} files, one AsyncLocalStorage — ${ASYNC_CONTEXT_SEAM}`
          : `${sites.length} AsyncLocalStorage site(s) outside ${ASYNC_CONTEXT_SEAM}`,
      findings: sites.map(asyncStorageFinding),
      data: { files: files.length, sites },
    },
    args.json,
  );
}
