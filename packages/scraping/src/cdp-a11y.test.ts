// `axNodesFor` over a scripted session: the four protocol calls it makes, in order, with the
// parameters CDP expects — and the parse of `Accessibility.getPartialAXTree`'s wire shape, which
// wraps every computed field in `{ type, value }` and carries `focused`/`disabled` as a list.

import { describe, expect, test } from 'bun:test';
import { axNodesFor } from './cdp-a11y';
import type { CdpSessionLike } from './cdp-port';

interface Scripted {
  readonly session: CdpSessionLike;
  /** `method params-as-json`, in order. */
  readonly calls: readonly string[];
}

/** A session answering each method from a table, recording what it was asked. */
const scripted = (answers: Readonly<Record<string, (params: unknown) => unknown>>): Scripted => {
  const calls: string[] = [];
  return {
    calls,
    session: {
      send: (method, params) => {
        calls.push(`${method} ${JSON.stringify(params ?? null)}`);
        const answer = Object.hasOwn(answers, method) ? answers[method] : undefined;
        return Promise.resolve(answer === undefined ? {} : answer(params));
      },
      detach: () => Promise.resolve(),
    },
  };
};

const axTree = (node: Record<string, unknown>) => ({ nodes: [node] });

const wired = (
  trees: Readonly<Record<string, Record<string, unknown>>>,
  nodeIds: readonly number[],
): Scripted =>
  scripted({
    'DOM.getDocument': () => ({ root: { nodeId: 1, nodeName: '#document' } }),
    'DOM.querySelectorAll': () => ({ nodeIds }),
    'DOM.describeNode': (params) => {
      const nodeId = (params as { nodeId: number }).nodeId;
      return { node: { nodeId, backendNodeId: nodeId * 10, nodeName: 'BUTTON' } };
    },
    'Accessibility.getPartialAXTree': (params) => {
      const backend = (params as { backendNodeId: number }).backendNodeId;
      const key = String(backend);
      return Object.hasOwn(trees, key) ? axTree(trees[key] ?? {}) : { nodes: [] };
    },
  });

describe('unit · axNodesFor', () => {
  test('walks document → matches → backend id → partial tree, with the parameters CDP expects', async () => {
    const { session, calls } = wired(
      {
        '70': {
          nodeId: 'ax-7',
          ignored: false,
          role: { type: 'role', value: 'button' },
          name: { type: 'computedString', value: 'Run search' },
        },
      },
      [7],
    );
    expect(await axNodesFor(session, '#go', 25)).toEqual([
      { role: 'button', name: 'Run search', ignored: false },
    ]);
    expect(calls).toEqual([
      'DOM.getDocument {"depth":0}',
      'DOM.querySelectorAll {"nodeId":1,"selector":"#go"}',
      'DOM.describeNode {"nodeId":7}',
      'Accessibility.getPartialAXTree {"backendNodeId":70,"fetchRelatives":false}',
    ]);
  });

  test('description, value and the focused/disabled properties are unwrapped', async () => {
    const { session } = wired(
      {
        '70': {
          ignored: false,
          role: { type: 'role', value: 'slider' },
          name: { type: 'computedString', value: 'Volume' },
          description: { type: 'computedString', value: 'Loudness of playback' },
          // A number on the wire: what a reader is TOLD is text.
          value: { type: 'integer', value: 7 },
          properties: [
            { name: 'focused', value: { type: 'boolean', value: true } },
            { name: 'disabled', value: { type: 'boolean', value: false } },
            // A property this package does not read is not an error.
            { name: 'level', value: { type: 'integer', value: 2 } },
          ],
        },
      },
      [7],
    );
    expect(await axNodesFor(session, 'input', 25)).toEqual([
      {
        role: 'slider',
        name: 'Volume',
        description: 'Loudness of playback',
        value: '7',
        focused: true,
        disabled: false,
        ignored: false,
      },
    ]);
  });

  test('a node the browser computed nothing for answers empty role and name — never a guess', async () => {
    const { session } = wired({ '70': { ignored: false } }, [7]);
    expect(await axNodesFor(session, 'div', 25)).toEqual([{ role: '', name: '', ignored: false }]);
  });

  test('a match with NO tree node at all is recorded as ignored, so the count is the match count', async () => {
    const { session } = wired({}, [7]);
    expect(await axNodesFor(session, 'template', 25)).toEqual([
      { role: '', name: '', ignored: true },
    ]);
  });

  test('max bounds the per-node round trips, in document order', async () => {
    const { session, calls } = wired(
      {
        '10': { ignored: false, role: { value: 'listitem' }, name: { value: 'One' } },
        '20': { ignored: false, role: { value: 'listitem' }, name: { value: 'Two' } },
        '30': { ignored: false, role: { value: 'listitem' }, name: { value: 'Three' } },
      },
      [1, 2, 3],
    );
    const nodes = await axNodesFor(session, 'li', 2);
    expect(nodes.map((node) => node.name)).toEqual(['One', 'Two']);
    expect(calls.filter((call) => call.startsWith('DOM.describeNode'))).toHaveLength(2);
  });

  test('no match is an empty answer after two calls, never a refusal', async () => {
    const { session, calls } = wired({}, []);
    expect(await axNodesFor(session, '#nothing', 25)).toEqual([]);
    expect(calls).toHaveLength(2);
  });

  test('an answer that does not match the wire shape is X_VALIDATION_FAILED', async () => {
    const { session } = scripted({ 'DOM.getDocument': () => ({ document: { id: 1 } }) });
    let code: string | undefined;
    await axNodesFor(session, '#go', 25).catch((thrown: unknown) => {
      code = (thrown as { code?: string }).code;
    });
    expect(code).toBe('X_VALIDATION_FAILED');
  });
});
