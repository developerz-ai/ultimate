// `x doctor`'s TypeScript check: every manifest whose `typescript` range lags the one `x new`
// scaffolds is `X_TYPESCRIPT_VERSION`, its fix the `bun add` that moves exactly that manifest.
// The rule is `typescript-floor.ts`'s; this file reads the manifests and words the finding.

import { ERROR_DOCS_URL } from '@ultimat3/core';
import type { Finding } from './output';
import type { TypescriptLag } from './typescript-floor';
import { typescriptLags } from './typescript-floor';
import { readManifests } from './upgrade-pins';

/**
 * The I/O half: the root manifest and every workspace's, the set `x upgrade` moves pins in. An
 * unreadable root manifest is not this check's to report — `bun install` names its line — so it
 * reads as nothing to judge rather than a second finding about the same file.
 */
export async function typescriptProbe(root: string): Promise<readonly TypescriptLag[]> {
  try {
    return typescriptLags(await readManifests(root));
  } catch {
    return [];
  }
}

export const typescriptFindings = (lags: readonly TypescriptLag[]): readonly Finding[] =>
  lags.map((lag) => ({
    code: 'X_TYPESCRIPT_VERSION',
    at: lag.file,
    cause: `${lag.file} declares ${lag.field}.typescript ${JSON.stringify(lag.from)}, below the ${lag.to} \`x new\` scaffolds; @ultimat3/* ships source and .d.ts checked by that compiler, so typecheck and build go red on framework files this app never wrote`,
    fix: lag.fix,
    docs: ERROR_DOCS_URL,
  }));
