// Single responsibility: an operation's `responses` with its declared `errors:` in them — one entry
// per status, the Problem narrowed to the declared `type`s. Shared by `@ultimat3/action`'s and
// `@ultimat3/query`'s documents (one tier, no sideways import); `@ultimat3/http`'s status reader
// and `problemTypeFor` are passed in, being a tier above this package.

import type { ErrorStatusOf } from './declared-errors';

export interface DeclaredResponsesWire {
  readonly statusOf: ErrorStatusOf;
  /** `problemTypeFor`: the `type` a Problem document carries for a code. */
  readonly typeFor: (code: string) => string;
  /** The `$ref` of the document's `Problem` schema. */
  readonly problemRef: string;
}

/** The extension naming the declared codes a response may carry, in every case machine-readable. */
export const DECLARED_ERRORS_EXTENSION = 'x-ultimate-errors';

const descriptionOf = (held: unknown): string | undefined => {
  if (typeof held !== 'object' || held === null) return undefined;
  const description = (held as { readonly description?: unknown }).description;
  return typeof description === 'string' ? description : undefined;
};

/**
 * `responses`, member for member, when nothing is declared — an undeclared operation's bytes
 * are today's. Each declared code joins the entry for its status, codes sorted. A status the
 * framework already answers keeps its open `Problem` (it may carry codes no list names — a
 * policy's denial, `X_INPUT_INVALID`) and gains the codes in its description and extension; a
 * status only the list answers narrows `type` to an enum of exactly those codes.
 */
export function withDeclaredResponses(
  responses: Readonly<Record<string, unknown>>,
  declared: readonly string[] | undefined,
  wire: DeclaredResponsesWire,
): Record<string, unknown> {
  if (declared === undefined || declared.length === 0) return { ...responses };
  const byStatus = new Map<string, string[]>();
  for (const code of [...declared].sort()) {
    const status = String(wire.statusOf(code));
    byStatus.set(status, [...(byStatus.get(status) ?? []), code]);
  }
  const merged: Record<string, unknown> = { ...responses };
  for (const [status, codes] of byStatus) {
    const held = responses[status];
    const listed = codes.join(' | ');
    merged[status] =
      held === undefined
        ? {
            description: listed,
            content: {
              'application/problem+json': {
                schema: {
                  allOf: [
                    { $ref: wire.problemRef },
                    { properties: { type: { enum: codes.map(wire.typeFor) } } },
                  ],
                },
              },
            },
            [DECLARED_ERRORS_EXTENSION]: codes,
          }
        : {
            ...(held as Record<string, unknown>),
            description: `${descriptionOf(held) ?? status} | ${listed}`,
            [DECLARED_ERRORS_EXTENSION]: codes,
          };
  }
  return merged;
}
