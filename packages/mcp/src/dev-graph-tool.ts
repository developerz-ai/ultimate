// `graph.query` — `x impact` and `x graph --from --to` as one dev tool: what an edit to a file or a
// primitive reaches, or the chain linking two nodes. The graph is `@ultimat3/manifest`'s, a tier
// this package may not import, so the CLI answers through `DevCapabilities.queryGraph`.

import type { AnyMcpTool, ToolArgs } from './registry';
import { jsonResult, textResult } from './registry';

/** One question of the app graph: `impact` of one node, or the `path` between two. */
export type DevGraphQuestion =
  | { readonly kind: 'impact'; readonly node: string }
  | { readonly kind: 'path'; readonly from: string; readonly to: string };

export interface DevGraphHost {
  /** `x impact <node> --json`'s data, or `x graph --from --to --json`'s. Throws on an unknown node. */
  queryGraph(question: DevGraphQuestion): Promise<unknown>;
}

const ASK =
  'graph.query takes { node } for what a change to it reaches, or { from, to } for the path between two — e.g. { "node": "apps/web/app/posts/queries/post-by-id.ts" }';

/** The question the arguments ask, or `undefined` for a combination that asks none. */
export function graphQuestion(args: ToolArgs): DevGraphQuestion | undefined {
  const text = (key: string): string | undefined => {
    const value = args[key];
    return typeof value === 'string' && value.trim() !== '' ? value : undefined;
  };
  const node = text('node');
  const from = text('from');
  const to = text('to');
  if (node !== undefined && from === undefined && to === undefined) return { kind: 'impact', node };
  if (node === undefined && from !== undefined && to !== undefined) {
    return { kind: 'path', from, to };
  }
  return undefined;
}

export function graphTool(host: DevGraphHost, scope: string): AnyMcpTool {
  return {
    name: 'graph.query',
    description:
      'What a change reaches, before it is made: { node } (a file path, a primitive name or a node id) ' +
      'answers the routes, actions, queries, jobs, MCP tools, published operations, tests and budgets ' +
      'that depend on it, each with the provenance of the edges that reached it; { from, to } answers ' +
      'the chain of edges linking two nodes. The same graph as `x impact` and `x graph`.',
    scope,
    destructive: false,
    inputSchema: {
      type: 'object',
      properties: {
        node: { type: 'string', description: 'A file path, a primitive name or a node id.' },
        from: { type: 'string', description: 'One end of a path; needs `to`.' },
        to: { type: 'string', description: 'The other end of a path; needs `from`.' },
      },
      additionalProperties: false,
    },
    async handle(args: ToolArgs) {
      const question = graphQuestion(args);
      if (question === undefined) return textResult(ASK, true);
      return jsonResult(await host.queryGraph(question));
    },
  };
}
