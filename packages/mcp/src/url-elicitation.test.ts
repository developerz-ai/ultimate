// URL-mode elicitation on the JSON transport, through `handle`. The failing case first: a tool
// that needs the person to open a page had only its text to say so, and a client able to show a
// native prompt was never asked. A modern request that declares `elicitation.url` is answered an
// `InputRequiredResult`; every other caller gets the plain answer, byte for byte.

import { describe, expect, test } from 'bun:test';
import { agentActor } from '@ultimat3/core';
import { toolFrom } from './from-action';
import type { McpCaller, McpToolResult, McpUrlElicitation } from './registry';
import { textResult } from './registry';
import { mcpServer } from './server';
import {
  McpElicitationUrlError,
  URL_ELICITATION_KEY,
  urlElicitationOf,
  withUrlElicitation,
} from './url-elicitation';
import type { JsonRpcRequest } from './wire';
import {
  MCP_LEGACY_VERSIONS,
  MCP_MODERN_VERSIONS,
  META_CLIENT_CAPABILITIES,
  META_PROTOCOL_VERSION,
  META_SERVER_INFO,
} from './wire';

const MODERN = MCP_MODERN_VERSIONS[0];
const caller: McpCaller = { actor: agentActor({ id: 'a1' }), scopes: new Set(), role: 'member' };
const ASK: McpUrlElicitation = {
  url: 'https://app.test/connect',
  message: 'Open this page to finish connecting.',
};
const PLAIN = 'Not connected yet. Open https://app.test/connect to finish.';
const NO_ARGS = { type: 'object', properties: {}, additionalProperties: false } as const;

/** A tool that asks with whatever `ask` holds when it is called, and counts its runs. */
const serverAsking = (ask: () => unknown) => {
  let runs = 0;
  const server = mcpServer({
    tools: [
      {
        name: 'connect',
        description: 'asks the person to open a page',
        inputSchema: NO_ARGS,
        async handle(): Promise<McpToolResult> {
          runs += 1;
          return { ...textResult(PLAIN), urlElicitation: ask() as McpUrlElicitation };
        },
      },
      {
        name: 'plain',
        description: 'asks for nothing',
        inputSchema: NO_ARGS,
        async handle() {
          return textResult('ok');
        },
      },
    ],
  });
  return { server, runs: () => runs };
};

const call = (
  name: string,
  options: {
    readonly version?: string | undefined;
    readonly capabilities?: unknown;
    readonly params?: Readonly<Record<string, unknown>>;
  } = {},
): JsonRpcRequest => {
  const meta: Record<string, unknown> = {};
  if (options.version !== undefined) meta[META_PROTOCOL_VERSION] = options.version;
  if (options.capabilities !== undefined) meta[META_CLIENT_CAPABILITIES] = options.capabilities;
  return {
    jsonrpc: '2.0',
    id: 7,
    method: 'tools/call',
    params: {
      name,
      arguments: {},
      ...(Object.keys(meta).length === 0 ? {} : { _meta: meta }),
      ...(options.params ?? {}),
    },
  };
};

const URL_CAPABLE = { elicitation: { form: {}, url: {} } };

const resultOf = async (
  server: ReturnType<typeof mcpServer>,
  request: JsonRpcRequest,
): Promise<Record<string, unknown>> => {
  const response = await server.handle(request, caller);
  expect(response?.error).toBeUndefined();
  return response?.result as Record<string, unknown>;
};

const plainAnswer = { content: [{ type: 'text', text: PLAIN }] };

describe('a client that declared elicitation.url on a modern request', () => {
  test('is answered an InputRequiredResult carrying the one elicitation/create request', async () => {
    const { server } = serverAsking(() => ASK);
    const result = await resultOf(
      server,
      call('connect', { version: MODERN, capabilities: URL_CAPABLE }),
    );
    expect(result['resultType']).toBe('input_required');
    expect(result['inputRequests']).toEqual({
      [URL_ELICITATION_KEY]: {
        method: 'elicitation/create',
        params: { mode: 'url', url: ASK.url, message: ASK.message },
      },
    });
    // The spec's InputRequiredResult is not a CallToolResult: no content rides beside it.
    expect(result['content']).toBeUndefined();
    expect(result['isError']).toBeUndefined();
    // No state is handed out, so none has to be trusted on the way back.
    expect(result['requestState']).toBeUndefined();
    expect((result['_meta'] as Record<string, unknown>)[META_SERVER_INFO]).toBeDefined();
  });

  test.each(['accept', 'decline', 'cancel'])(
    'is not asked twice: a retry answering %s gets what the tool answers',
    async (action) => {
      const { server, runs } = serverAsking(() => ASK);
      const result = await resultOf(
        server,
        call('connect', {
          version: MODERN,
          capabilities: URL_CAPABLE,
          params: { inputResponses: { [URL_ELICITATION_KEY]: { action } } },
        }),
      );
      expect(result['resultType']).toBe('complete');
      expect(result['content']).toEqual(plainAnswer.content);
      expect(result['inputRequests']).toBeUndefined();
      expect(runs()).toBe(1);
    },
  );

  test.each([
    ['another key', { other: { action: 'accept' } }],
    ['no object', 'accept'],
    ['an array', [{ action: 'accept' }]],
    ['an answer that is not one', { [URL_ELICITATION_KEY]: 'accept' }],
    ['an answer with no action', { [URL_ELICITATION_KEY]: {} }],
    ['an inherited key', Object.create({ [URL_ELICITATION_KEY]: { action: 'accept' } })],
  ])('is asked again when inputResponses carries %s', async (_label, inputResponses) => {
    const { server } = serverAsking(() => ASK);
    const result = await resultOf(
      server,
      call('connect', {
        version: MODERN,
        capabilities: URL_CAPABLE,
        params: { inputResponses },
      }),
    );
    expect(result['resultType']).toBe('input_required');
  });

  test('a tool that asks for nothing answers as before', async () => {
    const { server } = serverAsking(() => ASK);
    const result = await resultOf(
      server,
      call('plain', { version: MODERN, capabilities: URL_CAPABLE }),
    );
    expect(result['resultType']).toBe('complete');
    expect(result['content']).toEqual([{ type: 'text', text: 'ok' }]);
  });
});

describe('a client without the capability gets the plain text answer', () => {
  test.each([
    ['no capabilities at all', undefined],
    ['no elicitation', { sampling: {} }],
    ['elicitation: {} — form only, by the spec', { elicitation: {} }],
    ['form only', { elicitation: { form: {} } }],
    ['url: true, which is not an object', { elicitation: { url: true } }],
    ['url: null', { elicitation: { url: null } }],
    ['capabilities that are not an object', 'elicitation.url'],
    ['an inherited url', { elicitation: Object.create({ url: {} }) }],
  ])('modern, %s', async (_label, capabilities) => {
    const { server } = serverAsking(() => ASK);
    const result = await resultOf(server, call('connect', { version: MODERN, capabilities }));
    expect(result['resultType']).toBe('complete');
    expect(result['content']).toEqual(plainAnswer.content);
    expect(result['inputRequests']).toBeUndefined();
    // The ask itself is never a wire field.
    expect(result['urlElicitation']).toBeUndefined();
  });

  test.each([undefined, ...MCP_LEGACY_VERSIONS])(
    'legacy (%s): the handshake is not kept, so nothing was declared on this request',
    async (version) => {
      const { server } = serverAsking(() => ASK);
      const result = await resultOf(
        server,
        call('connect', { version, capabilities: URL_CAPABLE }),
      );
      expect(result).toEqual(plainAnswer);
    },
  );
});

describe('the URL a client is shown', () => {
  test.each([
    ['plain http off this machine', { ...ASK, url: 'http://app.test/connect' }],
    ['credentials in the URL', { ...ASK, url: 'https://user:secret@app.test/connect' }],
    ['a username alone', { ...ASK, url: 'https://user@app.test/connect' }],
    ['a relative path', { ...ASK, url: '/connect' }],
    ['a script URL', { ...ASK, url: 'javascript:alert(1)' }],
    ['a data URL', { ...ASK, url: 'data:text/html,<p>hi' }],
    ['no URL', { message: ASK.message }],
    ['a URL that is not a string', { ...ASK, url: new URL(ASK.url) }],
    ['an empty message', { ...ASK, message: '  ' }],
    ['no message', { url: ASK.url }],
    ['not an object', ASK.url],
  ])('%s is refused for a capable client, as the tool failing', async (_label, ask) => {
    const { server } = serverAsking(() => ask);
    const result = await resultOf(
      server,
      call('connect', { version: MODERN, capabilities: URL_CAPABLE }),
    );
    expect(result['isError']).toBe(true);
    expect(result['inputRequests']).toBeUndefined();
    const text = (result['content'] as readonly { text: string }[])[0]?.text ?? '';
    expect(text).toContain('X_MCP_ELICITATION_URL_INVALID');
    // The refused value is the tool's, and may be the secret it should not have sent.
    expect(text).not.toContain('secret');
  });

  test('a bad ask is refused for a client that would never have been shown it, too', async () => {
    const { server } = serverAsking(() => ({ ...ASK, url: 'http://app.test/connect' }));
    const result = await resultOf(server, call('connect'));
    expect(result['isError']).toBe(true);
  });

  test.each([
    'http://localhost:3000/connect',
    'http://127.0.0.1:3000/connect',
    'http://[::1]:3000/connect',
    'https://app.test/connect?request=r_123',
  ])('%s is allowed', async (url) => {
    const { server } = serverAsking(() => ({ ...ASK, url }));
    const result = await resultOf(
      server,
      call('connect', { version: MODERN, capabilities: URL_CAPABLE }),
    );
    expect(result['resultType']).toBe('input_required');
  });
});

describe('withUrlElicitation: how a projected tool asks', () => {
  const projected = (output: () => unknown) =>
    mcpServer({
      tools: [
        toolFrom({
          name: 'connect',
          description: 'asks the person to open a page',
          mcp: { expose: true, description: 'asks the person to open a page' },
          mutates: false,
          run: async () => output(),
        }),
      ],
    });

  test('the value a handler returns is the value it is given back, with the ask recorded', () => {
    const output = { status: 'not_connected', link: ASK.url };
    expect(withUrlElicitation(output, ASK)).toBe(output);
    expect(urlElicitationOf(output)).toEqual(ASK);
    expect(JSON.stringify(output)).toBe(
      '{"status":"not_connected","link":"https://app.test/connect"}',
    );
    expect(urlElicitationOf({ ...output })).toBeUndefined();
    expect(urlElicitationOf('text')).toBeUndefined();
  });

  test('a capable client is asked; any other reads the output the handler returned', async () => {
    const server = projected(() =>
      withUrlElicitation({ status: 'not_connected', link: ASK.url }, ASK),
    );
    const asked = await resultOf(
      server,
      call('connect', { version: MODERN, capabilities: URL_CAPABLE }),
    );
    expect(asked['resultType']).toBe('input_required');
    const plain = await resultOf(server, call('connect', { version: MODERN }));
    expect(plain['content']).toEqual([
      { type: 'text', text: '{"status":"not_connected","link":"https://app.test/connect"}' },
    ]);
  });

  test('a URL no client may be shown is refused where it is written', () => {
    let thrown: unknown;
    try {
      withUrlElicitation({}, { ...ASK, url: 'https://user:secret@app.test/connect' });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(McpElicitationUrlError);
    expect(thrown instanceof McpElicitationUrlError ? thrown.format() : '').not.toContain('secret');
  });
});
