// URL-mode elicitation, one call at a time: an ask belongs to the invocation that made it, the URL a
// client is shown is the one that was checked, the wire key is the documented literal, and a tool
// that failed is never hidden behind a prompt. The real action pipeline is driven where a
// projection could lose the ask.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { action, resetActions } from '@ultimat3/action';
import { registerAction } from '@ultimat3/action/loader';
import { agentActor } from '@ultimat3/core';
import { allow } from '@ultimat3/policy';
import { t } from '@ultimat3/schema';
import { toolFrom } from './from-action';
import type { McpCaller, McpToolResult, McpUrlElicitation } from './registry';
import { textResult } from './registry';
import { mcpServer } from './server';
import { withUrlElicitation } from './url-elicitation';
import type { JsonRpcRequest } from './wire';
import { MCP_MODERN_VERSIONS, META_CLIENT_CAPABILITIES, META_PROTOCOL_VERSION } from './wire';

const MODERN = MCP_MODERN_VERSIONS[0];
const caller: McpCaller = { actor: agentActor({ id: 'a1' }), scopes: new Set(), role: 'member' };
const ASK: McpUrlElicitation = {
  url: 'https://app.test/connect',
  message: 'Open this page to finish connecting.',
};
const NO_ARGS = { type: 'object', properties: {}, additionalProperties: false } as const;
/** URL mode alone: a client need not declare form mode to be shown a URL prompt. */
const URL_ONLY = { elicitation: { url: {} } };

const call = (
  name: string,
  params: Record<string, unknown> = {},
  meta: Record<string, unknown> = {
    [META_PROTOCOL_VERSION]: MODERN,
    [META_CLIENT_CAPABILITIES]: URL_ONLY,
  },
): JsonRpcRequest => ({
  jsonrpc: '2.0',
  id: 9,
  method: 'tools/call',
  params: { name, arguments: {}, _meta: meta, ...params },
});

const resultOf = async (
  server: ReturnType<typeof mcpServer>,
  request: JsonRpcRequest,
): Promise<Record<string, unknown>> => {
  const response = await server.handle(request, caller);
  expect(response?.error).toBeUndefined();
  return response?.result as Record<string, unknown>;
};

const projected = (run: () => unknown) =>
  mcpServer({
    tools: [
      toolFrom({
        name: 'connect',
        description: 'asks the person to open a page',
        mcp: { expose: true, description: 'asks the person to open a page' },
        mutates: false,
        run: async () => run(),
      }),
    ],
  });

describe('the wire, by its documented spelling', () => {
  test('a URL-only client is asked under the literal key url_elicitation', async () => {
    const server = projected(() => withUrlElicitation({ status: 'not_connected' }, ASK));
    const result = await resultOf(server, call('connect'));
    expect(result['resultType']).toBe('input_required');
    expect(result['inputRequests']).toEqual({
      url_elicitation: {
        method: 'elicitation/create',
        params: { mode: 'url', url: ASK.url, message: ASK.message },
      },
    });
  });

  test('the prompt, then the retry: the rerun runs and its own content is the answer', async () => {
    let runs = 0;
    const server = mcpServer({
      tools: [
        {
          name: 'connect',
          description: 'asks until the page was finished',
          inputSchema: NO_ARGS,
          async handle(): Promise<McpToolResult> {
            runs += 1;
            return runs === 1
              ? { ...textResult('not connected yet'), urlElicitation: ASK }
              : textResult('connected');
          },
        },
      ],
    });
    const first = await resultOf(server, call('connect'));
    expect(first['resultType']).toBe('input_required');
    const retry = await resultOf(
      server,
      call('connect', { inputResponses: { url_elicitation: { action: 'accept' } } }),
    );
    expect(retry['resultType']).toBe('complete');
    expect(retry['content']).toEqual([{ type: 'text', text: 'connected' }]);
    expect(runs).toBe(2);
  });

  test.each(['dismiss', 'ACCEPT', ''])(
    'an answer whose action is %p is no answer: the person is asked again',
    async (answer) => {
      const server = projected(() => withUrlElicitation({ status: 'not_connected' }, ASK));
      const result = await resultOf(
        server,
        call('connect', { inputResponses: { url_elicitation: { action: answer } } }),
      );
      expect(result['resultType']).toBe('input_required');
    },
  );
});

describe('an ask belongs to the call that made it', () => {
  test('a shared output asked for once is not asked for again by a call that did not ask', async () => {
    const shared = { status: 'not_connected' };
    let ask = true;
    const server = projected(() => (ask ? withUrlElicitation(shared, ASK) : shared));
    expect((await resultOf(server, call('connect')))['resultType']).toBe('input_required');
    ask = false;
    const later = await resultOf(server, call('connect'));
    expect(later['resultType']).toBe('complete');
    expect(later['content']).toEqual([{ type: 'text', text: '{"status":"not_connected"}' }]);
  });

  test('a capability or an answer inherited by params is not one the request sent', async () => {
    const server = projected(() => withUrlElicitation({ status: 'not_connected' }, ASK));
    const inheritedMeta = Object.create({
      _meta: { [META_PROTOCOL_VERSION]: MODERN, [META_CLIENT_CAPABILITIES]: URL_ONLY },
    }) as Record<string, unknown>;
    const noCapability: JsonRpcRequest = {
      jsonrpc: '2.0',
      id: 9,
      method: 'tools/call',
      params: Object.assign(inheritedMeta, { name: 'connect', arguments: {} }),
    };
    const plain = await resultOf(server, noCapability);
    expect(plain['inputRequests']).toBeUndefined();

    const inheritedAnswer = Object.create({
      inputResponses: { url_elicitation: { action: 'accept' } },
    }) as Record<string, unknown>;
    const asked = await resultOf(server, {
      jsonrpc: '2.0',
      id: 9,
      method: 'tools/call',
      params: Object.assign(inheritedAnswer, {
        name: 'connect',
        arguments: {},
        _meta: { [META_PROTOCOL_VERSION]: MODERN, [META_CLIENT_CAPABILITIES]: URL_ONLY },
      }),
    });
    expect(asked['resultType']).toBe('input_required');
  });
});

describe('the URL a client is shown is the URL that was checked', () => {
  test('a spelling the parser repairs is sent in its parsed form', async () => {
    const server = projected(() =>
      withUrlElicitation({ status: 'not_connected' }, { ...ASK, url: 'https:app.test/connect' }),
    );
    const result = await resultOf(server, call('connect'));
    const requests = result['inputRequests'] as Record<string, { params: { url: string } }>;
    expect(requests['url_elicitation']?.params.url).toBe('https://app.test/connect');
  });

  test('a hand-built tool is shown the parsed form too', async () => {
    const server = mcpServer({
      tools: [
        {
          name: 'connect',
          description: 'asks',
          inputSchema: NO_ARGS,
          async handle(): Promise<McpToolResult> {
            return {
              ...textResult('open it'),
              urlElicitation: { ...ASK, url: 'HTTPS://App.Test/connect' },
            };
          },
        },
      ],
    });
    const result = await resultOf(server, call('connect'));
    const requests = result['inputRequests'] as Record<string, { params: { url: string } }>;
    expect(requests['url_elicitation']?.params.url).toBe('https://app.test/connect');
  });
});

describe('a tool that failed is never hidden behind a prompt', () => {
  test('an output that cannot be serialized answers isError, even to a capable client', async () => {
    const server = projected(() => {
      const cyclic: Record<string, unknown> = { status: 'not_connected' };
      cyclic['self'] = cyclic;
      return withUrlElicitation(cyclic, ASK);
    });
    const result = await resultOf(server, call('connect'));
    expect(result['isError']).toBe(true);
    expect(result['inputRequests']).toBeUndefined();
  });

  test('a hand-built isError result is answered as the error it is', async () => {
    const server = mcpServer({
      tools: [
        {
          name: 'connect',
          description: 'fails',
          inputSchema: NO_ARGS,
          async handle(): Promise<McpToolResult> {
            return { ...textResult('the upstream refused', true), urlElicitation: ASK };
          },
        },
      ],
    });
    const result = await resultOf(server, call('connect'));
    expect(result['isError']).toBe(true);
    expect(result['inputRequests']).toBeUndefined();
  });
});

describe('a registered action with a declared output asks through the real pipeline', () => {
  beforeEach(() => resetActions());
  afterEach(() => resetActions());

  test('its projected tool answers input_required to a capable client', async () => {
    const connect = registerAction(
      'connectAccount',
      action({
        input: t.object({}),
        output: t.object({ status: t.string, open: t.string }),
        policy: allow('public'),
        mcp: { expose: true, description: 'Connect the account' },
        handle: () => withUrlElicitation({ status: 'not_connected', open: ASK.url }, ASK),
      }),
    );
    const server = mcpServer({ tools: [toolFrom(connect)] });
    const result = await resultOf(server, call('connectAccount'));
    expect(result['resultType']).toBe('input_required');
    const plain = await resultOf(
      server,
      call('connectAccount', {}, { [META_PROTOCOL_VERSION]: MODERN }),
    );
    expect(plain['structuredContent']).toEqual({ status: 'not_connected', open: ASK.url });
  });
});
