// `listParamsSchema` admits the whitelist and the arguments the query cannot run without — never
// an optional input key the whitelist left out, which a list call would otherwise smuggle past
// `describe_resource`'s promise that nothing else is admitted.

import { describe, expect, test } from 'bun:test';
import { listParamsSchema } from './list-params';
import { validateArgs } from './validate-args';
import type { JsonSchema } from './wire';

const BASE: JsonSchema = {
  type: 'object',
  properties: {
    projectId: { type: 'string' },
    status_eq: { type: 'string' },
    status_in: { type: 'array', items: { type: 'string' } },
    includeDeleted: { type: 'boolean' },
    sort: { type: 'string' },
    cursor: { type: 'string' },
    limit: { type: 'integer' },
  },
  required: ['projectId'],
  additionalProperties: false,
};

const schema = listParamsSchema({ filters: { status: ['_eq'] }, sort: ['createdAt'] }, BASE);

describe('listParamsSchema', () => {
  test('an optional input key outside the whitelist is refused', () => {
    for (const extra of [{ includeDeleted: true }, { status_in: ['draft'] }]) {
      const result = validateArgs(schema, { projectId: 'p1', ...extra });
      expect(result.ok).toBe(false);
    }
  });

  test('the whitelist and the required arguments are admitted, narrowed', () => {
    expect(
      validateArgs(schema, { projectId: 'p1', status_eq: 'draft', sort: '-createdAt', limit: 5 })
        .ok,
    ).toBe(true);
    // Narrowed to the whitelist, not the input's wider `t.string`.
    expect(validateArgs(schema, { projectId: 'p1', sort: 'title' }).ok).toBe(false);
    // Required stays required.
    expect(validateArgs(schema, { status_eq: 'draft' }).ok).toBe(false);
  });

  test('the published properties are exactly the whitelist plus the required keys', () => {
    expect(Object.keys(schema.properties ?? {}).sort()).toEqual(
      ['cursor', 'limit', 'projectId', 'sort', 'status_eq'].sort(),
    );
    expect(schema.required).toEqual(['projectId']);
  });

  test('a required key named __proto__ lands as a key, never as a prototype', () => {
    const odd = listParamsSchema(
      {},
      {
        type: 'object',
        properties: JSON.parse('{"__proto__":{"type":"string"}}') as Record<string, JsonSchema>,
        required: ['__proto__'],
      },
    );
    expect(Object.hasOwn(odd.properties ?? {}, '__proto__')).toBe(true);
  });
});
