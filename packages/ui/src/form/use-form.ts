// The reactive shell over `createFormBinding`, and the whole of what it adds: the state lands in a
// signal, so a `<Field error={form.errorFor('title')}>` re-renders when a submit answers.
//
// Reactivity goes through `solid()` like every other read in this package — a component that
// imported solid-js directly would make @ultimat3/ui depend on a runtime it deliberately does not.

import { solid } from '../theme/solid-adapter';
import { createFormBinding, type FormBinding, type FormBindingOptions } from './form-binding';
import { errorOf, type FormState, IDLE_FORM_STATE, messagesOf } from './form-state';

/**
 * Call it in a component body. On the server there is no registered runtime and the inert one
 * answers: the state holds, no effect runs, and the form renders in its idle state — which is what
 * a form that nobody has submitted yet IS.
 */
export function useForm<TValues, TResult>(
  options: FormBindingOptions<TValues, TResult>,
): FormBinding<TValues, TResult> {
  const runtime = solid();
  const [state, setState] = runtime.createSignal<FormState<TResult>>(IDLE_FORM_STATE);
  const binding = createFormBinding<TValues, TResult>({
    ...options,
    onState: (next) => {
      options.onState?.(next);
      setState(next);
    },
  });

  // Re-derived from the SIGNAL, never from the binding's own snapshot: `binding.errorFor` reads a
  // closed-over variable, which is a value a reactive scope cannot subscribe to — a form bound to
  // it would show the first answer forever.
  return {
    ...binding,
    state,
    errorFor: (path) => errorOf(state(), path),
    messagesFor: (path) => messagesOf(state(), path),
  };
}
