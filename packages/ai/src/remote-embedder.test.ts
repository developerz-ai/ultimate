import { describe, expect, test } from 'bun:test';
import { cosine } from './embeddings';
import { RemoteEmbedder } from './remote-embedder';

interface Call {
  readonly url: string;
  readonly headers: Record<string, string>;
  readonly body: { model?: string; input?: string[] };
}

function fakeFetch(calls: Call[], reply: (call: Call, index: number) => Response): typeof fetch {
  const impl = async (input: unknown, init?: RequestInit): Promise<Response> => {
    calls.push({
      url: String(input),
      headers: { ...(init?.headers as Record<string, string> | undefined) },
      body: JSON.parse(String(init?.body ?? '{}')) as Call['body'],
    });
    return reply(calls[calls.length - 1] as Call, calls.length - 1);
  };
  return impl as unknown as typeof fetch;
}

/** A provider reply whose vectors encode their own input index, so order is checkable. */
function embeddingsFor(inputs: readonly string[], start: number): Response {
  return Response.json({
    data: inputs.map((_text, offset) => ({
      object: 'embedding',
      index: offset,
      embedding: [start + offset, 0],
    })),
  });
}

function embedder(calls: Call[], reply: (call: Call, index: number) => Response, dimension = 2) {
  return new RemoteEmbedder({
    name: 'voyage-3',
    dimension,
    apiKey: 'key-1',
    baseUrl: 'https://embeddings.test/v1',
    batchSize: 2,
    fetch: fakeFetch(calls, reply),
  });
}

describe('RemoteEmbedder', () => {
  test('posts { model, input } with a bearer key and returns one vector per text', async () => {
    const calls: Call[] = [];
    const vectors = await embedder(calls, (call) => embeddingsFor(call.body.input ?? [], 1)).embed([
      'a',
      'b',
    ]);

    expect(calls[0]?.url).toBe('https://embeddings.test/v1/embeddings');
    expect(calls[0]?.headers['authorization']).toBe('Bearer key-1');
    expect(calls[0]?.body).toEqual({ model: 'voyage-3', input: ['a', 'b'] });
    expect(vectors).toHaveLength(2);
  });

  test('L2 normalises, so cosine stays a dot product whatever the provider returns', async () => {
    const calls: Call[] = [];
    const [vector] = await embedder(calls, () =>
      Response.json({ data: [{ index: 0, embedding: [3, 4] }] }),
    ).embed(['a']);

    expect(vector?.[0]).toBeCloseTo(0.6, 6);
    expect(vector?.[1]).toBeCloseTo(0.8, 6);
    expect(cosine(vector ?? new Float32Array(), vector ?? new Float32Array())).toBeCloseTo(1, 6);
  });

  test('honours the provider index rather than array position', async () => {
    const calls: Call[] = [];
    const vectors = await embedder(calls, () =>
      Response.json({
        data: [
          { index: 1, embedding: [0, 1] },
          { index: 0, embedding: [1, 0] },
        ],
      }),
    ).embed(['first', 'second']);

    // Reordered rows written straight through would be a silent relevance collapse.
    expect([...(vectors[0] ?? [])]).toEqual([1, 0]);
    expect([...(vectors[1] ?? [])]).toEqual([0, 1]);
  });

  test('splits a corpus into batches and keeps global order', async () => {
    const calls: Call[] = [];
    const vectors = await embedder(calls, (call, index) =>
      embeddingsFor(call.body.input ?? [], index * 2 + 1),
    ).embed(['a', 'b', 'c', 'd', 'e']);

    expect(calls.map((call) => call.body.input)).toEqual([['a', 'b'], ['c', 'd'], ['e']]);
    expect(vectors.map((vector) => vector[0])).toEqual([1, 1, 1, 1, 1]);
    expect(vectors).toHaveLength(5);
  });

  test('an empty batch never leaves the process', async () => {
    const calls: Call[] = [];
    expect(await embedder(calls, () => Response.json({ data: [] })).embed([])).toEqual([]);
    expect(calls).toHaveLength(0);
  });

  test('a width other than the declared one is X_VECTOR_DIM_MISMATCH, not a silent write', async () => {
    const calls: Call[] = [];
    const failure = await embedder(calls, () =>
      Response.json({ data: [{ index: 0, embedding: [1, 2, 3] }] }),
    )
      .embed(['a'])
      .catch((error: unknown) => error);

    expect(failure).toMatchObject({ code: 'X_VECTOR_DIM_MISMATCH' });
    expect((failure as { fix: string }).fix).toContain('dimension: 3');
  });

  test('a short reply is a transport failure — a missing vector must not shift the rest', async () => {
    const calls: Call[] = [];
    await expect(
      embedder(calls, () => Response.json({ data: [{ index: 0, embedding: [1, 0] }] })).embed([
        'a',
        'b',
      ]),
    ).rejects.toMatchObject({ code: 'X_AI_PROVIDER_UNAVAILABLE' });
  });

  test('a non-numeric component is a transport failure, never NaN in the store', async () => {
    const calls: Call[] = [];
    await expect(
      embedder(calls, () => Response.json({ data: [{ index: 0, embedding: [1, null] }] })).embed([
        'a',
      ]),
    ).rejects.toMatchObject({ code: 'X_AI_PROVIDER_UNAVAILABLE' });
  });

  test('a non-2xx carries its status', async () => {
    const calls: Call[] = [];
    const failure = await embedder(calls, () => new Response('too many requests', { status: 429 }))
      .embed(['a'])
      .catch((error: unknown) => error);

    expect(failure).toMatchObject({ code: 'X_AI_PROVIDER_UNAVAILABLE', status: 429 });
  });

  test('no key names the env var instead of reaching the network', async () => {
    const calls: Call[] = [];
    const keyless = new RemoteEmbedder({
      name: 'voyage-3',
      dimension: 2,
      apiKey: '',
      fetch: fakeFetch(calls, () => Response.json({ data: [] })),
    });

    await expect(keyless.embed(['a'])).rejects.toMatchObject({ code: 'X_AI_KEY_MISSING' });
    expect(calls).toHaveLength(0);
  });
});
