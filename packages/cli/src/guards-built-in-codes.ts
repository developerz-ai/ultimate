// The codes the shipped guards raise, as `x.manifest.json` facts: a built-in guard that runs is a
// code this app's gate emits, exactly as a vendored copy's was, so moving the guard into the
// framework (`vendored-guards`) removes no code from the app's contract. Owned by `@ultimat3/cli`.

import type { ErrorCodeFact } from '@ultimat3/manifest';
import { planBuiltIns, readShippedConfig } from './guards-built-in';
import { guardPaths } from './guards-paths';
import { shippedGuardCode } from './guards-shipped-names';

/** The package a built-in's code is declared by: the CLI that ships and runs it. */
export const BUILT_IN_GUARD_PACKAGE = '@ultimat3/cli';

const byCode = (a: ErrorCodeFact, b: ErrorCodeFact): number => a.code.localeCompare(b.code);

/** Every built-in guard this app runs — any mode but `"off"`, never one it holds a copy of. */
export async function builtInGuardCodes(root: string): Promise<readonly ErrorCodeFact[]> {
  const { builtIn } = planBuiltIns(
    await guardPaths(root),
    (await readShippedConfig(root)).severity,
  );
  return builtIn
    .map(({ name }) => ({
      code: shippedGuardCode(name),
      package: BUILT_IN_GUARD_PACKAGE,
    }))
    .sort(byCode);
}

/** The app's own declarations win a code both name; the built-ins fill the rest, sorted by code. */
export const withBuiltInGuardCodes = (
  app: readonly ErrorCodeFact[],
  builtIn: readonly ErrorCodeFact[],
): readonly ErrorCodeFact[] => {
  const declared = new Set(app.map(({ code }) => code));
  return [...app, ...builtIn.filter(({ code }) => !declared.has(code))].sort(byCode);
};
