// The identity of a command or agent file an earlier release wrote: hashed with the app's name
// swapped for a fixed one, because the templates spell `mcp__<app>__*` into the text. The refresh
// script and the `agent-kit` codemod share this one function, so a form hashed there matches here.

import { guardFormHash } from './guards-vendored';

/** A valid kebab name no app picks: the template is rendered with it, and an app's text maps to it. */
export const KIT_FORM_NAME = 'zz-kit-form-zz';

/** `file`'s hash with the app's `kebab` read as `KIT_FORM_NAME`. */
export const kitFormHash = (text: string, kebab: string): string =>
  guardFormHash(kebab === '' ? text : text.replaceAll(kebab, KIT_FORM_NAME));

/** True when `text` is one of `known` for some name the app could have been scaffolded under. */
export const isReleasedKitForm = (
  text: string,
  names: readonly string[],
  known: readonly string[] | undefined,
): boolean => known !== undefined && names.some((name) => known.includes(kitFormHash(text, name)));
