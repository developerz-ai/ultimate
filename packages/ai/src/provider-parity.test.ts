/**
 * One question, one answer, whichever wire format is asked. `provider.ts`/`wire.ts` read the
 * Anthropic Messages API; `openai-provider.ts`/`openai-wire.ts` read the OpenAI chat-completions
 * format. A rule only one of them holds is a rule an app loses the day it points `configureAi` at
 * the other endpoint — so every case here asserts BOTH sides, and both of the Anthropic
 * TRANSPORTS, inside one `test()`, and neither side can move alone.
 *
 * The per-format suites already cover each half on its own; what could not be seen from inside
 * either is that they disagreed. What a `Provider` must do at its SOCKET — forward the caller's
 * signal, scrub a key echoed into an error, bound an error body — is no longer here: it is
 * `providerTransportConformance` in `@ultimat3/testing`, run over both wires there.
 */

import { beforeEach, describe, expect, test } from 'bun:test';
import { AiTransportError } from './errors';
import type { AiFetch } from './fetch-seam';
import { registerFixtureModels, useFixtureModels } from './model-fixture';
import { parseChatCompletion } from './openai-wire';
import { ChatCompletionStream } from './openai-wire-stream';
import { parseMessage } from './provider';
import { remoteEmbedder } from './remote-embedder';
import type { SseFrame } from './sse';
import { MessageStream } from './wire';

// The framework registers no model: this suite registers the rows it names (`model-fixture.ts`).
useFixtureModels();

const KEY = 'sk-live-do-not-log-me';
const ANTHROPIC_MODEL = 'claude-opus-5';

const frame = (payload: unknown, event = 'message'): SseFrame => ({
  event,
  data: JSON.stringify(payload),
});

/** What the call threw, or `undefined` — so a case asserts the value rather than a `try` shape. */
function thrownBy(run: () => unknown): unknown {
  try {
    run();
    return undefined;
  } catch (error) {
    return error;
  }
}

const transportError = (value: unknown): AiTransportError => {
  expect(value).toBeInstanceOf(AiTransportError);
  return value as AiTransportError;
};

/** Records what left the process and replies with whatever the case wants back. */
function fakeFetch(reply: () => Response): AiFetch {
  return async () => reply();
}

beforeEach(() => {
  // `resetModels()` in another suite clears the whole registry, this format's specs included.
  registerFixtureModels();
});

describe('an in-band error is never an empty successful answer', () => {
  test('a 200 whose body carries an error object is a coded transport failure on both formats', () => {
    const body = { type: 'error', error: { type: 'overloaded_error', message: 'saturated' } };
    // The non-streaming Anthropic read, the streamed one, and the OpenAI-format read. All three
    // parse a body a gateway can send after the headers are out; two of them already refused it.
    const anthropic = transportError(thrownBy(() => parseMessage(ANTHROPIC_MODEL, body)));
    const streamed = transportError(thrownBy(() => new MessageStream().push(frame(body, 'error'))));
    const openai = transportError(
      thrownBy(() =>
        parseChatCompletion(
          { error: { type: 'overloaded_error', message: 'saturated' } },
          'openai',
        ),
      ),
    );

    for (const error of [anthropic, streamed, openai]) {
      expect(error.code).toBe('X_AI_PROVIDER_UNAVAILABLE');
      expect(error.cause).toContain('saturated');
      // The status IS the gateway's retry rule: an in-band failure with none reads as a fault
      // nothing may retry, which is the opposite of what an overloaded provider is saying.
      expect(error.status).not.toBeUndefined();
    }
    // Each format spells "overloaded" in its own numbers, and that is the format's fact, not a
    // divergence: 529 is Anthropic's, 503 is what the OpenAI-format table maps.
    expect(anthropic.status).toBe(529);
    expect(streamed.status).toBe(529);
    expect(openai.status).toBe(503);
  });
});

describe('a refusal detail decides the stop reason', () => {
  test('a refusal is stopReason "refusal" on both formats, whatever the stop field says', () => {
    // `llm()` and `agent()` branch on `stopReason` alone — `stopDetails` has no reader that can
    // refuse — so a body that says "refusal" in the detail and something else in the reason must
    // not arrive as a complete answer that happens to be empty. `parseStopReason` answers
    // `end_turn` for a spelling this build has never seen, which is exactly that case.
    const anthropic = parseMessage(ANTHROPIC_MODEL, {
      content: [],
      stop_reason: 'model_refusal_2027',
      stop_details: { type: 'refusal', category: 'bio' },
      usage: { input_tokens: 9, output_tokens: 0 },
    });
    const stream = new MessageStream();
    stream.push(
      frame({
        type: 'message_delta',
        delta: {
          stop_reason: 'model_refusal_2027',
          stop_details: { type: 'refusal', category: 'bio' },
        },
      }),
    );
    const openai = parseChatCompletion(
      { choices: [{ message: { refusal: 'declined' }, finish_reason: 'stop' }] },
      'openai',
    );

    expect(anthropic.stopReason).toBe('refusal');
    expect(stream.state().stopReason).toBe('refusal');
    expect(openai.stopReason).toBe('refusal');
    // The category is carried on every path: it is the one thing that says whether another model
    // would answer, and `X_LLM_REFUSED`'s fix line is built out of it.
    expect(anthropic.stopDetails?.category).toBe('bio');
    expect(stream.state().stopDetails?.category).toBe('bio');
    expect(openai.stopDetails?.category).toBe('refusal');
  });
});

describe('an empty refusal string is not a refusal', () => {
  test('an empty refusal string is not a refusal on either path', () => {
    // A gateway that always serialises the field writes `"refusal": ""` beside a real answer. The
    // stream accumulates deltas and only an accumulated NON-empty string refuses; the non-streamed
    // read took any string, so the same body was an answer streamed and a refusal not.
    const openai = parseChatCompletion(
      { choices: [{ message: { content: 'hello', refusal: '' }, finish_reason: 'stop' }] },
      'openai',
    );
    const completion = new ChatCompletionStream('openai');
    completion.push(frame({ choices: [{ delta: { content: 'hello', refusal: '' } }] }));
    completion.push(frame({ choices: [{ delta: {}, finish_reason: 'stop' }] }));

    for (const answer of [openai, completion.state()]) {
      expect(answer.stopReason).toBe('end_turn');
      expect(answer.stopDetails).toBeUndefined();
      expect(answer.text).toBe('hello');
    }
  });
});

describe('a stop reason this build has never seen', () => {
  // The Messages API's reasons are a closed, documented list, so an unknown one FAILS CLOSED as
  // a cut-off answer. Chat-completions is a FORMAT many endpoints speak with their own words for
  // "done", and a truncated turn is refused before it is read — so there an unknown reason is
  // reported as unknown and the turn judged by its content (`finish-reason.test.ts`), streamed
  // and not alike.
  test('fails closed on the Anthropic wire; on chat-completions it is unknown, both ways', () => {
    const anthropic = parseMessage(ANTHROPIC_MODEL, {
      content: [],
      stop_reason: 'stopped_for_a_new_reason',
      usage: { input_tokens: 9, output_tokens: 0 },
    });
    const stream = new MessageStream();
    stream.push(
      frame({ type: 'message_delta', delta: { stop_reason: 'stopped_for_a_new_reason' } }),
    );
    const openai = parseChatCompletion(
      { choices: [{ message: { content: 'x' }, finish_reason: 'stopped_for_a_new_reason' }] },
      'openai',
    );
    const completion = new ChatCompletionStream('openai');
    completion.push(frame({ choices: [{ delta: {}, finish_reason: 'stopped_for_a_new_reason' }] }));

    expect(anthropic.stopReason).toBe('max_tokens');
    expect(stream.state().stopReason).toBe('max_tokens');
    expect(openai).toMatchObject({
      stopReason: 'end_turn',
      unknownFinish: 'stopped_for_a_new_reason',
    });
    expect(completion.state()).toMatchObject({
      stopReason: 'end_turn',
      unknownFinish: 'stopped_for_a_new_reason',
    });
  });

  test('a null finish_reason on a streamed delta is still "not finished"', () => {
    const completion = new ChatCompletionStream('openai');
    completion.push(frame({ choices: [{ delta: { content: 'hi' }, finish_reason: null }] }));
    expect(completion.isComplete()).toBe(false);
  });
});

describe('a tool call carries an object or nothing', () => {
  test('arguments that are not an object become {} on every read path', () => {
    // `LlmToolCall.input` is `Record<string, unknown>` and `runLlmToolCall` indexes it, so a
    // string or an array arriving under that type is a lie the type system cannot catch later.
    const anthropic = parseMessage(ANTHROPIC_MODEL, {
      content: [{ type: 'tool_use', id: 'toolu_1', name: 'publishPost', input: 'not-an-object' }],
      stop_reason: 'tool_use',
      usage: {},
    });
    const stream = new MessageStream();
    stream.push(
      frame({
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'tool_use', id: 'toolu_1', name: 'publishPost' },
      }),
    );
    stream.push(
      frame({
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'input_json_delta', partial_json: '"not-an-object"' },
      }),
    );
    stream.push(frame({ type: 'content_block_stop', index: 0 }));
    const completion = new ChatCompletionStream('openai');
    completion.push(
      frame({
        choices: [
          {
            delta: {
              tool_calls: [
                {
                  index: 0,
                  id: 'call_1',
                  function: { name: 'publishPost', arguments: '"not-an-object"' },
                },
              ],
            },
          },
        ],
      }),
    );
    completion.push(frame({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] }));

    expect(anthropic.toolCalls[0]?.input).toEqual({});
    expect(stream.state().toolCalls[0]?.input).toEqual({});
    expect(completion.state().toolCalls[0]?.input).toEqual({});
  });
});

describe('the credential never reaches an error', () => {
  // The provider legs of this rule are `providerTransportConformance`'s (`@ultimat3/testing`); the
  // embedder is no `Provider`, so its leg stays here.
  test('a 4xx body echoing the key is scrubbed by the embedder', async () => {
    const embedder = remoteEmbedder({
      name: 'voyage-3',
      dimension: 2,
      apiKey: KEY,
      fetch: fakeFetch(
        () =>
          new Response(
            JSON.stringify({ error: { message: `rejected header authorization: Bearer ${KEY}` } }),
            { status: 400, headers: { 'content-type': 'application/json' } },
          ),
      ),
    });
    const error = transportError(
      await embedder.embed(['hi']).then(
        () => undefined,
        (failure: unknown) => failure,
      ),
    );
    expect(error.status).toBe(400);
    expect(error.cause).not.toContain(KEY);
    expect(error.message).not.toContain(KEY);
    expect(error.cause).toContain('[redacted]');
  });
});
