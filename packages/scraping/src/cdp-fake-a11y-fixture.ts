// The raw protocol session of `cdp-fake-fixture.ts`'s page: the commands `cdp-a11y.ts` and
// `cdp-a11y-frame.ts` send, answered in CDP's own wire shapes so their parse is what is under test.
//
// Node ids are minted per `querySelectorAll` and looked up on the way back, as the real protocol
// addresses nodes. A frame is found the way Chrome 157 answers (measured 2026-11-15).

import type { CdpSessionLike } from './cdp-port';
import type { AxNode } from './target';

export type AxBySelector = Readonly<Record<string, readonly AxNode[]>>;

/** One child frame, as the session sees it. `outOfProcess` leaves it out of the page's tree. */
export interface FakeAxFrame {
  readonly name: string;
  readonly url: string;
  readonly accessibility: AxBySelector;
  readonly outOfProcess: boolean;
}

/** Ids for frame `index`: its `<iframe>`, its document's backend node, and the pushed node id. */
const OWNER = 5000;
const DOCUMENT = 6000;
const PUSHED = 7000;

const wrap = (value: string | boolean | undefined): { value?: string | boolean } =>
  value === undefined ? {} : { value };

const numberOf = (params: Record<string, unknown> | undefined, key: string): number | undefined =>
  typeof params?.[key] === 'number' ? params[key] : undefined;

const axAnswer = (node: AxNode | undefined, backend: number): unknown => {
  if (node === undefined) return { nodes: [] };
  const properties = [
    ...(node.focused === undefined ? [] : [{ name: 'focused', value: wrap(node.focused) }]),
    ...(node.disabled === undefined ? [] : [{ name: 'disabled', value: wrap(node.disabled) }]),
  ];
  return {
    nodes: [
      {
        nodeId: `ax-${String(backend)}`,
        ignored: node.ignored,
        role: { type: 'role', ...wrap(node.role) },
        name: { type: 'computedString', ...wrap(node.name) },
        ...(node.description === undefined
          ? {}
          : { description: { type: 'computedString', value: node.description } }),
        ...(node.value === undefined ? {} : { value: { type: 'string', value: node.value } }),
        properties,
      },
    ],
  };
};

export function fakeAxSession(
  page: AxBySelector,
  pageUrl: () => string,
  frames: readonly FakeAxFrame[],
  onDetach: () => void,
): CdpSessionLike {
  const byNodeId = new Map<number, AxNode>();
  // The page's document is node 1; a frame's is the id `DOM.pushNodesByBackendIdsToFrontend` minted.
  const scopeOf = (nodeId: number | undefined): AxBySelector =>
    nodeId === undefined || nodeId < PUSHED ? page : (frames[nodeId - PUSHED]?.accessibility ?? {});
  const answers: Readonly<Record<string, (params?: Record<string, unknown>) => unknown>> = {
    'DOM.getDocument': () => ({ root: { nodeId: 1 } }),
    'Page.getFrameTree': () => ({
      frameTree: {
        frame: { id: 'main', name: '', url: pageUrl() },
        childFrames: frames.flatMap((frame, index) =>
          frame.outOfProcess
            ? []
            : [{ frame: { id: `frame-${String(index)}`, name: frame.name, url: frame.url } }],
        ),
      },
    }),
    'DOM.getFrameOwner': (params) => {
      const id = typeof params?.['frameId'] === 'string' ? params['frameId'] : '';
      return { backendNodeId: OWNER + Number(id.replace('frame-', '')) };
    },
    'DOM.pushNodesByBackendIdsToFrontend': (params) => {
      const ids = Array.isArray(params?.['backendNodeIds']) ? params['backendNodeIds'] : [];
      return { nodeIds: ids.map((id) => PUSHED + (Number(id) - DOCUMENT)) };
    },
    'DOM.querySelectorAll': (params) => {
      const selector = typeof params?.['selector'] === 'string' ? params['selector'] : '';
      const scope = scopeOf(numberOf(params, 'nodeId'));
      const nodes = Object.hasOwn(scope, selector) ? (scope[selector] ?? []) : [];
      return {
        nodeIds: nodes.map((node, index) => {
          const nodeId = 100 + byNodeId.size + index;
          byNodeId.set(nodeId, node);
          return nodeId;
        }),
      };
    },
    'DOM.describeNode': (params) => {
      const owner = numberOf(params, 'backendNodeId');
      if (owner !== undefined)
        return { node: { contentDocument: { backendNodeId: owner + 1000 } } };
      return { node: { backendNodeId: (numberOf(params, 'nodeId') ?? 0) * 10 } };
    },
    'Accessibility.getPartialAXTree': (params) => {
      const backend = numberOf(params, 'backendNodeId') ?? 0;
      return axAnswer(byNodeId.get(backend / 10), backend);
    },
  };
  return {
    send: (method, params) =>
      Promise.resolve(
        (Object.hasOwn(answers, method) ? answers[method] : undefined)?.(params) ?? {},
      ),
    detach: () => {
      onDetach();
      return Promise.resolve();
    },
  };
}
