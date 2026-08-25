// One issue shape, and the two readers that produce it: a local parse result (the latency half)
// and a rejection off the server (the authoritative half). Nothing here decides what a user reads
// — `FormIssue.message` is a schema's diagnostic text, never a translated string.

import { renderThrowable, stringField } from '@ultimat3/core';
import { formatFieldPath, type IssuePathSegment, parseFieldPath } from './field-path';

/**
 * One rejected value, addressed by the path the schema gave it.
 *
 * `message` is UNTRANSLATED and is not user-facing: it is whatever the schema library or the
 * server wrote (`expected number`). The app turns it into words through `messageFor` — the
 * framework ships no copy table, because the wording is the app's and the mapping is not.
 */
export interface FormIssue {
  /** Canonical dotted path, `''` when the issue addresses the form rather than a field. */
  readonly path: string;
  readonly message: string;
  /** The framework code that carried it, when a rejection named one. */
  readonly code: string | undefined;
}

/** One issue as a conforming schema library reports it. */
export interface FormValidationIssue {
  readonly message: string;
  readonly path?: readonly (PropertyKey | IssuePathSegment)[] | undefined;
}

/**
 * Standard Schema's result: `issues` present is the failure, absent is the pass.
 *
 * The success member holds `value: unknown` and nothing reads it — the type says what the runtime
 * does. A client-side parse is a latency optimisation, so its OUTPUT is not something the server
 * agreed to, and typing it would invite a caller to submit it.
 */
export type FormValidationResult =
  | { readonly value: unknown; readonly issues?: undefined }
  | { readonly issues: readonly FormValidationIssue[] };

/**
 * The minimum of an input schema this package needs — Standard Schema's one member, declared
 * structurally so `@ultimat3/ui` needs no dependency edge on `@ultimat3/schema`. An `action()`'s
 * own `input` satisfies it as written.
 *
 * The OUTPUT type is deliberately absent: a client-side parse is a latency optimisation, its value
 * is thrown away, and typing it would invite a caller to submit it.
 */
export interface FormSchema {
  readonly '~standard': {
    readonly validate: (value: unknown) => FormValidationResult | Promise<FormValidationResult>;
  };
}

/** A local parse's issues, addressed by path. A result with none answers `[]`. */
export function issuesFromValidation(result: FormValidationResult): readonly FormIssue[] {
  const issues = result.issues;
  if (issues === undefined) return [];
  return issues.map((issue) => ({
    path: formatFieldPath(issue.path),
    message: issue.message,
    code: undefined,
  }));
}

/** The codes whose `cause` is a rendered issue list rather than a sentence. */
const VALIDATION_CODES: ReadonlySet<string> = new Set(['X_INPUT_INVALID', 'X_VALIDATION_FAILED']);

/** `@ultimat3/action`'s `InputInvalidError` prefixes the list with the action it refused for. */
const LIST_PREFIX = 'failed validation: ';

/**
 * `formatIssues()`'s separator, on both sides of the wire. A message that itself contains `'; '`
 * splits wrongly here — and degrades VISIBLY, because a fragment whose head is not a field path
 * lands at the form rather than on a control. That is the cost of the wire carrying no structured
 * issue list; see this file's note in `README.md`.
 */
const ISSUE_SEPARATOR = '; ';

function issuesFromCauseLine(cause: string, code: string): readonly FormIssue[] {
  const prefix = cause.lastIndexOf(LIST_PREFIX);
  const list = prefix === -1 ? cause : cause.slice(prefix + LIST_PREFIX.length);
  return list
    .split(ISSUE_SEPARATOR)
    .map((part) => part.trim())
    .filter((part) => part.length > 0)
    .map((part) => {
      const at = part.indexOf(': ');
      const head = at === -1 ? '' : part.slice(0, at);
      // Only a head that PARSES becomes a path. Otherwise the fragment is a sentence holding a
      // colon, and splitting it would mint a field name the form never declared.
      if (head === '' || parseFieldPath(head) === null) return { path: '', message: part, code };
      return { path: head, message: part.slice(at + 2), code };
    });
}

/** `meta.issues`, when the rejection survived with its structure intact. */
function issuesFromMeta(rejection: object, code: string | undefined): readonly FormIssue[] | null {
  let held: unknown;
  try {
    const meta: unknown = (rejection as Record<string, unknown>)['meta'];
    if (typeof meta !== 'object' || meta === null) return null;
    held = (meta as Record<string, unknown>)['issues'];
  } catch {
    // A getter or a Proxy trap fought the read; the cause line below is still there.
    return null;
  }
  if (!Array.isArray(held)) return null;
  const issues: FormIssue[] = [];
  for (const entry of held as readonly unknown[]) {
    const message = stringField(entry, 'message');
    if (message === undefined) return null;
    issues.push({ path: stringField(entry, 'path') ?? '', message, code });
  }
  return issues.length === 0 ? null : issues;
}

/**
 * Whatever the server rejected with, as issues. Total over `unknown`: an `UltimateError`, a plain
 * object off a worker or a WebSocket, a parsed `application/problem+json` body (`code` and `cause`
 * are members of that document) and a `TypeError` from a fetch that never left the browser all
 * answer here, and every one of them answers with at least one issue.
 *
 * Never empty. A rejection that produced no issue would be a form that submitted, failed, and
 * showed nothing — which is worse than having no binding at all.
 */
export function issuesFromRejection(rejection: unknown): readonly FormIssue[] {
  const code = stringField(rejection, 'code');
  if (typeof rejection === 'object' && rejection !== null) {
    const structured = issuesFromMeta(rejection, code);
    if (structured !== null) return structured;
  }
  const cause = stringField(rejection, 'cause') ?? stringField(rejection, 'detail');
  if (code !== undefined && cause !== undefined && VALIDATION_CODES.has(code)) {
    const parsed = issuesFromCauseLine(cause, code);
    if (parsed.length > 0) return parsed;
  }
  return [{ path: '', message: cause ?? renderThrowable(rejection), code }];
}
