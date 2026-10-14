// The ONE reader of a thrown value's stack: `.stack`, opening with its own `name: message` line.
// Bun 1.4 renders `.stack` lazily, and a full collection between the throw crossing an `await`
// and the first read leaves it opening with a bare `Error` (#773) — the frames survive, the
// header does not. The header is recomposed from the fields that did survive. Total: never throws.

import { stringField } from './error-render';

/** A stack's first line when it is a frame and not a header (`    at f (file:1:2)`). */
const FRAME_LINE = /^\s+at\s/;

/**
 * `value.stack`, with the header restored when the runtime dropped it. A stack that already opens
 * with the header — or that its author shaped some other way — is returned untouched.
 */
export function failureStack(value: unknown): string | undefined {
  const stack = stringField(value, 'stack');
  if (stack === undefined) return undefined;
  const name = stringField(value, 'name') ?? 'Error';
  const message = stringField(value, 'message') ?? '';
  const header = message === '' ? name : `${name}: ${message}`;
  if (stack.startsWith(header)) return stack;
  const newline = stack.indexOf('\n');
  const first = newline === -1 ? stack : stack.slice(0, newline);
  // The lost header is exactly the base constructor's name with no message after it.
  if (first === 'Error') return `${header}${newline === -1 ? '' : stack.slice(newline)}`;
  if (FRAME_LINE.test(first)) return `${header}\n${stack}`;
  return stack;
}
