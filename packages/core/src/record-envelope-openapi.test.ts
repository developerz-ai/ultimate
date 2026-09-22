import { describe, expect, test } from 'bun:test';
import { encodeRecordEnvelope, RECORDS_HEADER } from './record-envelope';
import { RECORDS_OPENAPI_HEADER, recordEnvelopeSchema } from './record-envelope-openapi';

describe('recordEnvelopeSchema', () => {
  test('requires exactly the members encodeRecordEnvelope always writes', () => {
    const schema = recordEnvelopeSchema({ type: 'object' });
    const written = Object.keys(encodeRecordEnvelope({ ok: true }, {}));
    expect(schema['required']).toEqual(written);
  });

  test('carries the operation answer under data, verbatim', () => {
    const data = { $ref: '#/components/schemas/PostOutput' };
    const properties = recordEnvelopeSchema(data)['properties'] as Record<string, unknown>;
    expect(properties['data']).toBe(data);
  });

  test('declares the one header, required, always 1', () => {
    expect(Object.keys(RECORDS_OPENAPI_HEADER)).toEqual([RECORDS_HEADER]);
    expect(RECORDS_OPENAPI_HEADER[RECORDS_HEADER]).toMatchObject({
      required: true,
      schema: { enum: ['1'] },
    });
  });
});
