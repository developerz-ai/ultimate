// A copy of a shipped guard still in an app's `guards/`, judged against every form the framework
// shipped, and the one finding that names it: an unedited copy is one delete, an edited one a rename
// to the app's own guard plus a `guards/shipped.json` row, with its diff — the migration, as an edit.

import { ERROR_DOCS_URL } from '@ultimat3/core';
import { unifiedDiff } from './codemods/engine-diff';
import { GUARD_VENDORED_CODE, SHIPPED_GUARD_CONFIG } from './guards-built-in';
import type { Finding } from './output';
import { RELEASED_GUARD_FORMS } from './templates/guard-released-forms';
import { shippedGuardForms, shippedGuardSource } from './templates/scaffold-guards';

/** A checkout on Windows may write CRLF; the rule is the same text either way. */
export const sameText = (a: string, b: string): boolean =>
  a.replaceAll('\r\n', '\n') === b.replaceAll('\r\n', '\n');

/** A rule-file text's identity across checkouts: CRLF-blind, the key `RELEASED_GUARD_FORMS` holds. */
export const guardFormHash = (text: string): string =>
  Bun.hash(text.replaceAll('\r\n', '\n')).toString(36);

/**
 * How a form the framework shipped reports — the current template or any released before it — or
 * `undefined` when `text` is no such form: the app's edit.
 */
export function shippedFormSeverity(
  name: string,
  text: string,
  released: Readonly<
    Record<string, readonly (readonly [string, 'error' | 'warning'])[]>
  > = RELEASED_GUARD_FORMS,
): 'error' | 'warning' | undefined {
  const current = shippedGuardForms(name).find((form) => sameText(text, form.source));
  if (current !== undefined) return current.severity;
  const hash = guardFormHash(text);
  return (Object.hasOwn(released, name) ? released[name] : undefined)?.find(
    ([known]) => known === hash,
  )?.[1];
}

export interface VendoredCopy {
  readonly name: string;
  /** App-root-relative: `guards/<name>.ts` or `.tsx`. */
  readonly path: string;
  /** A form the framework shipped, current or released (`shippedFormSeverity`): nobody edited it. */
  readonly identical: boolean;
  /** The shipped guard → this copy, unified; absent when identical. */
  readonly diff?: string;
}

/** The copy at `path`, judged against every current form of the shipped guard `name`. */
export function vendoredCopy(name: string, path: string, source: string): VendoredCopy {
  if (shippedFormSeverity(name, source) !== undefined) return { name, path, identical: true };
  const shipped = shippedGuardSource(name) ?? '';
  return { name, path, identical: false, diff: unifiedDiff(path, shipped, source) };
}

/** The edit that resolves a copy — what the `vendored-guards` codemod would have done to it. */
export function resolvingEdit({ name, path, identical }: VendoredCopy): string {
  const test = `guards/${name}.test.ts`;
  if (identical) return `rm -f ${path} ${test} && x verify --only boundaries --json`;
  const kept = path.replace(`guards/${name}.`, `guards/app-${name}.`);
  return `mv ${path} ${kept} && x verify --only boundaries --json   # then "${name}": "off" in ${SHIPPED_GUARD_CONFIG} and ${test}'s import to ./app-${name} — or rm ${path} to take the shipped rule (the diff is x doctor --json's data.guards.differs)`;
}

/** One warning per copy: a copy runs in place of the installed guard and never receives a fix. */
export const vendoredFinding = (copy: VendoredCopy): Finding => ({
  code: GUARD_VENDORED_CODE,
  cause: copy.identical
    ? `${copy.path} is an unedited copy of the shipped ${copy.name} guard, which the framework now runs built in: the copy runs in its place, so a fix to it never reaches this app`
    : `${copy.path} is an edited copy of the shipped ${copy.name} guard: it runs in place of the one the framework now runs built in, so a fix to it never reaches this app, and your edit is not yet your own guard`,
  fix: resolvingEdit(copy),
  docs: ERROR_DOCS_URL,
  at: copy.path,
});
