// The app graph's public shapes: nodes of a closed vocabulary, dependency edges that each say how
// they are known (`declared`, `import`, `observed`), and what an impact question answers. Types
// and the version only — `graph.ts` builds and walks it.

/** Bumped when a reader built for the old shape would misread the new one. */
export const GRAPH_VERSION = 1;

export const GRAPH_NODE_KINDS = [
  'route',
  'action',
  'mutator',
  'query',
  'job',
  'task',
  'entity',
  'permission',
  'channel',
  'tag',
  'mcpTool',
  'operation',
  'file',
  'test',
] as const;

export type GraphNodeKind = (typeof GRAPH_NODE_KINDS)[number];

/**
 * How an edge is known. `declared`: a registry value states it. `import`: the module graph does.
 * `observed`: a real run did (`x exercise`). An agent decides which of them it trusts.
 */
export type EdgeProvenance = 'declared' | 'import' | 'observed';

export interface GraphNode {
  /** `<kind>:<name>` — `query:postById`, `file:apps/web/app/posts/page.tsx`. */
  readonly id: string;
  readonly kind: GraphNodeKind;
  readonly name: string;
  /** The source file that declares it, when the module graph knows. */
  readonly file?: string;
  /** A route's declared JS budget, when it has one. */
  readonly budget?: string;
}

/** `from` depends on `to`: a change to `to` can change `from`. */
export interface GraphEdge {
  readonly from: string;
  readonly to: string;
  /** `imports`, `declared-in`, `invalidates`, `reads-tag`, `requires`, `enqueues`, `exposes`… */
  readonly rel: string;
  readonly provenance: EdgeProvenance;
}

export interface AppGraph {
  readonly graphVersion: number;
  /** Sorted by id. */
  readonly nodes: readonly GraphNode[];
  /** Sorted by from, to, rel. */
  readonly edges: readonly GraphEdge[];
  /** Files with a computed `import()`: they may depend on anything, so nothing rules them out. */
  readonly opaque: readonly string[];
}

/** One affected node, and every provenance its path to the question carried. */
export interface ImpactEntry {
  readonly id: string;
  readonly name: string;
  readonly provenance: readonly EdgeProvenance[];
}

/** What a change to one node reaches. Each list sorted by id. */
export interface Impact {
  readonly node: string;
  readonly routes: readonly ImpactEntry[];
  readonly actions: readonly ImpactEntry[];
  readonly queries: readonly ImpactEntry[];
  readonly jobs: readonly ImpactEntry[];
  readonly mcpTools: readonly ImpactEntry[];
  /** Non-empty: `contract-diff` will have an opinion about this change. */
  readonly publishedOperations: readonly ImpactEntry[];
  readonly tests: readonly ImpactEntry[];
  /** Routes reached that declare a budget: the `budgets` step weighs them again. */
  readonly budgets: readonly ImpactEntry[];
  /** Opaque files reached or reaching: their dependents are included whatever they import. */
  readonly opaque: readonly string[];
  /** Which provenances were searched to answer. */
  readonly provenance: readonly EdgeProvenance[];
}

/** A path between two nodes, or `null` with what was searched. */
export interface GraphPath {
  readonly from: string;
  readonly to: string;
  readonly edges: readonly GraphEdge[] | null;
  readonly searched: readonly EdgeProvenance[];
}
