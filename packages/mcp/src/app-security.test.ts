// The three outcomes as a REAL APP declares them — `security.test.ts`'s sibling.
//
// That file drives hand-built `McpTool` objects, which is how the registry's gates are proven.
// This one drives what an app actually ships: real `action`s and `query`s with policies,
// projected by `defineAppMcp`. A gate can only refuse what a declaration can reach, and two of
// the three outcomes could not be reached that way until 2026-08 — the projection dropped
// `visibleTo` (so every projected tool was visible to every caller) and `defineAppMcp` had no
// `scopes:` map at all (so no app tool could carry a scope). Both gates enforced; neither
// engageable. These tests are what make them declared AND enforced.
//
// Split from `security.test.ts` for the file ceiling only — same contract, same rules.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { action, registerAction, resetRegistry as resetActions } from '@ultimat3/action';
import { agentActor, createContext, runWithContext } from '@ultimat3/core';
import {
  can,
  clearPermissions,
  clearRoles,
  definePermissions,
  defineRoles,
} from '@ultimat3/policy';
import { from, query, registerQuery, resetRegistry as resetQueries } from '@ultimat3/query';
import { t } from '@ultimat3/schema';
import { defineAppMcp } from './app-tools';
import type { McpCaller } from './registry';
import type { McpServer } from './server';
import type { JsonRpcResponse } from './wire';
import { INVALID_REQUEST, METHOD_NOT_FOUND } from './wire';

/** Reading the wire the way an agent does — the same readers `security.test.ts` uses. */
const errorData = (response: JsonRpcResponse | null): Record<string, unknown> =>
  (response?.error?.data ?? {}) as Record<string, unknown>;

const toolResult = (response: JsonRpcResponse | null) =>
  (response?.result ?? {}) as { isError?: boolean; content?: { text: string }[] };

const listedNames = (response: JsonRpcResponse | null): readonly string[] =>
  ((response?.result as { tools?: { name: string }[] } | undefined)?.tools ?? []).map(
    (tool) => tool.name,
  );

const call = (name: string, args: Record<string, unknown> = {}) => ({
  jsonrpc: '2.0' as const,
  id: 1,
  method: 'tools/call',
  params: { name, arguments: args },
});

const list = { jsonrpc: '2.0' as const, id: 1, method: 'tools/list' };

describe('the three outcomes over the blessed path — defineAppMcp', () => {
  /** Counts handler entries: the scope gate is only "before the policy" if this stays 0. */
  let published = 0;

  const ownerActor = agentActor({ id: 'agent-owner', orgId: 'o1', roles: ['owner'] });
  const memberActor = agentActor({ id: 'agent-member', orgId: 'o1', roles: ['member'] });

  /** The MCP `role` is the catalog audience; the actor's roles are what the policy reads. */
  const asOwner = (scopes: readonly string[] = []): McpCaller => ({
    actor: ownerActor,
    scopes: new Set(scopes),
    role: 'owner',
  });
  const asMember = (scopes: readonly string[] = []): McpCaller => ({
    actor: memberActor,
    scopes: new Set(scopes),
    role: 'member',
  });

  /** A projected action opens a child context, so it needs a request to hang off. */
  const inRequest = <T>(fn: () => Promise<T>): Promise<T> => runWithContext(createContext({}), fn);

  beforeEach(() => {
    published = 0;
    definePermissions(['post:publish', 'post:read', 'org:administer']);
    defineRoles({
      owner: { grants: ['post:publish', 'post:read', 'org:administer'] },
      member: { grants: ['post:read'] },
    });

    registerAction(
      'publishPost',
      action({
        input: t.object({ postId: t.string }),
        output: t.object({ ok: t.boolean }),
        policy: can('post:publish'),
        mcp: { expose: true, description: 'Publish a draft post' },
        handle: () => {
          published += 1;
          return { ok: true };
        },
      }),
    );
    registerAction(
      'transferOrg',
      action({
        input: t.object({}),
        output: t.object({ ok: t.boolean }),
        policy: can('org:administer'),
        // OUTCOME 1, declared where the policy is: owners may even KNOW this exists.
        mcp: { expose: true, description: 'Transfer the org', visibleTo: ['owner'] },
        handle: () => ({ ok: true }),
      }),
    );
    registerAction(
      'deleteEverything',
      action({
        input: t.object({}),
        output: t.object({ ok: t.boolean }),
        policy: can('org:administer'),
        handle: () => ({ ok: true }),
      }),
    );
    registerQuery(
      'orgFeed',
      query({
        input: t.object({}),
        policy: can('post:read'),
        mcp: { expose: true, description: 'The org feed', visibleTo: ['owner'] },
        sql: () => from<{ id: string }>('posts', [{ id: 'p1' }]),
      }),
    );
  });

  afterEach(() => {
    resetActions();
    resetQueries();
    clearPermissions();
    clearRoles();
  });

  /** The app's one boot call: everything opted in, one capability declared over one tool. */
  const appServer = (): McpServer =>
    defineAppMcp({
      name: 'postly',
      include: 'exposed',
      scopes: { 'posts:write': ['publishPost'] },
    }).server;

  test('OUTCOME 1 — visibleTo on the action reaches the catalog, per caller', async () => {
    const server = appServer();

    expect(listedNames(await server.handle(list, asOwner()))).toEqual([
      'orgFeed',
      'publishPost',
      'transferOrg',
    ]);
    // `deleteEverything` never opted in; `transferOrg` and `orgFeed` opted in for owners only.
    expect(listedNames(await server.handle(list, asMember()))).toEqual(['publishPost']);
  });

  test('OUTCOME 1 — a hidden projected tool answers what an absent one answers', async () => {
    const server = appServer();

    const onHidden = await server.handle(call('transferOrg'), asMember());
    const onAbsent = await server.handle(call('no.such.tool'), asMember());

    expect(JSON.stringify(onHidden).replace('transferOrg', 'no.such.tool')).toBe(
      JSON.stringify(onAbsent),
    );
    expect(Object.keys(onHidden?.error ?? {}).sort()).toEqual(['code', 'message']);
  });

  test('OUTCOME 1 — an actor who would PASS the policy still cannot see it without the role', async () => {
    const server = appServer();
    // Same actor rights, no MCP role: the catalog audience is decided by `visibleTo` alone,
    // so "the policy would have allowed it" must not leak the tool's existence.
    const roleless: McpCaller = { actor: ownerActor, scopes: new Set() };

    expect(listedNames(await server.handle(list, roleless))).toEqual(['publishPost']);
    expect((await server.handle(call('transferOrg'), roleless))?.error?.code).toBe(
      METHOD_NOT_FOUND,
    );
  });

  test('OUTCOME 2 — a scoped projected action names the missing scope, before the policy', async () => {
    const server = appServer();

    const response = await inRequest(() =>
      server.handle(call('publishPost', { postId: 'p_1' }), asOwner()),
    );

    expect(response?.error?.code).toBe(INVALID_REQUEST);
    expect(errorData(response)['code']).toBe('X_MCP_SCOPE_DENIED');
    expect(errorData(response)['scope']).toBe('posts:write');
    // The owner's policy WOULD have allowed this call. The scope decided first, and the
    // handler never ran — a refusal must not depend on evaluating a policy against input.
    expect(published).toBe(0);
  });

  test('OUTCOME 2 — an unscoped tool on the same server is unaffected', async () => {
    const server = appServer();

    const response = await inRequest(() => server.handle(call('transferOrg'), asOwner()));

    expect(response?.error).toBeUndefined();
    expect(JSON.stringify(response)).not.toContain('X_MCP_SCOPE_DENIED');
  });

  test('OUTCOME 3 — with the scope held, the action’s own policy decides', async () => {
    const server = appServer();

    const denied = await inRequest(() =>
      server.handle(call('publishPost', { postId: 'p_1' }), asMember(['posts:write'])),
    );

    // A member holds the scope and may see the tool; `can('post:publish')` still refuses —
    // the same code, from the same policy object, an HTTP call would get.
    expect(denied?.error).toBeUndefined();
    expect(toolResult(denied).isError).toBe(true);
    expect(toolResult(denied).content?.[0]?.text ?? '').toContain('X_FORBIDDEN');
    expect(published).toBe(0);
  });

  test('all three gates passed runs the action exactly once', async () => {
    const server = appServer();

    const response = await inRequest(() =>
      server.handle(call('publishPost', { postId: 'p_1' }), asOwner(['posts:write'])),
    );

    expect(toolResult(response).isError).toBeUndefined();
    expect(published).toBe(1);
  });

  test('the three answers stay pairwise distinguishable on one server', async () => {
    const server = appServer();
    const hidden = await server.handle(call('transferOrg'), asMember());
    const scope = await inRequest(() => server.handle(call('publishPost', {}), asMember()));
    const policy = await inRequest(() =>
      server.handle(call('publishPost', { postId: 'p_1' }), asMember(['posts:write'])),
    );

    expect(hidden?.error?.code).toBe(METHOD_NOT_FOUND);
    expect(errorData(scope)['code']).toBe('X_MCP_SCOPE_DENIED');
    expect(toolResult(policy).isError).toBe(true);
    // Never `Forbidden` on a hidden tool: the whole model is that these three differ.
    expect(JSON.stringify(hidden)).not.toContain('FORBIDDEN');
    expect(JSON.stringify(hidden)).not.toContain('scope');
  });

  test('a scope naming a tool the server does not project is refused at BOOT', () => {
    // `deleteEverything` is registered and never opted in, so it is not in the catalog. A
    // scope entry that covers nothing would leave the author believing it is gated.
    const boot = (): unknown =>
      defineAppMcp({ include: 'exposed', scopes: { 'org:admin': ['deleteEverything'] } });

    expect(boot).toThrow('X_MCP_SCOPE_UNKNOWN');
    try {
      boot();
    } catch (error) {
      const denial = error as { cause: string; fix: string };
      expect(denial.cause).toContain('deleteEverything');
      expect(denial.cause).toContain('orgFeed, publishPost, transferOrg');
      expect(denial.fix).toContain('defineAppMcp');
    }
  });

  test('one tool claimed by two scopes is refused at BOOT', () => {
    expect(() =>
      defineAppMcp({
        include: 'exposed',
        scopes: { 'posts:write': ['publishPost'], 'org:admin': ['publishPost'] },
      }),
    ).toThrow('X_MCP_SCOPE_CONFLICT');
  });
});
