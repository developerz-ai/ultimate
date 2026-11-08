// The resolver half of the sealed network: every `Bun.dns` resolution function, which is the ROOT
// every `node:dns` module function calls at call time — so a named import bound before the seal is
// sealed too (`sealed-dns-paths.test.ts`). `Resolver` instances: `sealed-dns-resolver.ts`. WHAT a
// name resolves to is `sealed-network.ts`'s one gate, handed in.

import { installResolverSeal } from './sealed-dns-resolver';

/** One query's verdict: the addresses to answer, a refusal to raise, or `real` for the resolver. */
export type DnsVerdict =
  | { readonly answer: readonly string[] }
  | { readonly refused: Error }
  | { readonly real: true };

/** `LOOKUP` (getaddrinfo), `REVERSE` (an address to its names) or a record type: `A`, `MX`, … */
export type DnsGate = (name: string, query: string) => DnsVerdict;

/**
 * The queries an address list can answer. A mock declares an HTTP endpoint, not a zone: an MX or
 * TXT answer would be invented, so the gate answers only these and refuses the rest.
 */
export const ADDRESS_QUERIES: ReadonlySet<string> = new Set(['LOOKUP', 'A', 'ANY']);

const familyOf = (address: string): number => (address.includes(':') ? 6 : 4);

/** The raw shape `Bun.dns` answers per query; `node:dns` maps it as it maps a real one. */
const shaped = (query: string, addresses: readonly string[]): unknown[] =>
  addresses.map((address) => {
    if (query === 'LOOKUP') return { address, family: familyOf(address), ttl: 0 };
    if (query === 'ANY') return { address, ttl: 0, type: familyOf(address) === 6 ? 'AAAA' : 'A' };
    return { address, ttl: 0 };
  });

/** Each async `Bun.dns` resolver and the query its arguments ask. */
const BUN_QUERIES: Readonly<Record<string, (args: readonly unknown[]) => string>> = {
  lookup: () => 'LOOKUP',
  resolve: (args) => (typeof args[1] === 'string' ? args[1].toUpperCase() : 'A'),
  resolveAny: () => 'ANY',
  resolveCaa: () => 'CAA',
  resolveCname: () => 'CNAME',
  resolveMx: () => 'MX',
  resolveNaptr: () => 'NAPTR',
  resolveNs: () => 'NS',
  resolvePtr: () => 'PTR',
  resolveSoa: () => 'SOA',
  resolveSrv: () => 'SRV',
  resolveTxt: () => 'TXT',
  reverse: () => 'REVERSE',
  lookupService: () => 'REVERSE',
};

type Resolve = (...args: unknown[]) => Promise<unknown>;

/**
 * Patch every resolver and return the uninstaller, which puts back exactly what was there.
 * Assigned through `Reflect.set`: each is a writable data property the types declare a function.
 */
export function installDnsSeal(gate: DnsGate): () => void {
  const originals = new Map<string, unknown>();
  for (const [name, queryOf] of Object.entries(BUN_QUERIES)) {
    const original = Reflect.get(Bun.dns, name) as Resolve;
    originals.set(name, original);
    const sealed: Resolve = async (...args) => {
      const query = queryOf(args);
      const verdict = gate(String(args[0]), query);
      if ('refused' in verdict) throw verdict.refused;
      if ('answer' in verdict) return shaped(query, verdict.answer);
      return Reflect.apply(original, Bun.dns, args);
    };
    Reflect.set(Bun.dns, name, sealed);
  }
  // `prefetch` is synchronous and answers nothing: a mocked name has nothing to warm, and an
  // unmocked one throws here rather than hide the egress until the dial that follows it.
  const originalPrefetch = Reflect.get(Bun.dns, 'prefetch') as (...args: unknown[]) => void;
  originals.set('prefetch', originalPrefetch);
  Reflect.set(Bun.dns, 'prefetch', (...args: unknown[]): void => {
    const verdict = gate(String(args[0]), 'LOOKUP');
    if ('refused' in verdict) throw verdict.refused;
    if ('real' in verdict) Reflect.apply(originalPrefetch, Bun.dns, args);
  });
  const restoreResolver = installResolverSeal(gate);
  return () => {
    for (const [name, original] of originals) Reflect.set(Bun.dns, name, original);
    restoreResolver();
  };
}
