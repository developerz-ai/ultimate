// Single responsibility: what `etag: true` adds to a read's OpenAPI operation — the `If-None-Match`
// header parameter, the `ETag` on the 200, and the bodiless 304. Applied after the operation is
// built, so the list and single operations stay one description each.

const IF_NONE_MATCH = {
  name: 'If-None-Match',
  in: 'header',
  required: false,
  description: 'The ETag of an answer this caller already holds; a match is 304 with no body.',
  schema: { type: 'string' },
} as const;

const ETAG_HEADER = {
  ETag: {
    description: 'A strong validator of this answer, for this caller. Send it as If-None-Match.',
    schema: { type: 'string' },
  },
} as const;

type Operation = Readonly<Record<string, unknown>>;

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** `operation` documenting its validator. An operation with no 200 is returned unchanged. */
export function withValidatorDoc(operation: Operation): Operation {
  const responses = operation['responses'];
  const parameters = operation['parameters'];
  if (!isRecord(responses) || !Array.isArray(parameters)) return operation;
  const ok = responses['200'];
  if (!isRecord(ok)) return operation;
  const headers = isRecord(ok['headers']) ? ok['headers'] : {};
  return {
    ...operation,
    // Last, after the page controls: a header is not one of the read's input members.
    parameters: [...parameters, IF_NONE_MATCH],
    responses: {
      ...responses,
      '200': { ...ok, headers: { ...headers, ...ETAG_HEADER } },
      '304': { description: 'not modified — the If-None-Match validator still names this answer' },
    },
  };
}
