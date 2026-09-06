// `openapi.json` carries BOTH halves of the API: the actions `@ultimat3/action` projects and the
// reads `@ultimat3/query` projects, merged here because the two packages are one tier. Until
// 2026-09 the file had only the actions, and every `GET /_x/query/<name>` the server mounted was
// a route the spec had never heard of.

import { afterEach, describe, expect, test } from 'bun:test';
import { can } from '@ultimat3/policy';
import { from, query, registerQuery, resetRegistry } from '@ultimat3/query';
import { t } from '@ultimat3/schema';
import { openApiJson } from './app-openapi';

const manifest = {
  app: { name: 'fixture', version: '1.2.3' },
} as Parameters<typeof openApiJson>[0];

describe('openApiJson', () => {
  afterEach(() => resetRegistry());

  test('a registered read is a GET path with the page controls, beside the actions', () => {
    registerQuery(
      'orgFeed',
      query({
        input: t.object({ orgId: t.uuid }),
        policy: can('feed:read'),
        sql: () => from<{ id: string }>('posts', []).orderBy('id'),
      }),
    );
    const document = JSON.parse(openApiJson(manifest)) as {
      paths: Record<string, { get?: { parameters: readonly { name: string }[] } }>;
      components: { schemas: Record<string, unknown> };
    };
    const operation = document.paths['/_x/query/org-feed']?.get;
    expect(operation?.parameters.map((p) => p.name)).toEqual(['orgId', '_first', '_after']);
    // The `$ref` the read's refusals point at is a component the action side puts in the document.
    expect(document.components.schemas['Problem']).toBeDefined();
  });

  test('the same registry twice is the same bytes', () => {
    expect(openApiJson(manifest)).toBe(openApiJson(manifest));
  });
});
