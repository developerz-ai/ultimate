// The META surface's constant catalog and its `manage_resource` door, against the app in
// meta-surface-fixture.ts: the catalog never grows with the app, and `manage_resource` answers
// byte-for-byte what the flat `tools/call` answers. Split from meta-surface.test.ts (refusals).

import { describe, expect, test } from 'bun:test';
import { action } from '@ultimat3/action';
import { registerAction } from '@ultimat3/action/loader';
import { can } from '@ultimat3/policy';
import { t } from '@ultimat3/schema';
import { defineAppMcp } from './app-tools';
import { renderCatalog } from './meta-catalog-render';
import {
  appServer,
  bySurface,
  call,
  flatMember,
  flatOwner,
  GROUPS,
  inRequest,
  list,
  listedNames,
  manage,
  metaMember,
  metaOwner,
  publishedCount,
  refusedArgs,
  resultJson,
  resultText,
  useMetaSurfaceApp,
  whoami,
} from './meta-surface-fixture';
import type { McpCaller } from './registry';
import { mcpServer } from './server';
import { INVALID_REQUEST } from './wire';

useMetaSurfaceApp();

describe('meta surface — the constant catalog', () => {
  test('the default is flat and unchanged', async () => {
    const plain = defineAppMcp({ include: 'exposed', tools: [whoami] }).server;
    expect(listedNames(await plain.handle(list, metaOwner()))).toEqual([
      'listPosts',
      'publishPost',
      'transferOrg',
      'whoami',
    ]);
  });

  test('tools/list is the same size however many primitives are grouped', async () => {
    const small = appServer();
    for (let i = 0; i < 30; i += 1) {
      registerAction(
        `extra${i}`,
        action({
          input: t.object({}),
          output: t.object({}),
          policy: can('post:read'),
          mcp: { expose: true },
          handle: () => ({}),
        }),
      );
    }
    const extras = Array.from({ length: 30 }, (_, i) => `extra${i}`);
    const large = defineAppMcp({
      include: 'exposed',
      tools: [whoami],
      surface: bySurface,
      groups: { ...GROUPS, extras: { description: 'Many', tools: extras } },
    }).server;

    const expected = ['describe_resource', 'list_resources', 'manage_resource', 'whoami'];
    expect(listedNames(await small.handle(list, metaOwner()))).toEqual(expected);
    expect(listedNames(await large.handle(list, metaOwner()))).toEqual(expected);
    // The flat population on the same server still gets one tool per primitive.
    expect(listedNames(await large.handle(list, flatOwner())).length).toBe(34);
  });

  test('list_resources carries kind, a one-line param hint, scope and the confirmation hint', async () => {
    const tools = [
      ...defineAppMcp({ include: 'exposed' }).tools.map((tool) =>
        tool.name === 'publishPost' ? { ...tool, confirms: true } : tool,
      ),
    ];
    const server = mcpServer({
      tools,
      surface: 'meta',
      groups: GROUPS,
    });
    const text = resultText(await server.handle(call('list_resources'), metaOwner()));
    // The wire form is plain text, one line per action; the same facts as data via `catalog`.
    expect(text).toBe(renderCatalog(server.catalog(metaOwner()) ?? []));
    // Unscoped tools: nothing to hoist. `listPosts` is untagged — a query is the default.
    expect(text.split('\n').slice(1)).toEqual([
      '',
      'org — The organisation',
      '  transferOrg (action) {} — Transfer the org',
      '',
      'posts — Blog posts',
      '  listPosts {status_eq?: string|number|boolean, title_cont?: string, sort?: "createdAt"|"-createdAt", …} — Posts, filtered',
      '  publishPost (action; confirms) {postId: string} — Publish a draft post',
    ]);
    expect(server.catalog(metaOwner())).toEqual([
      {
        name: 'org',
        description: 'The organisation',
        actions: [
          { name: 'transferOrg', kind: 'action', description: 'Transfer the org', params: '' },
        ],
      },
      {
        name: 'posts',
        description: 'Blog posts',
        actions: [
          {
            name: 'listPosts',
            kind: 'query',
            description: 'Posts, filtered',
            params:
              'status_eq?: string|number|boolean, title_cont?: string, sort?: "createdAt"|"-createdAt", …',
          },
          {
            name: 'publishPost',
            kind: 'action',
            description: 'Publish a draft post',
            params: 'postId: string',
            confirms: true,
          },
        ],
      },
    ]);
  });

  test('describe_resource is batched and returns the full schemas', async () => {
    const response = await appServer().handle(
      call('describe_resource', { resources: ['posts', 'org', 'posts'] }),
      metaOwner(),
    );
    const described = resultJson(response)['resources'] as {
      name: string;
      actions: { name: string; inputSchema: { properties: Record<string, unknown> } }[];
    }[];
    expect(described.map((r) => r.name)).toEqual(['posts', 'org']);
    const listPosts = described[0]?.actions.find((a) => a.name === 'listPosts');
    expect(Object.keys(listPosts?.inputSchema.properties ?? {})).toEqual([
      'status_eq',
      'title_cont',
      'sort',
      'cursor',
      'limit',
    ]);
  });

  test("list_resources over a scoped app hoists each kind's shared scope onto the resource", async () => {
    const text = resultText(await appServer().handle(call('list_resources'), metaOwner()));
    expect(text).toInclude(
      '\nposts (query scope app:use; action scope posts:write) — Blog posts\n  listPosts {',
    );
    expect(text).toInclude('\n  publishPost (action) {postId: string} — Publish a draft post');
    expect(text).toInclude('\norg (scope app:use) — The organisation\n  transferOrg (action) {}');
  });
});

describe('meta surface — manage_resource is the flat call, through another door', () => {
  /** The same response, whichever surface asked. */
  const parity = async (
    flatCall: ReturnType<typeof call>,
    metaCall: ReturnType<typeof call>,
    flatCaller: McpCaller,
    metaCaller: McpCaller,
  ) => {
    const server = appServer();
    const viaFlat = await inRequest(() => server.handle(flatCall, flatCaller));
    const viaMeta = await inRequest(() => server.handle(metaCall, metaCaller));
    expect(JSON.stringify(viaMeta)).toBe(JSON.stringify(viaFlat));
    return viaMeta;
  };

  test('scope refusal is identical, and the policy never ran', async () => {
    const response = await parity(
      call('publishPost', { postId: 'p' }),
      manage('posts', 'publishPost', { postId: 'p' }),
      flatOwner(),
      metaOwner(),
    );
    expect(response?.error?.code).toBe(INVALID_REQUEST);
    expect(publishedCount()).toBe(0);
  });

  test('policy refusal is identical', async () => {
    const response = await parity(
      call('publishPost', { postId: 'p' }),
      manage('posts', 'publishPost', { postId: 'p' }),
      flatMember(['posts:write']),
      metaMember(['posts:write']),
    );
    expect(JSON.stringify(response)).toContain('X_FORBIDDEN');
    expect(publishedCount()).toBe(0);
  });

  test('an awaiting-confirmation write answers identically and runs once per call', async () => {
    const response = await parity(
      call('publishPost', { postId: 'p' }),
      manage('posts', 'publishPost', { postId: 'p' }),
      flatOwner(['posts:write']),
      metaOwner(['posts:write']),
    );
    expect(resultJson(response)).toEqual({ ok: true, status: 'awaiting_confirmation' });
    expect(publishedCount()).toBe(2);
  });

  test('a list query with whitelisted params answers what the flat call answers', async () => {
    const response = await parity(
      call('listPosts', { status_eq: 'draft', sort: '-createdAt', limit: 5 }),
      manage('posts', 'listPosts', { status_eq: 'draft', sort: '-createdAt', limit: 5 }),
      flatOwner(),
      metaOwner(),
    );
    expect(resultJson(response)).toEqual([{ id: 'p1' }, { id: 'p2' }] as never);
  });

  test('invalid tool arguments are identical', async () => {
    const response = await parity(
      call('publishPost', {}),
      manage('posts', 'publishPost', {}),
      flatOwner(['posts:write']),
      metaOwner(['posts:write']),
    );
    expect(refusedArgs(response)).toBe(true);
  });

  test('manage_resource is metered as the tool it reaches', () => {
    const server = appServer();
    expect(server.classify(manage('posts', 'listPosts'))).toBe('read');
    expect(server.classify(manage('posts', 'publishPost'))).toBe('write');
    expect(server.classify(call('manage_resource', {}))).toBe('write');
    expect(server.classify(call('list_resources'))).toBe('read');
  });
});
