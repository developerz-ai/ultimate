// The flash a native form's answer leaves for the next render: one cookie, written by the HTTP
// projection (`native-answer.ts`) and read once by the page that follows (`useActionAnswer`). Both
// halves live here so the wire shape has one owner: the writer and the reader cannot drift.

import { deleteCookie, setCookie, useRequestCookie } from '@ultimat3/http';
import type { SchemaIssueParams } from '@ultimat3/schema';
import { issueRuleFacts } from '@ultimat3/schema';
import type { AnyAction } from './action';
import { actionName } from './invoke';

/** The cookie's name. Fixed: an app reads the answer through `useActionAnswer`, never by name. */
export const ACTION_ANSWER_COOKIE = 'x_action_answer';

/** Seconds the flash lives unread: long enough for a 303 to be followed, short enough to forget. */
export const ACTION_ANSWER_MAX_AGE = 60;

/** The encoded flash stays well under a browser's 4 KiB per cookie; issues past it are dropped. */
const MAX_ENCODED = 3000;

/** One field's refusal: where (`path`), and which rule with its numbers — never the value, never prose. */
export interface ActionAnswerIssue {
  readonly path: string;
  readonly rule?: string;
  readonly params?: SchemaIssueParams;
}

export type ActionAnswer =
  | { readonly action: string; readonly outcome: 'success' }
  | {
      readonly action: string;
      readonly outcome: 'refusal';
      readonly code: string;
      readonly issues: readonly ActionAnswerIssue[];
      /** `true` when issues were dropped to keep the cookie under its size. */
      readonly truncated: boolean;
    };

/** The issues a refusal carries, read member by member off whatever the error held. */
export function answerIssues(issues: unknown): readonly ActionAnswerIssue[] {
  if (!Array.isArray(issues)) return [];
  const out: ActionAnswerIssue[] = [];
  for (const issue of issues as readonly unknown[]) {
    const path = typeof issue === 'object' && issue !== null ? Reflect.get(issue, 'path') : null;
    if (typeof path !== 'string') continue;
    out.push({ path, ...issueRuleFacts(issue) });
  }
  return out;
}

const encodedLength = (answer: ActionAnswer): number =>
  encodeURIComponent(JSON.stringify(answer)).length;

/** The flash, cut to fit: whole issues dropped from the end, never a half-written one. */
export function fitAnswer(answer: ActionAnswer): ActionAnswer {
  if (answer.outcome === 'success' || encodedLength(answer) <= MAX_ENCODED) return answer;
  let issues = answer.issues;
  while (issues.length > 0 && encodedLength({ ...answer, issues }) > MAX_ENCODED) {
    issues = issues.slice(0, -1);
  }
  return { ...answer, issues, truncated: true };
}

/** Write the flash on the response to the request in scope. */
export function writeActionAnswer(answer: ActionAnswer): void {
  setCookie(ACTION_ANSWER_COOKIE, JSON.stringify(fitAnswer(answer)), {
    maxAge: ACTION_ANSWER_MAX_AGE,
    sameSite: 'Lax',
  });
}

/** An untrusted cookie value back into an answer, or `null`: it arrived from the browser. */
export function parseActionAnswer(raw: string | null): ActionAnswer | null {
  if (raw === null || raw.length > MAX_ENCODED * 2) return null;
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof value !== 'object' || value === null) return null;
  const action = Reflect.get(value, 'action');
  const outcome = Reflect.get(value, 'outcome');
  if (typeof action !== 'string' || action === '') return null;
  if (outcome === 'success') return { action, outcome };
  const code = Reflect.get(value, 'code');
  if (outcome !== 'refusal' || typeof code !== 'string' || !/^X_[A-Z0-9_]+$/.test(code)) {
    return null;
  }
  const issues = answerIssues(Reflect.get(value, 'issues'));
  return { action, outcome, code, issues, truncated: Reflect.get(value, 'truncated') === true };
}

/**
 * The answer the last native form submission left, read ONCE: the cookie is cleared on read.
 * Call it from a route's `load` — a header after a stream's first flush is refused. Given an
 * action, only that action's answer: two forms on one page do not read each other's outcome. A
 * page that may not import the action (`app/` → `api/`) names it: `'createPost' satisfies keyof
 * Api['actions']`. `null` on a `static`/`isr` page, which is rendered as nobody and sees no cookie.
 */
export function useActionAnswer(target?: AnyAction | string): ActionAnswer | null {
  const answer = parseActionAnswer(useRequestCookie(ACTION_ANSWER_COOKIE));
  if (answer === null) return null;
  const name = typeof target === 'string' || target === undefined ? target : actionName(target);
  if (name !== undefined && answer.action !== name) return null;
  deleteCookie(ACTION_ANSWER_COOKIE, { sameSite: 'Lax' });
  return answer;
}
