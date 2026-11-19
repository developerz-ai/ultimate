// `x errors explain` for a code the APP declares with `defineError()` (`x g resource` writes one per
// slice). Loading the app registers it, and the answer is the registry's alone: title and status.
// A cause and a fix are functions of params only a throw has, so the declaring line is named instead.

import { describeErrorCode, ERROR_DOCS_URL, hasErrorCode, UltimateError } from '@ultimat3/core';
import { definedErrorStatus } from '@ultimat3/core/internal/error-status';
import { loadApp } from './app-load';
import { findAppRoot } from './app-root';
import { collectDeclaredCodes } from './error-contract';
import { quoteArg } from './shell-quote';

/** What an app code answers: what the registry holds for it, and the line that declares it. */
export interface AppCodeExplanation {
  readonly code: string;
  readonly title: string;
  readonly docs: string;
  /** `null` for an `offSocket` declaration. */
  readonly status: number | null;
  readonly site: { readonly at: string; readonly line: number } | null;
}

/**
 * The app's declaration of `code`, or `undefined`: not inside an app, the load failed, or the app
 * declares no such code. The caller then refuses with `AppCodeUnknownError`. The site is the
 * `errors` step's own answer to "where is this code declared" (`collectDeclaredCodes`), never a
 * second reading of the declaration.
 */
export async function explainAppCode(
  code: string,
  cwd: string,
): Promise<AppCodeExplanation | undefined> {
  const root = findAppRoot(cwd)?.dir;
  if (root === undefined) return undefined;
  await loadApp(root);
  if (!hasErrorCode(code)) return undefined;
  const described = describeErrorCode(code);
  const declared = (await collectDeclaredCodes(root)).find((site) => site.code === code);
  return {
    code,
    title: described.title,
    docs: described.docs ?? ERROR_DOCS_URL,
    status: definedErrorStatus(code)?.status ?? null,
    site: declared === undefined ? null : { at: declared.at, line: declared.line },
  };
}

/**
 * The framework does not know the code and no app answered for it. Same code as the CLI's own
 * `ErrorCodeUnknownError`; the fix says where an app's codes come from, which that one cannot.
 */
export class AppCodeUnknownError extends UltimateError {
  constructor(input: { readonly code: string; readonly inApp: boolean }) {
    super({
      code: 'X_ERROR_CODE_UNKNOWN',
      cause: input.inApp
        ? `"${input.code}" is neither a framework code nor one this app declares with defineError()`
        : `"${input.code}" is not a framework code, and an app's own defineError() codes resolve only inside that app`,
      fix: input.inApp
        ? `grep -rn ${quoteArg(input.code)} apps packages   # an app code is a defineError({ code }) in a slice's errors.ts; x errors list --json lists the framework's`
        : "x errors list --json   # the framework's codes; an app's own defineError() codes answer when this runs inside the app (or with --cwd set to its directory)",
    });
  }
}
