/**
 * The one reader of a problem document's `issues` member: an untrusted array off the wire, back
 * into the `ValidationIssue` shape `@ultimat3/schema` already mints. Its own module because it is
 * the only place in the client where a value nobody in this process built is turned into a
 * structure another layer will render.
 */

import { stringField } from '@ultimat3/core';
import type { ValidationIssue } from '@ultimat3/schema';

/**
 * A list this long is not a form's worth of rejections; it is a body meant to be expensive. The
 * entries are rendered into a DOM by whoever displays them, so the bound is here rather than there.
 */
export const MAX_WIRE_ISSUES = 100;

/**
 * All-or-nothing on purpose. A partly-parsed list would DROP the entries it could not read, and
 * nothing downstream would know: a caller that finds `meta.issues` uses it INSTEAD of the
 * flattened `cause`, so a dropped entry is a rejection the user never hears about. Refusing the
 * whole list leaves the `cause` — which still holds every issue — as the answer.
 */
export function issuesFromWire(value: unknown): readonly ValidationIssue[] | undefined {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_WIRE_ISSUES) {
    return undefined;
  }
  const issues: ValidationIssue[] = [];
  for (const entry of value as readonly unknown[]) {
    if (typeof entry !== 'object' || entry === null) return undefined;
    // Strict on the two members that DECIDE where an issue lands, defaulted on the two that only
    // describe it: a `path` that is not a string would bind a rejection somewhere it does not
    // belong, while a missing `expected` cannot mis-route anything.
    const path = stringField(entry, 'path');
    const message = stringField(entry, 'message');
    if (path === undefined || message === undefined || message.length === 0) return undefined;
    // Built member by member, never spread: a foreign issue object may carry the rejected VALUE
    // (some libraries put it in `received`), and a whole-object copy would forward it to whoever
    // renders the list. Four members travel; everything else stops here.
    issues.push({
      path,
      expected: stringField(entry, 'expected') ?? '',
      received: stringField(entry, 'received') ?? '',
      message,
    });
  }
  return issues;
}
