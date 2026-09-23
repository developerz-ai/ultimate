/**
 * The ONE OpenAPI description of the records envelope, for every operation that answers one —
 * `@ultimat3/action`'s and `@ultimat3/query`'s projections both build their 200 from it. The rule
 * it serves: an operation decides ONCE, from its schema, whether it answers `{ data, records }`,
 * so each operation has exactly one body shape and one header, never a `oneOf` over "sometimes".
 */

import { RECORDS_HEADER } from './record-envelope';

/** The 200 body: the operation's own answer under `data`, the rows it carried beside it. */
export function recordEnvelopeSchema(
  data: Readonly<Record<string, unknown>>,
): Record<string, unknown> {
  return {
    type: 'object',
    required: ['data', 'records'],
    properties: {
      data,
      records: {
        type: 'object',
        description:
          'Entity rows in `data`, keyed by record type and then by record key, for the client record store. May be empty.',
        additionalProperties: { type: 'object', additionalProperties: { type: 'object' } },
      },
      removed: {
        type: 'object',
        description: 'Record keys the client store must drop, keyed by record type.',
        additionalProperties: { type: 'array', items: { type: 'string' } },
      },
    },
  };
}

/** The header beside that body. Always `1` on an operation that answers the envelope at all. */
export const RECORDS_OPENAPI_HEADER: Readonly<Record<string, unknown>> = Object.freeze({
  [RECORDS_HEADER]: {
    description: 'Always `1`: the body is a record envelope and the operation answer is `data`.',
    required: true,
    schema: { type: 'string', enum: ['1'] },
  },
});
