// The `Resolver` half of the sealed resolver: an instance asks its own c-ares channel, never
// `Bun.dns`, so each class is sealed on its prototype (a named import shares it). A sealed instance
// answers exactly what the module function of the same name answers — that one is sealed at the root.

// why: `node:dns`'s two `Resolver` classes are what an app's own resolver instance is built from.
import nodeDns from 'node:dns';
import type { DnsGate } from './sealed-dns';

/** Each `Resolver` method and the query its arguments ask; `resolve` names its record type. */
const RESOLVER_QUERIES: Readonly<Record<string, (args: readonly unknown[]) => string>> = {
  resolve: (args) => (typeof args[1] === 'string' ? args[1].toUpperCase() : 'A'),
  resolve4: () => 'A',
  resolve6: () => 'AAAA',
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
};

type Method = (this: unknown, ...args: unknown[]) => unknown;

/** Seal one class's prototype, answering through `moduleApi`; returns the uninstaller. */
const sealPrototype = (prototype: object, moduleApi: object, gate: DnsGate): (() => void) => {
  const originals = new Map<string, Method>();
  for (const [name, queryOf] of Object.entries(RESOLVER_QUERIES)) {
    const original = Reflect.get(prototype, name) as Method;
    const viaModule = Reflect.get(moduleApi, name) as Method;
    originals.set(name, original);
    // A `function`, not an arrow: the real method needs the instance its own servers live on.
    Reflect.set(prototype, name, function sealed(this: unknown, ...args: unknown[]): unknown {
      const verdict = gate(String(args[0]), queryOf(args));
      if ('real' in verdict) return Reflect.apply(original, this, args);
      return Reflect.apply(viaModule, moduleApi, args);
    });
  }
  return () => {
    for (const [name, original] of originals) Reflect.set(prototype, name, original);
  };
};

/** Seal both `Resolver` classes — callback and promise — and return the one uninstaller. */
export function installResolverSeal(gate: DnsGate): () => void {
  const restoreCallback = sealPrototype(nodeDns.Resolver.prototype, nodeDns, gate);
  const restorePromise = sealPrototype(nodeDns.promises.Resolver.prototype, nodeDns.promises, gate);
  return () => {
    restoreCallback();
    restorePromise();
  };
}
