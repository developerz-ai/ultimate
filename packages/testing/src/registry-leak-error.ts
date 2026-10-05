// Single responsibility: `X_TEST_REGISTRY_LEAK`'s message — which file left which cache tags and
// tiers registered, the isolating lines to paste, and the `bun test` re-run. The CODE is declared
// in `errors.ts`, the package's registry, which re-exports this class; the shape it reports is
// `registry-leak-guard.ts`'s. Split from `errors.ts` at the 500-line ceiling.

import { isFixShellSafe, renderCauseValue, renderFixLiteral, UltimateError } from '@ultimat3/core';
// Type-only, so the cycle with the guard that throws it is erased at build.
import type { RegistryLeak } from './registry-leak-guard';

/**
 * Every value in this message is uncontrolled: the path arrives from `Bun.plugin`'s `onLoad`, and
 * the names are whatever the app under test passed to `declareTags()` / `registerTier()`. So the
 * sentence renders them (bounded, never throwing while describing a leak) and the command quotes
 * them (a fix has to parse after a path with a space or a quote in it lands in the middle of it).
 */
const describeLeak = (leak: RegistryLeak): string => {
  const left = [
    ...(leak.tags.length > 0 ? [`cache tags declared ${renderCauseValue(leak.tags)}`] : []),
    ...(leak.tiers.length > 0 ? [`cache tiers registered ${renderCauseValue(leak.tiers)}`] : []),
  ];
  return `${renderCauseValue(leak.file)} left ${left.join(' and ')} after its last test`;
};

/** The placeholder is the cause's own sentence: it already names every file, in order. */
const FILE_PLACEHOLDER = '<the file the cause names>';

/**
 * Inside double quotes `$`, a backtick and `!` are still live, and `renderFixLiteral` answers double
 * quotes — so a path carrying one becomes the quoted placeholder in the `bun test` command. Any other
 * path stays the JSON literal: an ordinary path, or one with a quote JSON escapes, still runs.
 */
const DOUBLE_QUOTE_LIVE = /[$`!]/;

const rerunArg = (file: string): string =>
  isFixShellSafe(file) || !DOUBLE_QUOTE_LIVE.test(file)
    ? renderFixLiteral(file, FILE_PLACEHOLDER)
    : `'${FILE_PLACEHOLDER}'`;

/** Every leaked file as `bun test` arguments — one screen, so the fix-shell-arg guard can see it. */
const rerunFileArgs = (leaks: readonly RegistryLeak[]): string =>
  leaks.map((leak) => rerunArg(leak.file)).join(' ');

/**
 * The edit, spelled as the lines to paste — the imports included, since neither call is global.
 *
 * Both repairs isolate; neither resets. `afterAll(resetTiers)` was the first spelling of the tier
 * half and it is the bug wearing the fix's clothes: it drops the tiers, the revalidator and both
 * logs a NEIGHBOUR registered, and the guard reports additions only, so the damage lands on an
 * innocent file with nothing pointing back here. An error whose instruction causes the next defect
 * is worse than no instruction.
 */
const repairFor = (leak: RegistryLeak): string => {
  const imports: string[] = [];
  const calls: string[] = [];
  if (leak.tags.length > 0) {
    imports.push('isolateDeclaredTags');
    calls.push('const restoreTags = isolateDeclaredTags(); afterAll(restoreTags);');
  }
  if (leak.tiers.length > 0) {
    imports.push('isolateTiers');
    calls.push('const restoreTiers = isolateTiers(); afterAll(restoreTiers);');
  }
  const file = renderFixLiteral(leak.file, FILE_PLACEHOLDER);
  return `in ${file} add: import { ${imports.join(', ')} } from '@ultimat3/cache'; ${calls.join(' ')}`;
};

/**
 * One error for every leaker in the run, not one per file: the run has already finished by the
 * time the last file can be judged, and two throws would report the second as an unhandled one.
 * The trailing command reproduces the failure on its own — the guard judges each file against its
 * own baseline, so one leaking file fails a one-file run exactly as it failed the whole suite.
 */
export class RegistryLeakError extends UltimateError {
  constructor(input: { readonly leaks: readonly RegistryLeak[] }) {
    super({
      code: 'X_TEST_REGISTRY_LEAK',
      cause: input.leaks.map(describeLeak).join('; '),
      fix: `${input.leaks.map(repairFor).join('; ')} — then re-run: bun test ${rerunFileArgs(input.leaks)}`,
    });
  }
}
