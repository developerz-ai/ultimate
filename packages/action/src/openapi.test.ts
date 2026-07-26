import { beforeEach, describe, expect, test } from 'bun:test';
import { can } from '@ultimat3/policy';
import { t } from '@ultimat3/schema';
import { action } from './action';
import { buildOpenApi, serializeOpenApi } from './openapi';
import { registerActions, resetRegistry } from './registry';

const Input = t.object({ postId: t.uuid });
const Output = t.object({ id: t.uuid, published: t.boolean });
const POST_ID = '00000000-0000-4000-8000-0000000000aa';

const define = (idempotent: boolean) =>
  action({
    input: Input,
    output: Output,
    policy: can('post:publish'),
    idempotent,
    handle: () => ({ id: POST_ID, published: true }),
  });

describe('openapi', () => {
  beforeEach(() => {
    resetRegistry();
  });

  test('same registry twice produces an identical string', () => {
    registerActions({ publishPost: define(true), archivePost: define(false) });
    const first = serializeOpenApi(buildOpenApi({ title: 'Test', version: '1.0.0' }));
    const second = serializeOpenApi(buildOpenApi({ title: 'Test', version: '1.0.0' }));
    expect(first).toBe(second);
  });

  test('declaration order does not change the bytes', () => {
    registerActions({ publishPost: define(true), archivePost: define(false) });
    const forward = serializeOpenApi(buildOpenApi());
    resetRegistry();
    registerActions({ archivePost: define(false), publishPost: define(true) });
    const reverse = serializeOpenApi(buildOpenApi());
    expect(reverse).toBe(forward);
  });

  test('every action contributes a path, components and a tag', () => {
    registerActions({ publishPost: define(true) });
    const document = buildOpenApi();
    expect(Object.keys(document.paths)).toEqual(['/api/posts/publish']);
    expect(document.components.schemas['PublishPostInput']).toBeDefined();
    expect(document.components.schemas['Problem']).toBeDefined();
    expect(document.tags).toEqual([{ name: 'posts' }]);
    const operation = document.paths['/api/posts/publish'] as {
      post: { parameters: readonly { name: string }[] };
    };
    expect(operation.post.parameters[0]?.name).toBe('Idempotency-Key');
  });
});
