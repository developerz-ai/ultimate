// The sign-in delta spliced into an `apps/web/runtime.ts` (and its test) the author already edited:
// the untouched scaffold comes out byte-identical to the full template, an edited one keeps every
// line it had, a second splice finds the guard already there, and a shape it cannot read is a line.

import { describe, expect, test } from 'bun:test';
import { baseRuntimeSource, baseRuntimeTest } from './scaffold-runtime-ports';
import {
  OIDC_RUNTIME_ROUTES,
  type RuntimeRoutes,
  signInRuntimeSource,
  signInRuntimeTest,
  spliceSignInRuntime,
  spliceSignInRuntimeTest,
} from './sign-in-runtime';

const MODEL_IMPORT = "import { modelRuntime } from './app/assistant/model';";
const SPREAD = '  // The model LLM_MODEL names, or none.\n  ...modelRuntime(Bun.env),\n';

/** What the `agent` shape leaves: an app import, a spread, and a port uncommented. */
const edited = (): string =>
  baseRuntimeSource()
    .replace(
      "import type { RuntimeOverrides } from '@ultimat3/cli/serve';\n",
      `import type { RuntimeOverrides } from '@ultimat3/cli/serve';\n${MODEL_IMPORT}\n`,
    )
    .replace('export const runtime = {\n', `export const runtime = {\n${SPREAD}`);

const spliced = (source: string, routes: RuntimeRoutes | undefined): string => {
  const result = spliceSignInRuntime(source, routes);
  if (result.kind !== 'spliced') return expect.unreachable(`spliced, got ${result.kind}`);
  return result.source;
};

describe('unit · the sign-in runtime splice', () => {
  test('over the untouched scaffold it writes exactly the full template, both shapes', () => {
    expect(spliced(baseRuntimeSource(), undefined)).toBe(signInRuntimeSource(undefined));
    expect(spliced(baseRuntimeSource(), OIDC_RUNTIME_ROUTES)).toBe(
      signInRuntimeSource(OIDC_RUNTIME_ROUTES),
    );
  });

  test('an edited runtime keeps every line it had, and gains the guard and the routes', () => {
    const before = edited();
    const after = spliced(before, OIDC_RUNTIME_ROUTES);
    // Nothing the author wrote is lost: every line of theirs is still there, in order.
    const lines = after.split('\n');
    let at = 0;
    for (const line of before.split('\n')) at = lines.indexOf(line, at) + 1;
    expect(at).toBeGreaterThan(0);
    expect(lines.length - before.split('\n').length).toBe(7);
    // The imports in sorted order: the author's app import sorts before the auth slice's.
    const imports = after.split('\n').filter((line) => line.startsWith('import'));
    expect(imports).toEqual([
      "import type { RuntimeOverrides } from '@ultimat3/cli/serve';",
      MODEL_IMPORT,
      "import { assertSignInConfigured } from './app/auth/sign-in-guard';",
      OIDC_RUNTIME_ROUTES.importLine,
    ]);
    // The guard runs before the overrides are built, and the routes are the object's first key.
    expect(after).toContain(
      'assertSignInConfigured(process.env);\n\nexport const runtime = {\n  routes: signInRoutes,\n  // The model',
    );
  });

  test('the password shape adds the guard and no routes', () => {
    const after = spliced(edited(), undefined);
    expect(after).toContain("import { assertSignInConfigured } from './app/auth/sign-in-guard';");
    expect(after).not.toContain('routes');
    expect(after).toContain('assertSignInConfigured(process.env);\n\nexport const runtime = {\n');
  });

  test('a runtime that already calls the guard is left to the writer: present, never doubled', () => {
    expect(
      spliceSignInRuntime(spliced(edited(), OIDC_RUNTIME_ROUTES), OIDC_RUNTIME_ROUTES).kind,
    ).toBe('present');
    expect(spliceSignInRuntime(spliced(edited(), undefined), undefined).kind).toBe('present');
    // Prose naming the guard is not a call to it.
    const commented = edited().replace(
      'export const runtime',
      '// assertSignInConfigured goes here\nexport const runtime',
    );
    expect(spliceSignInRuntime(commented, undefined).kind).toBe('spliced');
  });

  test('a runtime with no `export const runtime = {` names the line to edit', () => {
    const built = edited().replace(
      /export const runtime = \{[\s\S]*$/,
      'const make = (): RuntimeOverrides => ({});\nexport const runtime = make();\n',
    );
    const result = spliceSignInRuntime(built, undefined);
    if (result.kind !== 'unrecognised') return expect.unreachable(`got ${result.kind}`);
    const line = built.split('\n').findIndex((text) => text.startsWith('export const runtime'));
    expect(result.line).toBe(line + 1);
    expect(result.edit).toContain('export const runtime = {');
  });

  test('routes the author already mounts are not merged by guesswork: the line, named', () => {
    const own = edited().replace(
      'export const runtime = {\n',
      'export const runtime = {\n  routes: myRoutes,\n',
    );
    const result = spliceSignInRuntime(own, OIDC_RUNTIME_ROUTES);
    if (result.kind !== 'unrecognised') return expect.unreachable(`got ${result.kind}`);
    expect(own.split('\n')[result.line - 1]).toBe('  routes: myRoutes,');
    expect(result.edit).toContain('...signInRoutes');
    // The password shape mounts no routes, so the author's are no obstacle.
    expect(spliceSignInRuntime(own, undefined).kind).toBe('spliced');
  });
});

describe('unit · the sign-in runtime test splice', () => {
  test('over the untouched scaffold test it writes exactly the full template, both shapes', () => {
    const base = baseRuntimeTest();
    expect(spliceSignInRuntimeTest(base, undefined)).toEqual({
      kind: 'spliced',
      source: signInRuntimeTest(undefined),
    });
    expect(spliceSignInRuntimeTest(base, OIDC_RUNTIME_ROUTES)).toEqual({
      kind: 'spliced',
      source: signInRuntimeTest(OIDC_RUNTIME_ROUTES),
    });
  });

  const authored = `// The author's own runtime test.
import { expect, unitTest } from '@ultimat3/testing';
import { runtime } from './runtime';

unitTest('the runtime holds a gateway only when LLM_MODEL names a model', () => {
  expect(Object.keys(runtime)).toContain('aiGateway');
});
`;

  test("an edited test is the author's: password adds nothing, OIDC adds one import and one test", () => {
    expect(spliceSignInRuntimeTest(authored, undefined)).toEqual({
      kind: 'spliced',
      source: authored,
    });
    const result = spliceSignInRuntimeTest(authored, OIDC_RUNTIME_ROUTES);
    if (result.kind !== 'spliced') return expect.unreachable(`got ${result.kind}`);
    expect(result.source).toBe(
      authored
        .replace(
          "import { runtime } from './runtime';",
          `${OIDC_RUNTIME_ROUTES.importLine}\nimport { runtime } from './runtime';`,
        )
        .concat(
          "\nunitTest('the runtime mounts the sign-in routes', () => {\n  expect(runtime.routes).toBe(signInRoutes);\n});\n",
        ),
    );
    // Twice is once.
    expect(spliceSignInRuntimeTest(result.source, OIDC_RUNTIME_ROUTES)).toEqual(result);
  });

  test('a test that imports no `runtime` names the edit', () => {
    const bare = "import { test } from 'bun:test';\n\ntest('x', () => {});\n";
    const result = spliceSignInRuntimeTest(bare, OIDC_RUNTIME_ROUTES);
    if (result.kind !== 'unrecognised') return expect.unreachable(`got ${result.kind}`);
    expect(result.line).toBe(1);
    expect(result.edit).toContain('expect(runtime.routes).toBe(signInRoutes)');
  });
});
