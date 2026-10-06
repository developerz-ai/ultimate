// The X_AI_CONTENT_UNSUPPORTED class, apart from ./errors because that catalogue is at its ceiling —
// the split `hive-errors.ts` and `eval-errors.ts` made. Its code and title are registered in
// ./errors with the rest: one owner, one registration, one place a duplicate can surface.

import { UltimateError } from '@ultimat3/core';

/** Where a block was refused: a capability of the WIRE format, or of the model's own row. */
export type ContentRefusal =
  | { readonly by: 'model'; readonly model: string; readonly provider: string }
  | {
      readonly by: 'provider';
      readonly model: string;
      readonly provider: string;
      /** What the wire format lacks — and, in `fix`, the block this provider DOES take instead. */
      readonly why: string;
      readonly fix: string;
    }
  | {
      readonly by: 'role';
      readonly model: string;
      readonly provider: string;
      readonly role: string;
    };

/**
 * A message carries an image or document block the target cannot take. Refused before the request
 * leaves, because the alternative is a 400 whose message names a JSON path, not the fix — or, on
 * the endpoints that skip what they cannot parse, an answer about a document the model never saw.
 *
 * Never collected into `X_AI_PROVIDER_UNAVAILABLE`: the same blocks get the same refusal from
 * every provider serving that model, so retrying burns attempts and discards this fix line.
 */
export class AiContentUnsupportedError extends UltimateError {
  constructor(input: {
    readonly kind: string;
    readonly at: string;
    readonly refusal: ContentRefusal;
  }) {
    const { kind, at, refusal } = input;
    super({
      code: 'X_AI_CONTENT_UNSUPPORTED',
      cause: `${at} is a ${kind} block, and ${causeOf(kind, refusal)}`,
      fix: fixOf(kind, refusal),
      meta: { kind, at, by: refusal.by, model: refusal.model, provider: refusal.provider },
    });
  }
}

function causeOf(kind: string, refusal: ContentRefusal): string {
  if (refusal.by === 'model') {
    return `model "${refusal.model}" is registered without '${kind}' in its input list`;
  }
  if (refusal.by === 'role') {
    return `a ${kind} block may only travel in a user turn, not a ${refusal.role} turn (provider "${refusal.provider}", model "${refusal.model}")`;
  }
  return `provider "${refusal.provider}" cannot send it to model "${refusal.model}": ${refusal.why}`;
}

function fixOf(kind: string, refusal: ContentRefusal): string {
  if (refusal.by === 'model') {
    return `registerModel({ ...modelSpec('${refusal.model}'), input: ['image', 'document'] })   # if its endpoint accepts ${kind}s; or route the request to a model that does`;
  }
  if (refusal.by === 'role') {
    return `{ role: 'user', content: [/* the ${kind} block */] }   # move the block out of the ${refusal.role} turn`;
  }
  return refusal.fix;
}
