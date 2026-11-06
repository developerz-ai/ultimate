// The OpenAPI compiler's refusals: a document that is not OpenAPI 3.0/3.1, and a construct it will
// not read, each naming the JSON pointer it stopped at. A construct is refused, never typed
// `unknown` in silence. Codes and titles are registered in `error-codes.ts`.
import { renderCauseValue, UltimateError } from '@ultimat3/core';

/** RFC 6901: `~` and `/` escaped, so a path key such as `/invoices/{id}` stays one segment. */
export const pointerJoin = (pointer: string, key: string | number): string =>
  `${pointer}/${String(key).replace(/~/g, '~0').replace(/\//g, '~1')}`;

/** `#/paths/~1invoices/get` for a reader: the pointer as written in the document. */
export class ClientSpecUnsupportedError extends UltimateError {
  constructor(input: { readonly pointer: string; readonly construct: string }) {
    super({
      code: 'X_CLIENT_SPEC_UNSUPPORTED',
      cause: `the document uses ${input.construct} at ${renderCauseValue(input.pointer)}, which the client compiler does not read`,
      fix: 'x help client --json   # then rerun with --only naming tags that leave that operation out, or pin a corrected source.json',
      meta: { pointer: input.pointer, construct: input.construct },
    });
  }
}

export class ClientSpecInvalidError extends UltimateError {
  constructor(input: { readonly source: string; readonly reason: string }) {
    super({
      code: 'X_CLIENT_SPEC_INVALID',
      cause: `${renderCauseValue(input.source)} is not an OpenAPI 3.0 or 3.1 document: ${input.reason}`,
      fix: 'x help client --json   # then point --from at the OpenAPI 3.0 or 3.1 document itself',
      meta: { source: input.source },
    });
  }
}

export const unsupported = (pointer: string, construct: string): ClientSpecUnsupportedError =>
  new ClientSpecUnsupportedError({ pointer, construct });

/** A plain JSON object, or `undefined` — the one narrowing every reader of the document uses. */
export function objectAt(value: unknown): Readonly<Record<string, unknown>> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : undefined;
}

/** `value[key]` for an OWN key only: a component named `constructor` is a name, not a prototype. */
export const own = (value: Readonly<Record<string, unknown>>, key: string): unknown =>
  Object.hasOwn(value, key) ? value[key] : undefined;
