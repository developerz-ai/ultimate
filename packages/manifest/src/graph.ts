// The app as one typed graph: the manifest's declared facts joined to the module graph's import
// edges (and, when a run recorded them, observed ones). Pure — no registry, no file, no clock:
// the CLI hands in what it loaded. `impactOf` walks dependents; `pathBetween` explains one link.

import type {
  AppGraph,
  EdgeProvenance,
  GraphEdge,
  GraphNode,
  GraphNodeKind,
  GraphPath,
  Impact,
  ImpactEntry,
} from './graph-schema';
import { GRAPH_VERSION } from './graph-schema';
import type { Manifest } from './schema';

/** What the module scan knows: each file's resolved imports, and which file declares what. */
export interface ModuleFacts {
  readonly files: readonly {
    /** App-root-relative POSIX path. */
    readonly path: string;
    /** App-root-relative paths it imports, type-only imports included. */
    readonly imports: readonly string[];
    /** A computed `import()`: it may load any file. */
    readonly opaque: boolean;
    readonly test: boolean;
  }[];
  readonly primitives: readonly {
    readonly kind: 'route' | 'action' | 'query' | 'job' | 'task' | 'entity' | 'channel';
    readonly name: string;
    readonly file: string;
  }[];
}

/** An edge a real run saw: `from` touched `to` (`.x/exercise.json`). */
export interface ObservedEdge {
  readonly from: string;
  readonly to: string;
  readonly rel: string;
}

export const nodeId = (kind: GraphNodeKind, name: string): string => `${kind}:${name}`;

const byText = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

class Builder {
  readonly nodes = new Map<string, GraphNode>();
  readonly edges = new Map<string, GraphEdge>();

  node(kind: GraphNodeKind, name: string, extra: Partial<GraphNode> = {}): string {
    const id = nodeId(kind, name);
    this.nodes.set(id, { ...this.nodes.get(id), id, kind, name, ...extra });
    return id;
  }

  edge(from: string, to: string, rel: string, provenance: EdgeProvenance): void {
    if (from === to) return;
    this.edges.set(`${from}\u0000${to}\u0000${rel}`, { from, to, rel, provenance });
  }
}

function declared(b: Builder, manifest: Manifest): Map<string, string> {
  /** Primitive name → its node id, so the module scan can attach files by name. */
  const ids = new Map<string, string>();
  for (const permission of manifest.permissions) b.node('permission', permission);
  for (const action of manifest.actions) {
    const id = b.node(action.mutator === true ? 'mutator' : 'action', action.name);
    ids.set(`action:${action.name}`, id);
    for (const p of action.permissions) b.edge(id, b.node('permission', p), 'requires', 'declared');
    for (const tag of action.cacheInvalidates) {
      b.edge(id, b.node('tag', tag), 'invalidates', 'declared');
    }
    if (action.mcp.expose) b.edge(b.node('mcpTool', action.name), id, 'exposes', 'declared');
    b.edge(b.node('operation', action.name), id, 'publishes', 'declared');
  }
  for (const query of manifest.queries) {
    const id = b.node('query', query.name);
    ids.set(`query:${query.name}`, id);
    for (const p of query.permissions) b.edge(id, b.node('permission', p), 'requires', 'declared');
    for (const tag of query.cacheTags) b.edge(id, b.node('tag', tag), 'reads-tag', 'declared');
    b.edge(b.node('operation', query.name), id, 'publishes', 'declared');
  }
  for (const route of manifest.routes) {
    const id = b.node(
      'route',
      route.url,
      route.budget?.js === undefined ? {} : { budget: route.budget.js },
    );
    ids.set(`route:${route.url}`, id);
    for (const tag of route.revalidateTags ?? []) {
      b.edge(id, b.node('tag', tag), 'revalidates', 'declared');
    }
  }
  const tables = new Map(manifest.entities.map((entity) => [entity.table, entity.name]));
  for (const entity of manifest.entities) {
    const id = b.node('entity', entity.name);
    ids.set(`entity:${entity.name}`, id);
    for (const column of entity.columns) {
      const target = column.references?.split('.')[0];
      const name = target === undefined ? undefined : (tables.get(target) ?? target);
      if (name !== undefined) b.edge(id, b.node('entity', name), 'references', 'declared');
    }
  }
  for (const channel of manifest.channels ?? []) {
    const id = b.node('channel', channel.name);
    ids.set(`channel:${channel.name}`, id);
    for (const p of channel.permissions)
      b.edge(id, b.node('permission', p), 'requires', 'declared');
    for (const record of channel.records) {
      b.edge(id, b.node('entity', tables.get(record) ?? record), 'reads', 'declared');
    }
  }
  for (const job of manifest.jobs) ids.set(`job:${job.name}`, b.node('job', job.name));
  for (const task of manifest.tasks) {
    const id = b.node('task', task.name);
    ids.set(`task:${task.name}`, id);
    for (const job of task.enqueues) b.edge(id, b.node('job', job), 'enqueues', 'declared');
  }
  return ids;
}

/** The graph: declared facts, then import edges, then what a run observed. Sorted throughout. */
export function buildGraph(
  manifest: Manifest,
  modules?: ModuleFacts,
  observed: readonly ObservedEdge[] = [],
): AppGraph {
  const b = new Builder();
  const ids = declared(b, manifest);
  const tests = new Set((modules?.files ?? []).filter((f) => f.test).map((f) => f.path));
  for (const file of modules?.files ?? []) {
    const id = b.node(file.test ? 'test' : 'file', file.path);
    for (const target of file.imports) {
      b.edge(id, b.node(tests.has(target) ? 'test' : 'file', target), 'imports', 'import');
    }
  }
  for (const primitive of modules?.primitives ?? []) {
    const id =
      ids.get(`${primitive.kind}:${primitive.name}`) ?? b.node(primitive.kind, primitive.name);
    b.nodes.set(id, { ...(b.nodes.get(id) as GraphNode), file: primitive.file });
    b.edge(id, nodeId('file', primitive.file), 'declared-in', 'import');
  }
  for (const edge of observed) {
    if (b.nodes.has(edge.from) && b.nodes.has(edge.to))
      b.edge(edge.from, edge.to, edge.rel, 'observed');
  }
  return {
    graphVersion: GRAPH_VERSION,
    nodes: [...b.nodes.values()].sort((x, y) => byText(x.id, y.id)),
    edges: [...b.edges.values()].sort(
      (x, y) => byText(x.from, y.from) || byText(x.to, y.to) || byText(x.rel, y.rel),
    ),
    opaque: (modules?.files ?? [])
      .filter((file) => file.opaque)
      .map((file) => nodeId(file.test ? 'test' : 'file', file.path))
      .sort(byText),
  };
}

/** Every node that depends on one of `starts`, with the provenances of the path that reached it. */
function dependents(graph: AppGraph, starts: readonly string[]): Map<string, Set<EdgeProvenance>> {
  const into = new Map<string, GraphEdge[]>();
  for (const edge of graph.edges) {
    const list = into.get(edge.to);
    if (list === undefined) into.set(edge.to, [edge]);
    else list.push(edge);
  }
  const reached = new Map<string, Set<EdgeProvenance>>(starts.map((id) => [id, new Set()]));
  const queue = [...starts];
  for (let at = queue.shift(); at !== undefined; at = queue.shift()) {
    const carried = reached.get(at) ?? new Set();
    for (const edge of into.get(at) ?? []) {
      if (reached.has(edge.from)) continue;
      reached.set(edge.from, new Set([...carried, edge.provenance]));
      queue.push(edge.from);
    }
  }
  return reached;
}

/**
 * What a change to `id` reaches: its dependents, transitively. A primitive's own file is a start
 * too — a change to the primitive is a change to it. An opaque file may import anything, so it and
 * its dependents are always in the answer: a superset by construction, never a guess.
 */
export function impactOf(graph: AppGraph, id: string): Impact {
  const node = graph.nodes.find((candidate) => candidate.id === id);
  const starts = [id, ...(node?.file === undefined ? [] : [nodeId('file', node.file)])];
  const reached = dependents(graph, starts);
  const anything = dependents(graph, graph.opaque);
  for (const [opaqueId, provenance] of anything) {
    if (!reached.has(opaqueId)) reached.set(opaqueId, new Set([...provenance, 'import']));
  }
  reached.delete(id);
  const nodes = new Map(graph.nodes.map((n) => [n.id, n]));
  const pick = (kinds: readonly GraphNodeKind[], also: (n: GraphNode) => boolean = () => true) =>
    [...reached]
      .map(([at, provenance]) => ({ node: nodes.get(at), provenance }))
      .filter(
        (entry): entry is { node: GraphNode; provenance: Set<EdgeProvenance> } =>
          entry.node !== undefined && kinds.includes(entry.node.kind) && also(entry.node),
      )
      .map(
        ({ node: n, provenance }): ImpactEntry => ({
          id: n.id,
          name: n.name,
          provenance: [...provenance].sort(byText),
        }),
      )
      .sort((x, y) => byText(x.id, y.id));
  const searched = new Set(graph.edges.map((edge) => edge.provenance));
  return {
    node: id,
    routes: pick(['route']),
    actions: pick(['action', 'mutator']),
    queries: pick(['query']),
    jobs: pick(['job', 'task']),
    mcpTools: pick(['mcpTool']),
    publishedOperations: pick(['operation']),
    tests: pick(['test']),
    budgets: pick(['route'], (n) => n.budget !== undefined),
    opaque: [...graph.opaque],
    provenance: [...searched].sort(byText),
  };
}

/**
 * The shortest chain of edges linking `from` and `to`, each edge crossed in either direction —
 * "this route reads the file this entity is declared in" is a link through two `declared-in`
 * edges pointing opposite ways. `null` when none is known, with the provenances searched.
 */
export function pathBetween(graph: AppGraph, from: string, to: string): GraphPath {
  const searched = [...new Set(graph.edges.map((edge) => edge.provenance))].sort(byText);
  const touching = new Map<string, GraphEdge[]>();
  for (const edge of graph.edges) {
    for (const end of [edge.from, edge.to]) {
      const list = touching.get(end);
      if (list === undefined) touching.set(end, [edge]);
      else list.push(edge);
    }
  }
  const via = new Map<string, { readonly edge: GraphEdge; readonly prev: string } | null>([
    [from, null],
  ]);
  const queue = [from];
  for (let at = queue.shift(); at !== undefined; at = queue.shift()) {
    if (at === to) {
      const chain: GraphEdge[] = [];
      for (let step = via.get(to); step; step = via.get(step.prev)) chain.unshift(step.edge);
      return { from, to, edges: chain, searched };
    }
    for (const edge of touching.get(at) ?? []) {
      const next = edge.from === at ? edge.to : edge.from;
      if (via.has(next)) continue;
      via.set(next, { edge, prev: at });
      queue.push(next);
    }
  }
  return { from, to, edges: null, searched };
}

/**
 * The node a name answers to: an id, a primitive name, or a path. `candidates` are the nearest
 * ids by shared prefix, for a refusal to list.
 */
export function findNode(
  graph: AppGraph,
  text: string,
): { readonly id: string | undefined; readonly candidates: readonly string[] } {
  const exact =
    graph.nodes.find((n) => n.id === text) ??
    graph.nodes.find((n) => n.id === `file:${text}`) ??
    graph.nodes.find((n) => n.id === `test:${text}`);
  if (exact !== undefined) return { id: exact.id, candidates: [] };
  const named = graph.nodes.filter(
    (n) => n.name === text && n.kind !== 'operation' && n.kind !== 'mcpTool',
  );
  if (named.length === 1) return { id: named[0]?.id, candidates: [] };
  const score = (id: string): number => {
    const lower = id.toLowerCase();
    const want = text.toLowerCase();
    if (lower.includes(want)) return 1000 - lower.length;
    let shared = 0;
    while (shared < want.length && lower.includes(want.slice(0, shared + 1))) shared += 1;
    return shared;
  };
  // A projection (`operation:`, `mcpTool:`) shares its primitive's name; the primitive is the answer.
  const primary = graph.nodes.filter((n) => n.kind !== 'operation' && n.kind !== 'mcpTool');
  const candidates = (named.length > 1 ? named : primary)
    .map((n) => n.id)
    .map((id) => ({ id, score: score(id) }))
    .sort((x, y) => y.score - x.score || byText(x.id, y.id))
    .slice(0, 3)
    .map((entry) => entry.id);
  return { id: undefined, candidates };
}
