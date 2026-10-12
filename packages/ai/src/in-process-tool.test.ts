/**
 * A tool that is only ever the agent's own. The failure first: `agent()` refused any tool that
 * was not `mcp: { expose: true }` — so a tool that must NEVER be an MCP tool (it reads the
 * knowledge base an unattended writer is grounded on) had to be declared as an action that claims
 * to be one, and was then served to every external MCP client the app has.
 */

import { beforeEach, describe, expect, test } from 'bun:test';
import { action, anonymousCtx } from '@ultimat3/action';
import type { Actor } from '@ultimat3/core';
import { isMcpExposed, UltimateError, userActor } from '@ultimat3/core';
import { allow } from '@ultimat3/policy';
import { t } from '@ultimat3/schema';
import { agent } from './agent';
import { echoProvider } from './echo-provider';
import { inProcessTool } from './in-process-tool';
import { install, POST_ID, promptFor } from './llm-fixture';
import { FIXTURE_MODEL, useFixtureModels } from './model-fixture';
import type { GenerateRequest, GenerateResult, Provider } from './provider';
import { costOf } from './provider';
import { resetAiRuntime } from './runtime';
import { runLlmToolCall, toLlmTools } from './tools';

useFixtureModels();

const actor = userActor({ id: 'u-1' });
const seenBy: { actor: Actor; input: unknown }[] = [];
const kbRead = inProcessTool({
  name: 'kbRead',
  description: 'Read one knowledge-base document by id.',
  input: t.object({ id: t.string }),
  execute: ({ input, actor: caller }) => {
    seenBy.push({ actor: caller, input });
    if (input.id === 'missing') {
      throw new UltimateError({
        code: 'X_KB_DOC_NOT_FOUND',
        cause: 'no document has the id "missing"',
        fix: 'kbList()   # and pass one of its ids',
      });
    }
    return Promise.resolve({ id: input.id, body: 'Art. 8…' });
  },
});

beforeEach(() => {
  resetAiRuntime();
  seenBy.length = 0;
});

describe('inProcessTool()', () => {
  test('is a name, a description, a schema and an execute — and nothing an MCP surface serves', () => {
    expect(kbRead.name).toBe('kbRead');
    expect(kbRead.inProcess).toBe(true);
    expect(kbRead.mcp).toBeUndefined();
    expect(isMcpExposed(kbRead.mcp)).toBe(false);
    // Offered to the model with the schema the declaration states.
    expect(toLlmTools([kbRead])).toEqual([
      {
        name: 'kbRead',
        description: 'Read one knowledge-base document by id.',
        input_schema: {
          type: 'object',
          properties: { id: { type: 'string', minLength: 1 } },
          required: ['id'],
          additionalProperties: false,
        },
        strict: true,
      },
    ]);
  });

  test('runs as the caller, on input its own schema parsed', async () => {
    const result = await runLlmToolCall(
      [kbRead],
      { id: 'c1', name: 'kbRead', input: { id: 'ley-2213' } },
      actor,
    );
    expect(result).toEqual({
      toolUseId: 'c1',
      content: JSON.stringify({ id: 'ley-2213', body: 'Art. 8…' }),
    });
    expect(seenBy).toEqual([{ actor, input: { id: 'ley-2213' } }]);
  });

  test('arguments that fail the schema never reach execute, and the model is told which', async () => {
    const result = await runLlmToolCall(
      [kbRead],
      { id: 'c1', name: 'kbRead', input: { id: 7 } },
      actor,
    );
    expect(result.isError).toBe(true);
    expect(result.content).toContain('X_INPUT_INVALID');
    expect(result.content).toContain('id');
    expect(seenBy).toEqual([]);
  });

  test('its typed refusal reaches the model whole (it is in-process by construction)', async () => {
    const result = await runLlmToolCall(
      [kbRead],
      { id: 'c1', name: 'kbRead', input: { id: 'missing' } },
      actor,
    );
    expect(JSON.parse(result.content)).toMatchObject({ error: { code: 'X_KB_DOC_NOT_FOUND' } });
  });

  test.each([
    ['an empty name', { name: '' }],
    ['a name a provider would reject', { name: 'kb read!' }],
    ['the reserved respond', { name: 'respond' }],
    ['an empty description', { description: ' ' }],
  ])('%s is refused at declaration', (_label, bad) => {
    expect(() =>
      inProcessTool({
        name: 'ok',
        description: 'd',
        input: t.object({}),
        execute: () => Promise.resolve(null),
        ...bad,
      }),
    ).toThrow('X_AI_REQUEST_INVALID');
  });
});

describe('agent({ tools })', () => {
  function scripted(): { provider: Provider; seen: GenerateRequest[] } {
    const seen: GenerateRequest[] = [];
    const provider: Provider = {
      name: 'scripted',
      models: [FIXTURE_MODEL],
      generate(request) {
        seen.push(request);
        const first = seen.length === 1;
        const result: GenerateResult = {
          model: FIXTURE_MODEL,
          text: '',
          toolCalls: [
            first
              ? { id: 'c1', name: 'kbRead', input: { id: 'ley-2213' } }
              : { id: 'c2', name: 'respond', input: { answer: 'done' } },
          ],
          stopReason: 'tool_use',
          stopDetails: undefined,
          usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 },
          cost: costOf(FIXTURE_MODEL, {
            inputTokens: 1,
            outputTokens: 1,
            cacheReadTokens: 0,
            cacheWriteTokens: 0,
          }),
        };
        return Promise.resolve(result);
      },
      stream: (request) => echoProvider().stream(request),
    };
    return { provider, seen };
  }

  const declare = (tools: Parameters<typeof agent>[0]['tools'], name: string) =>
    agent({
      input: t.object({ postId: t.uuid }),
      output: t.object({ answer: t.string }),
      prompt: promptFor(),
      vars: ({ input }) => ({ postId: input.postId }),
      tools,
      policy: allow(),
    }).named(name);

  test('takes an in-process tool with no mcp flag, offers it, and runs it', async () => {
    const { provider, seen } = scripted();
    install(provider);
    const run = declare([kbRead], 'groundedWriter');

    expect(await run({ postId: POST_ID }, { ctx: anonymousCtx() })).toEqual({ answer: 'done' });
    expect(seen[0]?.tools?.map((tool) => tool.name)).toEqual(['kbRead', 'respond']);
    expect(seenBy).toHaveLength(1);
  });

  test('still refuses an action() that is not exposed — and now says both ways out', () => {
    const hidden = action({
      input: t.object({ id: t.string }),
      output: t.object({ ok: t.boolean }),
      policy: allow(),
      handle: () => ({ ok: true }),
    });
    const refused = (() => {
      try {
        declare([hidden], 'refusesHidden');
        return undefined;
      } catch (error) {
        return error as { code: string; fix: string };
      }
    })();
    expect(refused?.code).toBe('X_AGENT_TOOL_UNEXPOSED');
    expect(refused?.fix).toContain('inProcessTool');
    expect(refused?.fix).toContain('mcp: { expose: true }');
  });

  test('and a hand-built tool that claims neither', () => {
    const bare = { name: 'bare', run: () => Promise.resolve(1) };
    expect(() => declare([bare], 'refusesBare')).toThrow('X_AGENT_TOOL_UNEXPOSED');
  });
});
