// No `export *` in shipped package source: a blind re-export publishes names no reader can see
// without resolving the module, and `package-reexports.ts` cannot tell whether one of them is
// another package's value — so the one-home rule is only complete while every re-export is named.
// A scan rather than Biome's `noReExportAll`: see `export-all.test.ts`'s header for the measurement.

import { maskLiterals } from '../../packages/core/src/source-mask';
import type { Finding } from './log';
import { lineOf } from './source-scan';

/** Read from the MASKED view: a scaffold template writing `export *` into an app is a string. */
const EXPORT_ALL = /\bexport\s*(?:type\s*)?\*\s*(?:as\s+[\w$]+\s*)?from\b/g;

/** The specifier after `from`, read from the raw text — the masked view blanked it. */
const SPECIFIER = /^\s*(['"])([^'"]*)\1/;

export function exportAllViolations(file: {
  readonly at: string;
  readonly text: string;
}): readonly Finding[] {
  return [...maskLiterals(file.text).matchAll(EXPORT_ALL)].map((match): Finding => {
    const end = match.index + match[0].length;
    const from = SPECIFIER.exec(file.text.slice(end))?.[2] ?? '<module>';
    return {
      code: 'X_HELPER_COPY',
      cause: `${file.at}:${lineOf(file.text, match.index)} re-exports ${from} blind — \`export *\` publishes names no reader can see, so no rule can tell a second import path from a first`,
      fix: `bun run flight-copies   # after naming each value: export { … } from '${from}' in ${file.at}`,
      at: file.at,
    };
  });
}
