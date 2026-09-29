// `openapi.json` carries BOTH halves of the API: the actions `@ultimat3/action` projects and the
// reads `@ultimat3/query` projects, merged here because the two packages are one tier. Until
// 2026-09 the file had only the actions, and every `GET /_x/query/<name>` the server mounted was
// a route the spec had never heard of.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { rm } from 'node:fs/promises'; // why: Bun has no recursive remove.
import { tmpdir } from 'node:os'; // why: Bun exposes no tmpdir().
import { join } from 'node:path'; // why: Bun exposes no path-join primitive.
import { action, defineApi, resetRegistry as resetActions } from '@ultimat3/action';
import { can } from '@ultimat3/policy';
import { from, query, registerQuery, resetRegistry } from '@ultimat3/query';
import { t } from '@ultimat3/schema';
import { openApiArtifacts, openApiJson, openApiStaleness } from './app-openapi';

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

describe('the complete document and a mount document', () => {
  // Before as well as after: `declare()` switches the path style, which refuses any path an EARLIER
  // file handed out by name and never reset (`X_ACTION_PATH_DERIVED_EARLY`) — this block's premise
  // is a registry holding only what it declares, whatever ran before it in the process.
  beforeEach(() => {
    resetRegistry();
    resetActions();
  });
  afterEach(() => {
    resetRegistry();
    resetActions();
  });

  const declare = (openapi?: { title: string; version: string }) =>
    defineApi({
      actions: {
        createCase: action({
          input: t.object({ title: t.string }),
          output: t.object({ ok: t.boolean }),
          policy: can('cases:create'),
          handle: () => ({ ok: true }),
        }),
      },
      http: {
        pathStyle: 'readable',
        mounts: [
          {
            prefix: '/v1',
            scopes: { 'cases:write': ['createCase'] },
            resolveToken: () => null,
            openapi: 'openapi.v1.json',
          },
        ],
      },
      ...(openapi === undefined ? {} : { openapi }),
    });

  test('without an openapi block the bytes are the shape they always were', () => {
    declare();
    const document = JSON.parse(openApiJson(manifest)) as Record<string, unknown>;
    expect(document['info']).toEqual({ title: 'fixture', version: '1.2.3' });
    expect(document['servers']).toBeUndefined();
    expect((document['components'] as Record<string, unknown>)['securitySchemes']).toBeUndefined();
  });

  test('declared, openapi.json is complete and openapi.v1.json holds only the cut', () => {
    declare({ title: 'Notificado API', version: '1.0.0' });
    const [main, v1] = openApiArtifacts(manifest);
    expect(main?.file).toBe('openapi.json');
    expect(v1?.file).toBe('openapi.v1.json');
    const mainDoc = JSON.parse(main?.text ?? '{}') as {
      info: unknown;
      paths: Record<string, { post: { responses: Record<string, unknown> } }>;
    };
    expect(mainDoc.info).toEqual({ title: 'Notificado API', version: '1.0.0' });
    expect(Object.keys(mainDoc.paths['/api/create-case']?.post.responses ?? {})).toContain('401');
    const v1Doc = JSON.parse(v1?.text ?? '{}') as { paths: Record<string, unknown> };
    expect(Object.keys(v1Doc.paths)).toEqual(['/v1/create-case']);
  });

  test('openapi.v1.json secures each operation with the scope the mount maps it to', () => {
    declare({ title: 'Notificado API', version: '1.0.0' });
    const v1 = openApiArtifacts(manifest).find((artifact) => artifact.file === 'openapi.v1.json');
    const v1Doc = JSON.parse(v1?.text ?? '{}') as {
      paths: Record<string, { post?: { security?: unknown } }>;
      components: { securitySchemes: Record<string, { 'x-ultimate'?: unknown }> };
    };
    expect(v1Doc.paths['/v1/create-case']?.post?.security).toEqual([{ bearer: ['cases:write'] }]);
    expect(v1Doc.components.securitySchemes['bearer']?.['x-ultimate']).toEqual({
      scopes: { 'cases:write': ['createCase'] },
    });
  });

  test('a declared mount document that was never written is stale', async () => {
    declare({ title: 'Notificado API', version: '1.0.0' });
    const root = join(tmpdir(), `x-app-openapi-${process.pid}`);
    await rm(root, { recursive: true, force: true });
    try {
      await Bun.write(join(root, 'openapi.json'), openApiJson(manifest));
      const findings = await openApiStaleness(root, manifest);
      expect(findings.map((finding) => finding.at)).toEqual(['openapi.v1.json']);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
