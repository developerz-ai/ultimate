// The scaffold drift gate, cut into parts: each `scaffold-typecheck*.contract` file compiles one
// part's variants, so test workers run the `tsc`s side by side instead of one file holding all of
// them. The parts cover `scaffoldVariants()` exactly — `scaffold-typecheck.contract` proves it.

import { NEW_SHAPES } from './new-shapes';
import { type ScaffoldVariant, scaffoldVariants } from './scaffold-fixture';
import {
  formatDiagnostics,
  gapsFor,
  type KnownGap,
  staleGapsIn,
  type TypecheckReport,
  typecheckScaffold,
  unexpectedIn,
} from './scaffold-typecheck-fixture';

/** Variant names per part. A shape added to `NEW_SHAPES` lands in `shapes` with no edit here. */
export const SCAFFOLD_PARTS = {
  example: ['x new'],
  bare: ['x new --no-example'],
  shapes: NEW_SHAPES.map((shape) => `x new --shape ${shape}`),
} as const satisfies Record<string, readonly string[]>;

export type ScaffoldPart = keyof typeof SCAFFOLD_PARTS;

export interface CompiledVariant {
  readonly variant: ScaffoldVariant;
  readonly report: TypecheckReport;
  readonly gaps: readonly KnownGap[];
}

/** One compile per variant of `part`, concurrently: `tsc` is the cost, not the assertions. */
export const compileScaffoldPart = (part: ScaffoldPart): Promise<readonly CompiledVariant[]> => {
  const names: readonly string[] = SCAFFOLD_PARTS[part];
  return Promise.all(
    scaffoldVariants()
      .filter((variant) => names.includes(variant.name))
      .map(async (variant) => ({
        variant,
        report: await typecheckScaffold({ files: variant.files }),
        gaps: gapsFor(variant.name),
      })),
  );
};

/** `<variant>: <line>` per line, so a red gate names the invocation as well as the file. */
const labelled = (
  compiled: readonly CompiledVariant[],
  pick: (entry: CompiledVariant) => readonly string[],
): string =>
  compiled
    .flatMap((entry) => pick(entry).map((line) => `${entry.variant.name}: ${line}`))
    .join('\n');

/**
 * Every diagnostic outside `KNOWN_GAPS`, formatted: variant, file, line, code and message, so a red
 * gate is a bug report rather than a count. `''` is green.
 */
export const surplusOf = (compiled: readonly CompiledVariant[]): string =>
  labelled(compiled, ({ report, gaps }) => {
    const surplus = unexpectedIn(report.diagnostics, gaps);
    return surplus.length === 0 ? [] : formatDiagnostics(surplus).split('\n');
  });

/** The owner of every pinned gap that no longer reproduces in the variant that pinned it. */
export const staleOf = (compiled: readonly CompiledVariant[]): string =>
  labelled(compiled, ({ report, gaps }) =>
    staleGapsIn(report.diagnostics, gaps).map((gap) => gap.owner),
  );
