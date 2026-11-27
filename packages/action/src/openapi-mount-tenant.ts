// A tenant mount's document: every operation takes the tenant as a required query parameter, says
// the 400 a call without one is answered and the 500 a failed lookup is, and the listing a caller
// learns its tenants from is a path of its own. Applied by `mountOpenApi` only when the mount
// declares `tenant`.

import { MAX_TENANT_VALUE } from '@ultimat3/http';
import {
  problem,
  RATE_LIMIT_HEADERS,
  RETRY_AFTER_HEADER,
  tooManyDescription,
} from './openapi-problem';

type Operation = Record<string, unknown>;
type Responses = Record<string, Record<string, unknown> | undefined>;

const TENANT_REQUIRED = 'X_BEARER_TENANT_REQUIRED — the call named no tenant';
const TENANT_UNRESOLVED = 'X_BEARER_TENANT_UNRESOLVED — the tenant lookup failed';

/** The values a call is resolved for: JSON Schema counts code points, as the mount does. */
const TENANT_VALUE_SCHEMA = { type: 'string', minLength: 1, maxLength: MAX_TENANT_VALUE };

/** The listing's operationId, as every document before this one named it: a client looks it up. */
export const TENANT_LISTING_OPERATION_ID = 'tenantsOfToken';
/**
 * Its id when a mounted primitive is already named `tenantsOfToken`. Kebab case on purpose: a
 * primitive's id is its export name, a JS identifier, which can never contain a hyphen.
 */
export const TENANT_LISTING_COLLIDED_ID = 'tenants-of-token';

/** The listing's id beside the mounted operations' `taken` ids: its own, unless one carries it. */
export const listingOperationId = (taken: ReadonlySet<unknown>): string =>
  taken.has(TENANT_LISTING_OPERATION_ID) ? TENANT_LISTING_COLLIDED_ID : TENANT_LISTING_OPERATION_ID;

/** `code` added to the operation's own response of that status, which keeps its words. */
const joined = (responses: Responses, status: string, description: string) => {
  const own = responses[status];
  return own === undefined
    ? problem(description)
    : { ...own, description: `${String(own['description'])}; or ${description}` };
};

/**
 * The operation with `arg` as a required `in: query` parameter, the 400 its absence is answered
 * and the 500 a failed lookup is. A read that already declares a query parameter of that name keeps
 * its own declaration, schema and all — its handler still validates the value — made required.
 */
export function withTenantParameter(operation: Operation, arg: string): Operation {
  const declared = Array.isArray(operation['parameters'])
    ? (operation['parameters'] as readonly Record<string, unknown>[])
    : [];
  const isTenant = (parameter: Record<string, unknown>) =>
    parameter['in'] === 'query' && parameter['name'] === arg;
  const own = declared.find(isTenant);
  const responses = operation['responses'] as Responses;
  return {
    ...operation,
    parameters: [
      own === undefined
        ? {
            name: arg,
            in: 'query',
            required: true,
            description: 'The tenant this call acts in: a value from the tenants listing.',
            schema: TENANT_VALUE_SCHEMA,
          }
        : { ...own, required: true },
      ...declared.filter((parameter) => !isTenant(parameter)),
    ],
    responses: {
      ...responses,
      // The operation's own 400 (an action's `X_INPUT_INVALID`) keeps its words, and gains these.
      '400': joined(responses, '400', TENANT_REQUIRED),
      '500': joined(responses, '500', TENANT_UNRESOLVED),
    },
  };
}

/**
 * `GET <prefix>/tenants`: the tenants the token's person may name, any valid token, no tenant. Its
 * authenticator spends the mount's per-token allowance like every mounted route, so it documents
 * the same 401 challenge and 429, and with an allowance of its own the `RateLimit-*` every answer
 * carries.
 */
export function tenantsOperation(
  scheme: string,
  ownAllowance: boolean,
  operationId: string,
): Operation {
  return {
    operationId,
    summary: 'The tenants this token may act in',
    security: [{ [scheme]: [] }],
    responses: {
      '200': {
        description: 'Each value is what a call sends as the tenant query parameter.',
        ...(ownAllowance ? { headers: RATE_LIMIT_HEADERS } : {}),
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
                    properties: { value: TENANT_VALUE_SCHEMA, name: { type: 'string' } },
                  },
                },
              },
            },
          },
        },
      },
      '401': problem('X_UNAUTHENTICATED — no credential, or one that did not resolve', {
        'WWW-Authenticate': { description: 'Bearer', schema: { type: 'string' } },
      }),
      '429': problem(
        tooManyDescription(true, false),
        ownAllowance ? { ...RETRY_AFTER_HEADER, ...RATE_LIMIT_HEADERS } : RETRY_AFTER_HEADER,
      ),
      '500': problem(
        'X_BEARER_TENANT_LIST_INVALID — the listing named a value no call could send back',
      ),
    },
  };
}
