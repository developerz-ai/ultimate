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
  firstInvalidField,
  IDLE_FORM_STATE,
  messagesOf,
  NO_FORM_ERRORS,
} from './form-state';
import {
  type FormTouch,
  markDirty,
  markTouched,
  NO_FORM_TOUCH,
  sameFieldValue,
} from './form-touch';

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
  /**
   * The values the form OPENED with, keyed by the same field paths — what `edit()` compares
   * against to decide dirtiness. A create form passes nothing, and every non-blank value is then a
   * change. A path missing from this map has a baseline of `undefined`, which `sameFieldValue`
   * treats as equal to an empty control.
   *
   * The baseline is fixed for the life of the binding: a form that stays mounted after a save and
   * wants the saved values as its new baseline builds a new binding, because this one never sees
   * what the user typed and cannot invent one.
   */
  readonly initial?: Readonly<Record<string, unknown>> | undefined;
}

export interface FormBinding<TValues, TResult> {
  readonly state: () => FormState<TResult>;
  readonly submit: (values: TValues) => Promise<FormState<TResult>>;
  /** The message `Field`'s single error slot renders for one path. */
  readonly errorFor: (path: string) => string | undefined;
  /** Every message bound to one path, when a form renders more than one. */
  readonly messagesFor: (path: string) => readonly string[];
  /**
   * A submit is in flight. The one value that reaches BOTH the submit control (`<Button loading>`)
   * and the form (`<Form busy>`) — one derivation, so a control can be busy and its form not.
   */
  readonly pending: () => boolean;
  /**
   * The first declared field a failed submit put an error on. What `<Form invalidField>` focuses:
   * the thing that has to be fixed, rather than the summary that describes it.
   */
  readonly firstInvalidField: () => string | undefined;
  /** The user left a control. */
  readonly touch: (path: string) => void;
  /** The user changed a control. Dirtiness is decided against `initial`, never by the caller. */
  readonly edit: (path: string, value: unknown) => void;
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
  let touch: FormTouch = NO_FORM_TOUCH;
  let inFlight: Promise<FormState<TResult>> | null = null;

  /**
   * A transition names the submit's own members; `touched`/`dirty` are added here, from the one
   * place that owns them. Spelling the parameter as the whole `FormState` would let a transition
   * carry a stale pair — the exact drift `publishTouch` exists to prevent.
   */
  const publish = (next: Omit<FormState<TResult>, keyof FormTouch>): FormState<TResult> => {
    state = { ...next, touched: touch.touched, dirty: touch.dirty };
    options.onState?.(state);
    return state;
  };

  /**
   * The value this field opened with. `Object.hasOwn`, never the read alone: `initial` is the app's
   * own object, so `initial['constructor']` answers the `Object` FUNCTION where an absent key must
   * answer `undefined` — and that field would then read as permanently changed.
   */
  const baseline = (path: string): unknown => {
    const initial = options.initial;
    return initial !== undefined && Object.hasOwn(initial, path) ? initial[path] : undefined;
  };

  /** Progress through the form is not a transition, so it publishes without disturbing `status`. */
  const publishTouch = (next: FormTouch): void => {
    if (next === touch) return;
    touch = next;
    publish(state);
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
      // The server accepted what the form held, so there is nothing left to lose. `touched` stays:
      // the user has still visited those fields, and a hint that vanishes on save is a flicker.
      touch = { touched: touch.touched, dirty: NO_FORM_TOUCH.dirty };
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
    pending: () => state.status === 'submitting',
    firstInvalidField: () => firstInvalidField(state, fields),
    touch: (path) => publishTouch(markTouched(touch, path)),
    edit: (path, value) =>
      publishTouch(markDirty(touch, path, !sameFieldValue(value, baseline(path)))),
    reset: () => {
      touch = NO_FORM_TOUCH;
      publish(IDLE_FORM_STATE);
    },
  };
}
