// The META surface — `surface: 'meta'` + `groups:` — as a real app declares it.
//
// The claim under test is that the meta tools are a second DOOR, never a second PATH: the catalog
// stays constant, a hidden tool is absent through either door, and `manage_resource` answers
// byte-for-byte what the flat `tools/call` answers for the same input — success, scope refusal,
// policy refusal and an awaiting-confirmation write alike. Failure cases first.

import { describe, expect, test } from 'bun:test';
import { defineAppMcp } from './app-tools';
import {
  appServer,
  call,
  flatOwner,
  GROUPS,
  inRequest,
  list,
  listedNames,
  manage,
  metaMember,
  metaOwner,
  refusedArgs,
  resultText,
  useMetaSurfaceApp,
  whoami,
} from './meta-surface-fixture';
import type { AnyMcpTool } from './registry';
import { mcpServer } from './server';
import { METHOD_NOT_FOUND } from './wire';

useMetaSurfaceApp();

describe('meta surface — refusals first', () => {
  test('a hidden resource is absent from list_resources, and manage_resource answers what an absent pair answers', async () => {
    const server = appServer();
    expect(server.catalog(metaMember())?.map((r) => r.name)).toEqual(['posts']);
    const listed = resultText(await server.handle(call('list_resources'), metaMember()));
    expect(listed).toInclude('\nposts (');
    expect(listed).not.toInclude('org');

    const hidden = await server.handle(manage('org', 'transferOrg'), metaMember());
    const absent = await server.handle(manage('org', 'noSuchTool'), metaMember());
    expect(hidden?.error?.code).toBe(METHOD_NOT_FOUND);
    expect(JSON.stringify(hidden).replace('transferOrg', 'noSuchTool')).toBe(
      JSON.stringify(absent),
    );
    expect(Object.keys(hidden?.error ?? {}).sort()).toEqual(['code', 'message']);
    expect(JSON.stringify(hidden)).not.toContain('FORBIDDEN');
  });

  test('describe_resource on a hidden resource answers what an unknown one answers', async () => {
    const server = appServer();
    const hidden = await server.handle(
      call('describe_resource', { resources: ['org'] }),
      metaMember(),
    );
    const absent = await server.handle(
      call('describe_resource', { resources: ['zzz'] }),
      metaMember(),
    );
    expect(hidden?.error?.code).toBe(METHOD_NOT_FOUND);
    expect(JSON.stringify(hidden).replace("'org'", "'zzz'").replace('org', 'zzz')).toBe(
      JSON.stringify(absent),
    );
  });

  test('a tool addressed under the WRONG resource is not found', async () => {
    const response = await appServer().handle(manage('org', 'publishPost'), metaOwner());
    expect(response?.error?.code).toBe(METHOD_NOT_FOUND);
  });

  test('a meta caller cannot reach a grouped tool by its flat name — and a flat caller never sees the meta tools', async () => {
    const server = appServer();
    const direct = await server.handle(call('publishPost', { postId: 'p' }), metaOwner());
    const absent = await server.handle(call('noSuchTool'), metaOwner());
    expect(direct?.error?.code).toBe(METHOD_NOT_FOUND);
    expect(JSON.stringify(direct).replace('publishPost', 'noSuchTool')).toBe(
      JSON.stringify(absent),
    );
    const flat = await server.handle(call('list_resources'), flatOwner());
    expect(flat?.error?.code).toBe(METHOD_NOT_FOUND);
  });

  test('a list filter outside the whitelist is refused before the query runs', async () => {
    const server = appServer();
    const response = await inRequest(() =>
      server.handle(manage('posts', 'listPosts', { status_in: ['draft'] }), metaOwner()),
    );
    expect(refusedArgs(response)).toBe(true);
    expect(resultText(response)).toContain('status_in');
    const badSort = await inRequest(() =>
      server.handle(manage('posts', 'listPosts', { sort: 'title' }), metaOwner()),
    );
    expect(refusedArgs(badSort)).toBe(true);
  });

  test('malformed manage_resource arguments are invalid-args, not a crash', async () => {
    const response = await appServer().handle(
      call('manage_resource', { resource: 1 }),
      metaOwner(),
    );
    expect(refusedArgs(response)).toBe(true);
    expect(resultText(response)).toInclude('input for tool "manage_resource"');
  });

  test('boot refuses what would ship a silently wrong catalog', () => {
    expect(() =>
      defineAppMcp({
        include: 'exposed',
        surface: 'meta',
        groups: { x: { description: '', tools: ['nope'] } },
      }),
    ).toThrow('X_MCP_GROUP_UNKNOWN');
    expect(() =>
      defineAppMcp({
        include: 'exposed',
        surface: 'meta',
        groups: {
          a: { description: '', tools: ['publishPost'] },
          b: { description: '', tools: ['publishPost'] },
        },
      }),
    ).toThrow('X_MCP_GROUP_CONFLICT');
    expect(() => defineAppMcp({ include: 'exposed', surface: 'meta' })).toThrow(
      'X_MCP_SURFACE_INVALID',
    );
    expect(() => defineAppMcp({ include: 'exposed', groups: GROUPS })).toThrow(
      'X_MCP_SURFACE_INVALID',
    );
    expect(() =>
      defineAppMcp({
        include: 'exposed',
        surface: 'meta',
        groups: GROUPS,
        tools: [{ ...whoami, name: 'list_resources' }],
      }),
    ).toThrow('X_MCP_TOOL_DUPLICATE');
  });

  test('a listParams key the query input does not declare is refused at boot', () => {
    const tool: AnyMcpTool = {
      ...whoami,
      name: 'listThings',
      inputSchema: { type: 'object', properties: { limit: { type: 'integer' } } },
      listParams: { filters: { status: ['_eq'] } },
    };
    expect(() => mcpServer({ tools: [tool] })).toThrow('X_MCP_LIST_PARAMS_INVALID');
  });

  test('a surface function that throws serves the flat surface', async () => {
    const server = defineAppMcp({
      include: 'exposed',
      surface: () => {
        throw new TypeError('boom');
      },
      groups: GROUPS,
    }).server;
    expect(listedNames(await server.handle(list, flatOwner()))).toContain('publishPost');
  });
});
