// `x graph` — the app as one typed graph, or with `--from`/`--to` the chain of edges linking two
// nodes. CLI wiring only: the graph is `@ultimat3/manifest`'s `buildGraph`, loaded by
// `cmd-graph-load.ts`.

import type { GraphNodeKind } from '@ultimat3/manifest';
import { GRAPH_NODE_KINDS, pathBetween } from '@ultimat3/manifest';
import { requireAppRoot } from './app-root';
import { loadAppGraph, resolveNode } from './cmd-graph-load';
import { graphSpec } from './cmd-graph-spec';
import type { CliCommand, CommandContext } from './command';
import { BadFlagError } from './errors';
import { msg } from './messages';
import type { CommandResult, JsonValue } from './output';
import { flagString } from './parse';

const asJson = (value: unknown): JsonValue => JSON.parse(JSON.stringify(value)) as JsonValue;

export const graphCommand: CliCommand = {
  spec: graphSpec,
  async run(ctx: CommandContext): Promise<CommandResult> {
    const root = requireAppRoot('graph', ctx.cwd).dir;
    const from = flagString(ctx.args, 'from');
    const to = flagString(ctx.args, 'to');
    if ((from === undefined) !== (to === undefined)) {
      throw new BadFlagError({
        flag: from === undefined ? 'from' : 'to',
        command: 'graph',
        reason: '--from and --to name the two ends of one path, so each needs the other',
        fix: 'x graph --from query:postById --to entity:posts --json',
      });
    }
    const { graph, findings } = await loadAppGraph(root);
    if (from !== undefined && to !== undefined) {
      const path = pathBetween(graph, resolveNode(graph, from), resolveNode(graph, to));
      return {
        ok: true,
        command: 'graph',
        summary:
          path.edges === null
            ? msg('cli.graph.noPath', {
                from: path.from,
                to: path.to,
                searched: path.searched.join(', '),
              })
            : msg('cli.graph.path', { from: path.from, to: path.to, steps: path.edges.length }),
        lines: (path.edges ?? []).map((edge) =>
          msg('cli.graph.pathStep', { ...edge, provenance: edge.provenance }),
        ),
        data: asJson(path),
      };
    }
    const count = (kind: GraphNodeKind): number =>
      graph.nodes.filter((n) => n.kind === kind).length;
    const provenance = [...new Set(graph.edges.map((edge) => edge.provenance))].sort();
    return {
      ok: true,
      command: 'graph',
      summary: msg('cli.graph.summary', {
        nodes: graph.nodes.length,
        edges: graph.edges.length,
        provenance: provenance.join(', '),
        opaque: graph.opaque.length,
      }),
      lines: [
        ...GRAPH_NODE_KINDS.filter((kind) => count(kind) > 0).map((kind) =>
          msg('cli.graph.kind', { kind, count: count(kind) }),
        ),
        ...findings.map((finding) => `  ${finding.code} ${finding.at ?? ''}`),
      ],
      data: asJson(graph),
    };
  },
};
