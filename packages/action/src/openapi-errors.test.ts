// An action's declared refusals in `openapi.json`: an undeclared operation keeps today's bytes, a
// declared one names each code at its status, narrowed to the code's Problem `type`.

import { beforeEach, describe, expect, test } from 'bun:test';
import { defineError } from '@ultimat3/core';
import { can } from '@ultimat3/policy';
import { t } from '@ultimat3/schema';
import { action } from './action';
import { buildOpenApi, serializeOpenApi } from './openapi';
import { registerActions, resetActions } from './registry';

const Input = t.object({ postId: t.uuid });
const Output = t.object({ id: t.uuid });
const POST_ID = '00000000-0000-4000-8000-0000000000aa';

// Declared once, at import, as an app's errors module is: a re-declaration is a no-op.
defineError({
  code: 'X_OPENAPI_POST_MISSING',
  title: 'openapi-errors fixture: no such post',
  status: 404,
  cause: 'a fixture',
  fix: 'nothing: a fixture',
});
defineError({
  code: 'X_OPENAPI_POST_LOCKED',
  title: 'openapi-errors fixture: the post is locked',
  status: 409,
  cause: 'a fixture',
  fix: 'nothing: a fixture',
});

beforeEach(() => {
  resetActions();
});

const define = (errors?: readonly string[], idempotent = false) =>
  action({
    input: Input,
    output: Output,
    policy: can('post:publish'),
    idempotent,
    ...(errors === undefined ? {} : { errors }),
    handle: () => ({ id: POST_ID }),
  });

const responsesOf = (): Record<string, Record<string, unknown>> => {
  const operation = buildOpenApi().paths['/api/posts/publish'] as {
    post: { responses: Record<string, Record<string, unknown>> };
  };
  return operation.post.responses;
};

describe('declared errors in the OpenAPI operation', () => {
  test('undeclared and `errors: []` serialize to the same bytes, today’s four statuses', () => {
    registerActions({ publishPost: define() });
    const undeclared = serializeOpenApi(buildOpenApi());
    expect(Object.keys(responsesOf()).sort()).toEqual(['200', '400', '403', '422']);
    resetActions();
    registerActions({ publishPost: define([]) });
    expect(serializeOpenApi(buildOpenApi())).toBe(undeclared);
  });

  test('a declared code adds its status, narrowed to its Problem type', () => {
    registerActions({ publishPost: define(['X_OPENAPI_POST_MISSING']) });
    const missing = responsesOf()['404'];
    expect(missing?.['x-ultimate-errors']).toEqual(['X_OPENAPI_POST_MISSING']);
    expect(JSON.stringify(missing)).toContain(
      '"enum":["urn:ultimate:error:X_OPENAPI_POST_MISSING"]',
    );
  });

  test('a code at a status the framework answers joins it, the open Problem kept', () => {
    registerActions({ publishPost: define(['X_OPENAPI_POST_LOCKED'], true) });
    const conflict = responsesOf()['409'];
    expect(conflict?.['description']).toBe('X_IDEMPOTENCY_CONFLICT | X_OPENAPI_POST_LOCKED');
    expect(JSON.stringify(conflict)).not.toContain('enum');
  });

  test('the bytes stay stable whatever order the list was written in', () => {
    registerActions({ publishPost: define(['X_OPENAPI_POST_MISSING', 'X_OPENAPI_POST_LOCKED']) });
    const forward = serializeOpenApi(buildOpenApi());
    resetActions();
    registerActions({ publishPost: define(['X_OPENAPI_POST_LOCKED', 'X_OPENAPI_POST_MISSING']) });
    expect(serializeOpenApi(buildOpenApi())).toBe(forward);
  });
});
