// The app graph `x graph`, `x impact` and the dev MCP server's `graph.query` read: the app loaded
// once (`appManifest`), its module graph scanned, and the last `x exercise` run's effects added as
// `observed` edges. Rebuilt per call — a graph committed anywhere would churn on every import.

// why: Bun ships no path-join primitive.
import { join } from 'node:path';
import { renderCauseValue, UltimateError } from '@ultimat3/core';
import type { AppGraph, ObservedEdge } from '@ultimat3/manifest';
import { buildGraph, findNode, MANIFEST_FILENAME } from '@ultimat3/manifest';
import { appManifest } from './app-manifest';
import { moduleFiles, primitiveFiles } from './app-module-graph';
import type { Finding } from './output';

/** Where `x exercise` writes what each primitive did. */
export const EXERCISE_REPORT = '.x/exercise.json';

interface ExerciseRecord {
  readonly kind?: unknown;
  readonly name?: unknown;
  readonly effects?: unknown;
}

/**
 * `.x/exercise.json` as edges: a primitive that wrote or read an entity's table, or enqueued a
 * job. Ignored when it is older than `x.manifest.json` — the run described an earlier app — or
 * unreadable: observed edges are a bonus over declared ones, never a requirement.
 */
export async function observedEdges(
  root: string,
  tables: ReadonlyMap<string, string>,
): Promise<readonly ObservedEdge[]> {
  const report = Bun.file(join(root, EXERCISE_REPORT));
  const manifest = Bun.file(join(root, MANIFEST_FILENAME));
  if (!(await report.exists())) return [];
  if ((await manifest.exists()) && report.lastModified < manifest.lastModified) return [];
  let parsed: unknown;
  try {
    parsed = await report.json();
  } catch {
    // A torn write from a run still in progress: no observed edges this time.
    return [];
  }
  const records = (parsed as { readonly records?: unknown }).records;
  if (!Array.isArray(records)) return [];
  const edges: ObservedEdge[] = [];
  for (const record of records as readonly ExerciseRecord[]) {
    if (typeof record.kind !== 'string' || typeof record.name !== 'string') continue;
    const from = `${record.kind}:${record.name}`;
    for (const effect of Array.isArray(record.effects) ? record.effects : []) {
      const { kind, entity, op, job } = effect as Readonly<Record<string, unknown>>;
      if (kind === 'row' && typeof entity === 'string') {
        const to = `entity:${tables.get(entity) ?? entity}`;
        edges.push({ from, to, rel: op === 'select' ? 'reads' : 'writes' });
      } else if (kind === 'enqueue' && typeof job === 'string') {
        edges.push({ from, to: `job:${job}`, rel: 'enqueues' });
      }
    }
  }
  return edges;
}

export interface LoadedGraph {
  readonly graph: AppGraph;
  /** Modules that would not load: the graph describes what did. */
  readonly findings: readonly Finding[];
}

export async function loadAppGraph(root: string): Promise<LoadedGraph> {
  const { manifest, findings } = await appManifest(root);
  const files = await moduleFiles(root);
  const primitives = await primitiveFiles(
    root,
    files.map((file) => file.path),
  );
  const tables = new Map(manifest.entities.map((entity) => [entity.table, entity.name]));
  const graph = buildGraph(manifest, { files, primitives }, await observedEdges(root, tables));
  return { graph, findings };
}

/** A name that is no node of the graph, with the three nearest to pick from. */
export class GraphNodeUnknownError extends UltimateError {
  constructor(input: { readonly asked: string; readonly candidates: readonly string[] }) {
    super({
      code: 'X_GRAPH_NODE_UNKNOWN',
      cause: `${renderCauseValue(input.asked)} is no node of the app graph (nearest: ${input.candidates.join(', ') || 'none'})`,
      fix: 'x graph --json   # every node id is in data.nodes; pass one of them, a primitive name or a file path',
      meta: { asked: input.asked, candidates: [...input.candidates] },
    });
  }
}

/** The node `text` names, or the refusal listing the nearest three. */
export function resolveNode(graph: AppGraph, text: string): string {
  const { id, candidates } = findNode(graph, text.replace(/^\.\//, ''));
  if (id === undefined) throw new GraphNodeUnknownError({ asked: text, candidates });
  return id;
}
