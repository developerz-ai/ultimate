// `x doctor`'s agent-kit fact: the managed skills and agents against the disk (`app-kit.ts`), as
// warnings with the fix. Never the verdict — `x verify` is where the kit is an error, and only once
// `.claude/kit.json` has opted the app in (`X_BREAKING_ON_MAIN`).

import { ERROR_DOCS_URL } from '@ultimat3/core';
import { KIT_DRIFT, KIT_FIX } from './app-kit';
import { kitVerdict } from './app-kit-disk';
import { KIT_MARKER } from './kit/registry';
import type { Finding } from './output';

export async function kitWarnings(root: string): Promise<readonly Finding[]> {
  const verdict = await kitVerdict(root);
  return [
    ...verdict.findings,
    ...verdict.warnings.map(
      (cause): Finding => ({
        code: KIT_DRIFT,
        cause,
        fix: KIT_FIX,
        docs: ERROR_DOCS_URL,
        at: KIT_MARKER,
      }),
    ),
  ];
}
