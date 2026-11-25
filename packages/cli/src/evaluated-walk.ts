// What importing a set of modules EVALUATES, walked breadth first with the path to each module
// kept — so a finding about a module deep in the graph can name how it was reached. Two callers:
// the load's explanation of an import that failed inside a package (`app-load-import-chain.ts`)
// and the gate's check of what a role loads (`app-dev-imports.ts`). Never in a healthy boot.

import { importedSpecifiers, resolveImport } from './module-imports';

/** One static import, as the module at `from` spells it. `target` resolves it when it is asked. */
export interface EvaluatedImport {
  readonly from: string;
  readonly specifier: string;
  target(): string | undefined;
}

/** `follow` walks the import's target, `skip` leaves it, `stop` ends the walk with it as the end. */
export type WalkVerdict = 'follow' | 'skip' | 'stop';

/** A module on a chain, and how the one before it spelled it — absent on the start. */
export interface ChainStep {
  readonly path: string;
  readonly specifier?: string;
}

export interface EvaluatedWalk {
  /** Start first, `path` last: the shortest way there. Empty for a module the walk never reached. */
  chainTo(path: string): readonly ChainStep[];
}

export interface EvaluatedGraph {
  walk(
    starts: readonly string[],
    judge: (edge: EvaluatedImport) => WalkVerdict,
  ): Promise<EvaluatedWalk>;
}

/** One graph, however many walks: a module is read and parsed once, whoever reaches it. */
export function createEvaluatedGraph(): EvaluatedGraph {
  const edges = new Map<string, readonly EvaluatedImport[]>();

  async function edgesOf(path: string): Promise<readonly EvaluatedImport[]> {
    const known = edges.get(path);
    if (known !== undefined) return known;
    // Unreadable (a builtin, an asset Bun resolves elsewhere): no edge, as an unparseable file has.
    const source = await Bun.file(path)
      .text()
      .catch(() => '');
    const found = importedSpecifiers(path, source, 'evaluated').map(
      (specifier): EvaluatedImport => {
        let resolved: { readonly path: string | undefined } | undefined;
        return {
          from: path,
          specifier,
          target() {
            resolved ??= { path: resolveImport(specifier, path) };
            return resolved.path;
          },
        };
      },
    );
    edges.set(path, found);
    return found;
  }

  return {
    async walk(starts, judge) {
      const via = new Map<string, EvaluatedImport | undefined>(
        starts.map((start): [string, undefined] => [start, undefined]),
      );
      const reached = [...via.keys()];
      walking: for (const path of reached) {
        for (const edge of await edgesOf(path)) {
          const verdict = judge(edge);
          if (verdict === 'skip') continue;
          const target = edge.target();
          if (target !== undefined && !via.has(target)) {
            via.set(target, edge);
            reached.push(target);
          }
          if (verdict === 'stop') break walking;
        }
      }
      return {
        chainTo(path) {
          if (!via.has(path)) return [];
          const chain: ChainStep[] = [];
          for (let at: string | undefined = path; at !== undefined; ) {
            const edge: EvaluatedImport | undefined = via.get(at);
            chain.unshift({
              path: at,
              ...(edge === undefined ? {} : { specifier: edge.specifier }),
            });
            at = edge?.from;
          }
          return chain;
        },
      };
    },
  };
}
