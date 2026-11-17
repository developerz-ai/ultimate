// `x errors explain` for a code a guard raises: the shipped guards' (`X_RAW_COLOUR`, derived from the
// guard's name) and the app's own `guards/*.ts`. Neither is in an error registry — the app owns
// the codes its conventions raise — so each is answered from the guard's own declaration: its
// `summary`, read off the source text, never by importing and running the rule.

// why: Bun ships no path joiner; `guards/` sits under the app root.
import { join } from 'node:path';
import { ERROR_DOCS_URL } from '@ultimat3/core';
import type { ErrorExplanation } from '@ultimat3/mcp';
import { findAppRoot } from './app-root';
import { SHIPPED_GUARD_CONFIG, SHIPPED_SEVERITY_FIELD } from './guards-built-in';
import { SHIPPED_GUARD_NAMES, shippedGuardCode } from './guards-shipped-names';

/** `summary: '…'` in a guard's `export const guard = { … }`, the line broken after the colon or not. */
const SUMMARY = /\bsummary:\s*'((?:[^'\\]|\\.)*)'/;

const summaryOf = (source: string): string | undefined => SUMMARY.exec(source)?.[1];

const RUN = 'x verify --only boundaries --json';

/** A shipped guard: its template's text, loaded only when a guard code was asked about. */
async function explainShipped(code: string): Promise<ErrorExplanation | undefined> {
  const name = SHIPPED_GUARD_NAMES.find((one) => shippedGuardCode(one) === code);
  if (name === undefined) return undefined;
  const { shippedGuardSource } = await import('./templates/scaffold-guards');
  const summary = summaryOf(shippedGuardSource(name) ?? '') ?? name;
  return {
    code,
    cause: `the shipped ${name} guard refuses it: ${summary} (run by the boundaries step of x verify)`,
    fix: `${RUN}   # each ${code} finding names its file:line and the edit that clears it; to stop running the guard, set "${name}": "off" under "${SHIPPED_SEVERITY_FIELD}" in ${SHIPPED_GUARD_CONFIG}`,
    docs: ERROR_DOCS_URL,
  };
}

/** An app guard: the `guards/*.ts` file whose text names the code as a literal. */
async function explainAppGuard(code: string, cwd: string): Promise<ErrorExplanation | undefined> {
  const literal = new RegExp(`['"\`]${code}['"\`]`);
  // The app's root from anywhere inside it; outside an app, `--cwd` as given.
  const dir = join(findAppRoot(cwd)?.dir ?? cwd, 'guards');
  let files: string[];
  try {
    files = await Array.fromAsync(new Bun.Glob('*.{ts,tsx}').scan({ cwd: dir }));
  } catch {
    // No `guards/` here: not an app, or an app with none — nothing to explain from.
    return undefined;
  }
  for (const file of files.sort()) {
    if (/\.test\.tsx?$/.test(file)) continue;
    const source = await Bun.file(join(dir, file)).text();
    if (!literal.test(source)) continue;
    const at = `guards/${file}`;
    return {
      code,
      cause: `this app's guard ${at} refuses it: ${summaryOf(source) ?? 'its summary is not a plain string'} (run by the boundaries step of x verify)`,
      fix: `${RUN}   # each ${code} finding names its file:line and the edit that clears it; the rule is ${at} — delete that file to drop it`,
      docs: ERROR_DOCS_URL,
    };
  }
  return undefined;
}

/** The guard behind `code` — the app's own first, since its file is what this app runs. */
export async function explainGuardCode(
  code: string,
  cwd: string,
): Promise<ErrorExplanation | undefined> {
  if (!/^X(?:_[A-Z0-9]+)+$/.test(code)) return undefined;
  return (await explainAppGuard(code, cwd)) ?? (await explainShipped(code));
}
