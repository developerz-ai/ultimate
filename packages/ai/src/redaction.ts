// The one gate between `vars()` and the provider: a `Secret` never reaches a prompt.
//
// Not a leak check — `Secret` redacts by value, so the string would have arrived as `[redacted]`.
// It is a CORRECTNESS check, and the same one `render()` already makes for an unfilled `{{slot}}`:
// a prompt that reads fine and means something else is the failure nobody sees, and here it is
// also a token bill for an answer about a placeholder.

import { isSecret } from '@ultimat3/core';
import { AiPromptSecretError } from './errors';

/**
 * Refuse a `Secret` among a prompt's variables, naming every key that carries one. Runs whether
 * or not an app installed a redactor: the redactor is the app's policy, this is the framework's
 * invariant, and an invariant that only holds when something optional is configured is not one.
 *
 * Structural (`isSecret` reads the shared brand), so two copies of `@ultimat3/core` in one tree
 * still recognise each other's secrets.
 */
export function assertNoSecrets(ref: string, vars: Readonly<Record<string, unknown>>): void {
  const keys = Object.keys(vars).filter((key) => isSecret(vars[key]));
  if (keys.length > 0) throw new AiPromptSecretError({ ref, keys: keys.sort() });
}
