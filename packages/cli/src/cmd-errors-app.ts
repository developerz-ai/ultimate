// `x errors explain` for a code the APP declares with `defineError()` (`x g resource` writes one per
// slice). Loading the app registers it; its cause and fix are read off the declaration's own text,
// never by constructing the error — a cause is a function of params nobody has here.

import { describeErrorCode, ERROR_DOCS_URL, hasErrorCode, UltimateError } from '@ultimat3/core';
import { definedErrorStatus } from '@ultimat3/core/internal/error-status';
import { loadApp } from './app-load';
import { findAppRoot } from './app-root';
import { quoteArg } from './shell-quote';

/** What an app code answers: the explanation's fields, plus the HTTP status and the declaring line. */
export interface AppCodeExplanation {
  readonly code: string;
  readonly title: string;
  readonly cause: string;
  readonly fix: string;
  readonly docs: string;
  /** `null` for an `offSocket` declaration. */
  readonly status: number | null;
  readonly site: { readonly at: string; readonly line: number } | null;
}

/** A quoted literal — the three quotes a declaration may use — captured without its quotes. */
const LITERAL = String.raw`(['"\x60])((?:\\.|(?!\1)[^\\])*)\1`;

/** `key: '…'`, or `key: (params) => \`…\``, inside the declaration's text. */
const fieldOf = (block: string, key: string): string | undefined =>
  new RegExp(String.raw`\b${key}:\s*(?:\([^)]*\)\s*=>\s*)?${LITERAL}`).exec(block)?.[2];

/** The declaration holding `code: '<code>'` among the app's loaded modules: file, line, its text. */
async function declarationOf(
  root: string,
  files: readonly string[],
  code: string,
): Promise<{ readonly at: string; readonly line: number; readonly block: string } | undefined> {
  const literal = new RegExp(String.raw`\bcode:\s*['"\x60]${code}['"\x60]`);
  for (const at of files) {
    const text = await Bun.file(`${root}/${at}`).text();
    const found = literal.exec(text);
    if (found === null) continue;
    const start = text.lastIndexOf('defineError', found.index);
    const end = text.indexOf('});', found.index);
    const block = text.slice(start < 0 ? found.index : start, end < 0 ? undefined : end);
    return { at, line: text.slice(0, found.index).split('\n').length, block };
  }
  return undefined;
}

/**
 * The app's declaration of `code`, or `undefined`: not inside an app, the load failed, or the app
 * declares no such code. The caller then refuses with `AppCodeUnknownError`.
 */
export async function explainAppCode(
  code: string,
  cwd: string,
): Promise<AppCodeExplanation | undefined> {
  const root = findAppRoot(cwd)?.dir;
  if (root === undefined) return undefined;
  const app = await loadApp(root);
  if (!hasErrorCode(code)) return undefined;
  const described = describeErrorCode(code);
  const declared = await declarationOf(root, app.files, code);
  const site = declared === undefined ? null : { at: declared.at, line: declared.line };
  const where = site === null ? 'this app' : `${site.at}:${site.line}`;
  return {
    code,
    title: described.title,
    cause: `${described.title} — declared by ${where}: ${fieldOf(declared?.block ?? '', 'cause') ?? described.title}`,
    fix: fieldOf(declared?.block ?? '', 'fix') ?? `grep -rn ${quoteArg(code)} apps packages`,
    docs: described.docs ?? ERROR_DOCS_URL,
    status: definedErrorStatus(code)?.status ?? null,
    site,
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
