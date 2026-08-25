// The binding itself: an action's input schema on one side, `Field`'s error slot on the other, and
// a submit that only the SERVER can turn into a success.
//
// Server authority is structural here, not documented: `submit` is required, `succeeded` is
// produced in exactly one place — after the caller's `submit` resolves — and the local parse's
// VALUE is discarded, so a client cannot decide either that a form is valid or what it said.

import { invalidFieldPathError } from '../errors';
import { parseFieldPath } from './field-path';
import {
  type FormIssue,
  type FormSchema,
  issuesFromRejection,
  issuesFromValidation,
} from './form-issue';
import {
  distributeIssues,
  errorOf,
  type FormState,
  IDLE_FORM_STATE,
  messagesOf,
  NO_FORM_ERRORS,
} from './form-state';

export interface FormBindingOptions<TValues, TResult> {
  /**
   * The server call — `action.client()`, `rpc(...).createPost`, or a `fetch` that throws on a
   * refusal. REQUIRED: it is the only thing in this file that can produce a success.
   */
  readonly submit: (values: TValues) => Promise<TResult>;
  /** The paths this form renders a control for. An issue matching none surfaces at the form. */
  readonly fields: readonly string[];
  /** The app's wording for one issue. The framework ships the mapping, never the copy. */
  readonly messageFor: (issue: FormIssue) => string;
  /**
   * The action's `input`. Optional, and a LATENCY optimisation only: the action re-parses on the
   * server on every path, so omitting this changes when the user hears about a bad value, never
   * whether it is rejected.
   */
  readonly schema?: FormSchema | undefined;
  /** Called on every transition — how a reactive shell mirrors the state into a signal. */
  readonly onState?: ((state: FormState<TResult>) => void) | undefined;
}

export interface FormBinding<TValues, TResult> {
  readonly state: () => FormState<TResult>;
  readonly submit: (values: TValues) => Promise<FormState<TResult>>;
  /** The message `Field`'s single error slot renders for one path. */
  readonly errorFor: (path: string) => string | undefined;
  /** Every message bound to one path, when a form renders more than one. */
  readonly messagesFor: (path: string) => readonly string[];
  readonly reset: () => void;
}

/**
 * Refused at DECLARATION, which is the only place it can be caught: a field named `items.0.price`
 * is never equal to the `items[0].price` an issue carries, so its server errors would pile up at
 * the top of the form and look exactly like an app with nothing wrong.
 */
function declaredFields(fields: readonly string[]): ReadonlySet<string> {
  const declared = new Set<string>();
  for (const name of fields) {
    if (parseFieldPath(name) === null) throw invalidFieldPathError('form field', name);
    declared.add(name);
  }
  return declared;
}

export function createFormBinding<TValues, TResult>(
  options: FormBindingOptions<TValues, TResult>,
): FormBinding<TValues, TResult> {
  const fields = declaredFields(options.fields);
  let state: FormState<TResult> = IDLE_FORM_STATE;
  let inFlight: Promise<FormState<TResult>> | null = null;

  const publish = (next: FormState<TResult>): FormState<TResult> => {
    state = next;
    options.onState?.(next);
    return next;
  };

  const failed = (issues: readonly FormIssue[]): FormState<TResult> =>
    publish({
      status: 'failed',
      ...distributeIssues(issues, fields, options.messageFor),
      result: undefined,
      issues,
    });

  const run = async (values: TValues): Promise<FormState<TResult>> => {
    // Cleared, never carried: a stale message would mark a control invalid for a value the user
    // has already changed, on the one screen where the user is watching for exactly that.
    publish({ status: 'submitting', ...NO_FORM_ERRORS, result: undefined, issues: [] });

    const schema = options.schema;
    if (schema !== undefined) {
      // The result's `value` is read by nothing. Deliberately: the parse below is the browser's
      // opinion, and the only thing this file wants from it is which paths to complain about.
      const local = issuesFromValidation(await schema['~standard'].validate(values));
      if (local.length > 0) return failed(local);
    }

    try {
      const result = await options.submit(values);
      return publish({ status: 'succeeded', ...NO_FORM_ERRORS, result, issues: [] });
    } catch (rejection) {
      return failed(issuesFromRejection(rejection));
    }
  };

  return {
    state: () => state,
    /** A second submit JOINS the first rather than starting one: a double click is not two writes. */
    submit: (values) => {
      if (inFlight !== null) return inFlight;
      const flight = run(values).finally(() => {
        inFlight = null;
      });
      inFlight = flight;
      return flight;
    },
    errorFor: (path) => errorOf(state, path),
    messagesFor: (path) => messagesOf(state, path),
    reset: () => {
      publish(IDLE_FORM_STATE);
    },
  };
}
