// `x shot`'s per-selector accessibility read, over a scripted session: one partial-tree call per
// match, at most `max`, read by `@ultimat3/testing`'s one node reader — unchanged through its move.

import { describe, expect, test } from 'bun:test';
import type { SessionSend } from './cdp-shot-a11y';
import { axNodesFor } from './cdp-shot-a11y';

const answers: Record<string, (params: Record<string, unknown>) => Record<string, unknown>> = {
  'DOM.getDocument': () => ({ root: { nodeId: 1 } }),
  'DOM.querySelectorAll': () => ({ nodeIds: [10, 11, 12] }),
  'DOM.describeNode': (params) => ({ node: { backendNodeId: Number(params['nodeId']) + 100 } }),
  'Accessibility.getPartialAXTree': (params) =>
    params['backendNodeId'] === 110
      ? {
          nodes: [
            {
              ignored: false,
              role: { type: 'role', value: 'button' },
              name: { value: 'Save' },
              description: { value: 'stores it' },
              value: { value: 3 },
              properties: [
                { name: 'focused', value: { value: true } },
                { name: 'disabled', value: { value: false } },
              ],
            },
          ],
        }
      : { nodes: [] },
};

const scripted = (): { send: SessionSend; methods: string[] } => {
  const methods: string[] = [];
  return {
    methods,
    send: (method, params = {}) => {
      methods.push(method);
      return Promise.resolve(answers[method]?.(params));
    },
  };
};

describe('axNodesFor', () => {
  test('reads each match’s own node, every field a reader is told', async () => {
    const { send } = scripted();
    expect(await axNodesFor(send, 'button', 1)).toEqual([
      {
        role: 'button',
        name: 'Save',
        description: 'stores it',
        value: '3',
        focused: true,
        disabled: false,
        ignored: false,
      },
    ]);
  });

  test('an element that never entered the tree is kept, as ignored, so the count is the matches', async () => {
    const { send, methods } = scripted();
    const nodes = await axNodesFor(send, 'button', 2);
    expect(nodes[1]).toEqual({ role: '', name: '', ignored: true });
    expect(methods.filter((m) => m === 'Accessibility.getPartialAXTree')).toHaveLength(2);
  });
});
