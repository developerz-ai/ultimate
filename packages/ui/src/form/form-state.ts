// Where an issue LANDS. One rule — a path that matches a declared field goes to that field, and
// everything else goes to the form — because the alternative is an error the user cannot see on a
// control the app forgot to declare, which is worse than having no binding at all.

import type { FormIssue } from './form-issue';
import { type FormTouch, NO_FORM_TOUCH } from './form-touch';

export type FormStatus = 'idle' | 'submitting' | 'succeeded' | 'failed';

/** Already-translated messages, addressed the way `Field` and `Form` consume them. */
export interface FormErrors {
  readonly fieldErrors: ReadonlyMap<string, readonly string[]>;
  readonly formErrors: readonly string[];
}

export interface FormState<TResult> extends FormErrors, FormTouch {
  readonly status: FormStatus;
  /** The server's answer. Only ever set from a resolved `submit`. */
  readonly result: TResult | undefined;
  /** The untranslated issues behind the messages above — nothing is dropped on the way in. */
  readonly issues: readonly FormIssue[];
}

const NO_FIELD_ERRORS: ReadonlyMap<string, readonly string[]> = new Map();

/** The empty pair, shared: every member is readonly and neither is ever mutated in place. */
export const NO_FORM_ERRORS: FormErrors = Object.freeze({
  fieldErrors: NO_FIELD_ERRORS,
  formErrors: Object.freeze([]),
});

/** `FormState<never>` is assignable to every `FormState<T>`: every member is readonly. */
export const IDLE_FORM_STATE: FormState<never> = Object.freeze({
  status: 'idle',
  fieldErrors: NO_FIELD_ERRORS,
  formErrors: [],
  result: undefined,
  issues: [],
  touched: NO_FORM_TOUCH.touched,
  dirty: NO_FORM_TOUCH.dirty,
});

/**
 * A translator that answers nothing, or that throws, degrades to the schema's own diagnostic text
 * — the same choice `t()` makes with `⟦key⟧`. The two alternatives are worse in the two ways that
 * matter: a blank message leaves a control marked `aria-invalid` with nothing to read, and letting
 * the throw out abandons the submit mid-flight, so the form spins forever holding the user's input.
 */
function translate(issue: FormIssue, messageFor: (issue: FormIssue) => string): string {
  let rendered: string;
  try {
    rendered = messageFor(issue);
  } catch {
    // The app's translator is not the framework's to report on, and this frame is the one that
    // tells the user their submit failed.
    return issue.message;
  }
  return rendered.trim() === '' ? issue.message : rendered;
}

/**
 * Issues to slots. A path is bound only where the form DECLARED that exact field: a near miss
 * (`items` against a form holding `items[0].price`) surfaces at the form, never on a neighbouring
 * control, because an error rendered against the wrong input is a lie the user acts on.
 */
export function distributeIssues(
  issues: readonly FormIssue[],
  fields: ReadonlySet<string>,
  messageFor: (issue: FormIssue) => string,
): FormErrors {
  const fieldErrors = new Map<string, readonly string[]>();
  const formErrors: string[] = [];
  for (const issue of issues) {
    const message = translate(issue, messageFor);
    if (issue.path !== '' && fields.has(issue.path)) {
      fieldErrors.set(issue.path, [...(fieldErrors.get(issue.path) ?? []), message]);
      continue;
    }
    formErrors.push(message);
  }
  return { fieldErrors, formErrors };
}

/**
 * The first DECLARED field carrying an error, in declaration order — which is also the order the
 * controls are rendered in, so it is the one the reader reaches first going down the page. What a
 * failed submit moves focus to.
 *
 * Declaration order, never the ISSUE order: a server is free to report the last field first, and
 * focus would then land halfway down a form the user has not read.
 */
export function firstInvalidField(state: FormErrors, fields: Iterable<string>): string | undefined {
  for (const name of fields) {
    if (state.fieldErrors.has(name)) return name;
  }
  return undefined;
}

/** Every message bound to one field, in the order the issues arrived. */
export function messagesOf(state: FormErrors, path: string): readonly string[] {
  return state.fieldErrors.get(path) ?? [];
}

/**
 * The one message `Field`'s single error slot renders. The rest stay reachable through
 * `messagesOf` — one slot is a rendering decision, so nothing is discarded from the state.
 */
export function errorOf(state: FormErrors, path: string): string | undefined {
  return messagesOf(state, path)[0];
}
