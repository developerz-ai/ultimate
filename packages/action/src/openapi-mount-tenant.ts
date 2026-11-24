// A tenant mount's document: every operation takes the tenant as a required query parameter, says
// the 400 a call without one is answered, and the listing a caller learns its tenants from is a
// path of its own. Applied by `mountOpenApi` only when the mount declares `tenant`.

import { PROBLEM_SCHEMA_NAME, schemaRef } from './naming';

type Operation = Record<string, unknown>;

const TENANT_REQUIRED = 'X_BEARER_TENANT_REQUIRED — the call named no tenant';

const problem = (description: string) => ({
  description,
  content: { 'application/problem+json': { schema: { $ref: schemaRef(PROBLEM_SCHEMA_NAME) } } },
});

/**
 * The operation with `arg` as a required `in: query` parameter — replacing a read's own parameter
 * of that name, which then carries the tenant's value — and the 400 its absence is answered.
 */
export function withTenantParameter(operation: Operation, arg: string): Operation {
  const declared = Array.isArray(operation['parameters'])
    ? (operation['parameters'] as readonly Record<string, unknown>[])
    : [];
  const others = declared.filter(
    (parameter) => !(parameter['in'] === 'query' && parameter['name'] === arg),
  );
  const responses = operation['responses'] as Record<string, Record<string, unknown> | undefined>;
  const invalid = responses['400'];
  return {
    ...operation,
    parameters: [
      {
        name: arg,
        in: 'query',
        required: true,
        description: 'The tenant this call acts in: a value from the tenants listing.',
        schema: { type: 'string' },
      },
      ...others,
    ],
    responses: {
      ...responses,
      // The operation's own 400 (an action's `X_INPUT_INVALID`) keeps its words, and gains these.
      '400':
        invalid === undefined
          ? problem(TENANT_REQUIRED)
          : { ...invalid, description: `${String(invalid['description'])}; or ${TENANT_REQUIRED}` },
    },
  };
}

/** `GET <prefix>/tenants`: the tenants the token's person may name, any valid token, no tenant. */
export function tenantsOperation(scheme: string): Operation {
  return {
    operationId: 'tenantsOfToken',
    summary: 'The tenants this token may act in',
    security: [{ [scheme]: [] }],
    responses: {
      '200': {
        description: 'Each value is what a call sends as the tenant query parameter.',
        content: {
          'application/json': {
            schema: {
              type: 'object',
              required: ['tenants'],
              properties: {
                tenants: {
                  type: 'array',
                  items: {
                    type: 'object',
                    required: ['value'],
                    properties: { value: { type: 'string' }, name: { type: 'string' } },
                  },
                },
              },
            },
          },
        },
      },
      '401': problem('X_UNAUTHENTICATED — no credential, or one that did not resolve'),
    },
  };
}
