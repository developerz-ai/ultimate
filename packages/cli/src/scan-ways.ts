// Every way the boot scan has into each module holding a development import: the holder itself when
// it is scanned, else one chain per scanned edge towards it through modules outside the scan. One
// pass backwards from all the holders at once, each module read once per distance it is reached at
// and not once per holder: helpers that reconverge carry every holder below them together.

import type { ChainStep, EvaluatedImport } from './evaluated-walk';

/** A set of holders, one bit each: what reached a module together is moved and compared at once. */
type Holders = bigint;

/** The holders exactly `distance` imports below a module. */
interface Below {
  readonly distance: number;
  readonly holders: Holders;
}

/** One import of a module's, and the holders it is the first step of the shortest way to. */
interface Hop {
  readonly edge: EvaluatedImport;
  readonly target: string;
  readonly holders: Holders;
}

/** `edges` by `key`, in the order given: a module's own stay in the order it writes them. */
function indexed(
  edges: readonly EvaluatedImport[],
  key: (edge: EvaluatedImport) => string | undefined,
): ReadonlyMap<string, readonly EvaluatedImport[]> {
  const index = new Map<string, EvaluatedImport[]>();
  for (const edge of edges) {
    const at = key(edge);
    if (at === undefined) continue;
    const known = index.get(at);
    if (known === undefined) index.set(at, [edge]);
    else known.push(edge);
  }
  return index;
}

/** How far below each module outside the scan every holder is, shortest way. */
function distances(
  bits: ReadonlyMap<string, Holders>,
  scanned: ReadonlySet<string>,
  into: ReadonlyMap<string, readonly EvaluatedImport[]>,
): ReadonlyMap<string, readonly Below[]> {
  const below = new Map<string, Below[]>();
  const reached = new Map(bits);
  let frontier: ReadonlyMap<string, Holders> = bits;
  for (let distance = 0; frontier.size > 0; distance += 1) {
    const next = new Map<string, Holders>();
    for (const [path, holders] of frontier) {
      const known = below.get(path);
      if (known === undefined) below.set(path, [{ distance, holders }]);
      else known.push({ distance, holders });
      for (const { from } of into.get(path) ?? []) {
        if (scanned.has(from)) continue;
        const had = reached.get(from) ?? 0n;
        const fresh = holders & ~had;
        if (fresh === 0n) continue;
        reached.set(from, had | fresh);
        next.set(from, (next.get(from) ?? 0n) | fresh);
      }
    }
    frontier = next;
  }
  return below;
}

/**
 * The ways into each of `holders` over the app's followed `edges`. Shortest, and of two as short the
 * one the module higher up imports first. Never through a scanned module: its own edge is the cut.
 */
export function scanWays(
  holders: readonly string[],
  scanned: ReadonlySet<string>,
  edges: readonly EvaluatedImport[],
): (holder: string) => readonly (readonly ChainStep[])[] {
  const outside = [...new Set(holders)].filter((holder) => !scanned.has(holder));
  const bits = new Map(
    outside.map((holder, index): [string, Holders] => [holder, 1n << BigInt(index)]),
  );
  const below = distances(
    bits,
    scanned,
    indexed(edges, (edge) => edge.target()),
  );
  const onward = indexed(edges, (edge) => edge.from);
  const hops = new Map<string, readonly Hop[]>();

  /** Told once per module, whichever chains pass through it. */
  function hopsOf(path: string): readonly Hop[] {
    const known = hops.get(path);
    if (known !== undefined) return known;
    let left = (below.get(path) ?? []).reduce((all, one) => all | one.holders, 0n);
    const found: Hop[] = [];
    for (const edge of onward.get(path) ?? []) {
      if (left === 0n) break;
      const target = edge.target();
      if (target === undefined) continue;
      const closer = below.get(target) ?? [];
      let nearer = 0n;
      for (const { distance, holders: here } of below.get(path) ?? []) {
        const there = closer.find((one) => one.distance === distance - 1);
        if (there !== undefined) nearer |= here & there.holders;
      }
      // A holder an earlier import already leads to is that one's.
      if ((nearer & left) === 0n) continue;
      left &= ~nearer;
      found.push({ edge, target, holders: nearer });
    }
    hops.set(path, found);
    return found;
  }

  /** From a module the holder is below, down to it: the steps after the module itself. */
  function down(from: string, bit: Holders): readonly ChainStep[] {
    const steps: ChainStep[] = [];
    const hopAt = (path: string): Hop | undefined =>
      hopsOf(path).find((hop) => (hop.holders & bit) !== 0n);
    for (let hop = hopAt(from); hop !== undefined; hop = hopAt(hop.target)) {
      steps.push({ path: hop.target, specifier: hop.edge.specifier });
    }
    return steps;
  }

  /** The scanned edges into the modules each holder is below. */
  const cuts = edges.flatMap((edge): (Hop & { readonly from: string })[] => {
    const { from } = edge;
    const target = scanned.has(from) ? edge.target() : undefined;
    const reach = target === undefined ? [] : (below.get(target) ?? []);
    const all = reach.reduce((sum, one) => sum | one.holders, 0n);
    return target === undefined || all === 0n ? [] : [{ from, edge, target, holders: all }];
  });

  return (holder) => {
    if (scanned.has(holder)) return [[{ path: holder }]];
    const bit = bits.get(holder) ?? 0n;
    return cuts
      .filter((cut) => (cut.holders & bit) !== 0n)
      .map(({ from, edge, target }) => [
        { path: from },
        { path: target, specifier: edge.specifier },
        ...down(target, bit),
      ]);
  };
}
