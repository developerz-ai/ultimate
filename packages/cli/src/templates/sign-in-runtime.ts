// What `x g sign-in` owes `apps/web/runtime.ts` and its test, as a splice: the guard's import and
// call, and for OIDC the routes, added to the file the author already has. `runtime.ts` is THE
// port-installation file, so almost every app has edited it — replacing it only while it was
// `x new`'s bytes refused the generator for every app past day one.

import { maskLiterals, stripComments } from '@ultimat3/core';
import { holdsKey } from '../source-edit';
import { baseRuntimeTest, RUNTIME_HEADER, runtimePortLines } from './scaffold-runtime-ports';

/** The plain routes a shape mounts: an import line, and the expression `routes:` takes. */
export interface RuntimeRoutes {
  readonly importLine: string;
  readonly expression: string;
}

/** The OIDC shape's routes: the start and callback legs, mounted as plain routes. */
export const OIDC_RUNTIME_ROUTES: RuntimeRoutes = {
  importLine: "import { signInRoutes } from './app/auth/sign-in-routes';",
  expression: 'signInRoutes',
};

const GUARD = 'assertSignInConfigured';
const GUARD_IMPORT = `import { ${GUARD} } from './app/auth/sign-in-guard';`;
const GUARD_CALL = `${GUARD}(process.env);`;
const GUARD_WHY = `// The sign-in guard runs HERE: a throw in this module stops the role, where the same throw in a
// module the app scan imports is logged and the boot goes on.`;

/** The full `runtime.ts` over `x new`'s: what the splice of the untouched scaffold must equal. */
export const signInRuntimeSource = (routes: RuntimeRoutes | undefined): string => `${RUNTIME_HEADER}
${GUARD_WHY}
import type { RuntimeOverrides } from '@ultimat3/cli/serve';
${GUARD_IMPORT}${routes === undefined ? '' : `\n${routes.importLine}`}

${GUARD_CALL}

export const runtime = {
${routes === undefined ? '' : `  routes: ${routes.expression},\n`}${runtimePortLines()}
} satisfies RuntimeOverrides;
`;

/** The full `runtime.test.ts` over `x new`'s. */
export const signInRuntimeTest = (
  routes: RuntimeRoutes | undefined,
): string => `// The runtime loads under test (the guard judges no local environment)${routes === undefined ? '' : ', and mounts the sign-in routes'}.
import { expect, unitTest } from '@ultimat3/testing';
${routes === undefined ? '' : `${routes.importLine}\n`}import { runtime } from './runtime';

unitTest('the runtime loads${routes === undefined ? '' : ' and mounts the sign-in routes'}', () => {
  ${routes === undefined ? 'expect(runtime).toEqual({});' : `expect(runtime.routes).toBe(${routes.expression});`}
});
`;

/** What a splice made of a file: new bytes, the delta already there, or the line to edit by hand. */
export type RuntimeSplice =
  | { readonly kind: 'spliced'; readonly source: string }
  | { readonly kind: 'present' }
  | { readonly kind: 'unrecognised'; readonly line: number; readonly edit: string };

const lineAt = (source: string, index: number): number =>
  source.slice(0, Math.max(0, index)).split('\n').length;

const IMPORT = /^import\b[^;]*?from\s+'([^']+)';\n/gm;
const specifierOf = (line: string): string => /from '([^']+)'/.exec(line)?.[1] ?? '';

/**
 * `source` with `line` imported where a sorted block has it: among the relative imports by
 * specifier, else after the last import, else at `fallback`. Already imported is unchanged.
 */
function withRelativeImport(source: string, line: string, fallback: number): string {
  const specifier = specifierOf(line);
  if (source.includes(`from '${specifier}'`)) return source;
  const imports = [...source.matchAll(IMPORT)];
  const later = imports.find((match) => {
    const from = match[1] ?? '';
    return from.startsWith('.') && from > specifier;
  });
  const last = imports.at(-1);
  const at = later?.index ?? (last === undefined ? fallback : last.index + last[0].length);
  return `${source.slice(0, at)}${line}\n${source.slice(at)}`;
}

/** Where the comment block directly above the line at `index` starts: a doc comment stays on. */
function commentStart(source: string, index: number): number {
  let at = index;
  for (;;) {
    const previous = source.lastIndexOf('\n', at - 2) + 1;
    const text = source.slice(previous, at - 1).trim();
    if (at === 0 || !(text.startsWith('//') || text.startsWith('/*') || text.startsWith('*'))) {
      return at;
    }
    at = previous;
  }
}

const DECLARATION = /^export const runtime\b[^=\n]*=\s*\{/m;

/** The guard (and `routes`) added to an existing `runtime.ts`; never a second copy of either. */
export function spliceSignInRuntime(
  source: string,
  routes: RuntimeRoutes | undefined,
): RuntimeSplice {
  const code = stripComments(source);
  if (new RegExp(`\\b${GUARD}\\(`).test(code)) return { kind: 'present' };
  const masked = maskLiterals(source);
  const declaration = DECLARATION.exec(masked);
  if (declaration === null) {
    const named = /^export\b[^\n]*\bruntime\b/m.exec(masked);
    return {
      kind: 'unrecognised',
      line: named === null ? 1 : lineAt(source, named.index),
      edit: 'declare the overrides as one object literal, export const runtime = { … } satisfies RuntimeOverrides',
    };
  }
  const open = declaration.index + declaration[0].length;
  let next = source;
  if (routes !== undefined) {
    const close = masked.indexOf('\n}', open);
    const body = stripComments(source.slice(open, close === -1 ? source.length : close));
    if (holdsKey(body, 'routes')) {
      const key = /\broutes\b/.exec(body)?.index ?? 0;
      return {
        kind: 'unrecognised',
        line: lineAt(source, open + key),
        edit: `move this routes value into a const above the export (const appRoutes = …) and list routes: [...${routes.expression}, ...appRoutes], importing ${routes.expression} from './app/auth/sign-in-routes', ${GUARD} from './app/auth/sign-in-guard', and calling ${GUARD_CALL} above the export`,
      };
    }
    const closes = /^[ \t]*\}/.test(masked.slice(open));
    const entry = `\n  routes: ${routes.expression},${closes ? '\n' : ''}`;
    next = `${next.slice(0, open)}${entry}${next.slice(open)}`;
  }
  const start = commentStart(next, declaration.index);
  next = `${next.slice(0, start)}${GUARD_CALL}\n\n${next.slice(start)}`;
  next = withRelativeImport(next, GUARD_IMPORT, start);
  if (routes !== undefined) next = withRelativeImport(next, routes.importLine, start);
  const first = [...next.matchAll(IMPORT)][0]?.index ?? start;
  return { kind: 'spliced', source: `${next.slice(0, first)}${GUARD_WHY}\n${next.slice(first)}` };
}

const imports = (source: string, name: string): boolean =>
  [...stripComments(source).matchAll(IMPORT)].some((match) =>
    new RegExp(`\\{[^}]*\\b${name}\\b[^}]*\\}`).test(match[0]),
  );

/**
 * The routes assertion added to an existing `runtime.test.ts`; the password shape mounts none, so
 * its test is the author's as it stands. `x new`'s own test is replaced whole: its one assertion,
 * `toEqual({})`, is false once routes are mounted.
 */
export function spliceSignInRuntimeTest(
  source: string,
  routes: RuntimeRoutes | undefined,
): RuntimeSplice {
  if (source === baseRuntimeTest()) {
    return { kind: 'spliced', source: signInRuntimeTest(routes) };
  }
  if (routes === undefined || imports(source, routes.expression)) {
    return { kind: 'spliced', source };
  }
  if (!['runtime', 'unitTest', 'expect'].every((name) => imports(source, name))) {
    return {
      kind: 'unrecognised',
      line: 1,
      edit: `add a unitTest that asserts expect(runtime.routes).toBe(${routes.expression}), importing runtime from './runtime' and ${routes.expression} from './app/auth/sign-in-routes'`,
    };
  }
  const withImport = withRelativeImport(source, routes.importLine, 0);
  const block = `\nunitTest('the runtime mounts the sign-in routes', () => {\n  expect(runtime.routes).toBe(${routes.expression});\n});\n`;
  return {
    kind: 'spliced',
    source: `${withImport}${withImport.endsWith('\n') ? '' : '\n'}${block}`,
  };
}
