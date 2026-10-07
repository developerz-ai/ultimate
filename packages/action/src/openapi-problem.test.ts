import { beforeEach, describe, expect, test } from 'bun:test';
import { registerErrorStatus, registerProblemMeta, toProblem } from '@ultimat3/http';
import { InputInvalidError } from './errors';
import type { JsonSchemaObject } from './json-schema';
import { buildOpenApi } from './openapi';
import { resetActions } from './registry';

/** The published `Problem`, as a reader of `openapi.json` sees it. */
function problemSchema(): { properties: Record<string, JsonSchemaObject>; required: string[] } {
  const schema = buildOpenApi().components.schemas['Problem'] as unknown as {
    properties: Record<string, JsonSchemaObject>;
    required: string[];
  };
  return schema;
}

/** What actually crosses the wire: `undefined` members are dropped by the serializer. */
function wire(error: unknown): Record<string, unknown> {
  const document = toProblem(error, { instance: '/api/posts/publish', requestId: 'req_1' });
  return JSON.parse(JSON.stringify(document)) as Record<string, unknown>;
}

const ISSUE = { path: 'input.postId', expected: 'uuid', received: 'string', message: 'not a uuid' };

describe('the published Problem schema against the document @ultimat3/http serves', () => {
  beforeEach(() => {
    resetActions();
  });

  test('every member of a served X_INPUT_INVALID document is a declared property', () => {
    const served = wire(new InputInvalidError('publishPost', 'input.postId: not a uuid', [ISSUE]));
    // `received` is blanked on the way out; the member and its four keys are what the schema owes.
    expect(Object.keys((served['issues'] as object[])[0] ?? {}).sort()).toEqual(
      Object.keys(ISSUE).sort(),
    );
    const declared = Object.keys(problemSchema().properties);
    for (const member of Object.keys(served)) expect(declared).toContain(member);
  });

  test('an app code that declared wire meta is served a member the schema lists', () => {
    registerErrorStatus({ X_APP_OPENAPI_PROBLEM_BUSY: 409 });
    registerProblemMeta({ X_APP_OPENAPI_PROBLEM_BUSY: ['sessionId'] });
    const served = wire({ code: 'X_APP_OPENAPI_PROBLEM_BUSY', meta: { sessionId: 's_1' } });
    expect(served['meta']).toEqual({ sessionId: 's_1' });
    expect(problemSchema().properties['meta']).toEqual({ type: 'object' });
  });

  test('issues is typed as the four members a ValidationIssue carries', () => {
    const issues = problemSchema().properties['issues'] as unknown as {
      type: string;
      items: { required: string[]; properties: Record<string, unknown> };
    };
    expect(issues.type).toBe('array');
    expect([...issues.items.required].sort()).toEqual(Object.keys(ISSUE).sort());
    expect(Object.keys(issues.items.properties).sort()).toEqual(Object.keys(ISSUE).sort());
  });

  test('a code the framework did not mint still satisfies the published `code`', () => {
    const served = wire({ code: 'E_UPSTREAM', message: 'boom' });
    expect(served['code']).toBe('E_UPSTREAM');
    const pattern = (problemSchema().properties['code'] as { pattern?: string }).pattern;
    if (pattern !== undefined) expect(new RegExp(pattern).test('E_UPSTREAM')).toBe(true);
  });

  test('every required member is on every served document', () => {
    const served = wire(new TypeError('boom'));
    for (const member of problemSchema().required) expect(served).toHaveProperty(member);
  });
});
