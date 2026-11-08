// The resolver half of the sealed network: `Bun.dns.lookup`, `dns.lookup` and `dns.promises.lookup`.
// Only the patching lives here; WHAT a name resolves to is `sealed-network.ts`'s one gate, handed in,
// so a host `fetch` would answer by mock resolves and a host it would refuse does not. A named ESM
// import (`import { lookup } from 'node:dns'`) binds before the seal and is NOT covered (measured).

// why: `dns.lookup` and `dns.promises.lookup` are what an app's own resolver calls; Bun ships both.
import nodeDns from 'node:dns';

/** One lookup's verdict: the addresses to answer, a refusal to raise, or `real` for the resolver. */
export type DnsVerdict =
  | { readonly answer: readonly string[] }
  | { readonly refused: Error }
  | { readonly real: true };

export type DnsGate = (hostname: string) => DnsVerdict;

interface LookupEntry {
  readonly address: string;
  readonly family: number;
}

const familyOf = (address: string): number => (address.includes(':') ? 6 : 4);

const entriesOf = (addresses: readonly string[]): LookupEntry[] =>
  addresses.map((address) => ({ address, family: familyOf(address) }));

type NodeCallback = (error: unknown, address?: unknown, family?: number) => void;

/** Node's `(hostname, options?, callback)`; `options.all` answers the list, a number is a family. */
const wantsAll = (options: unknown): boolean =>
  typeof options === 'object' && options !== null && 'all' in options && options.all === true;

/**
 * Patch the three resolvers and return the uninstaller, which puts back exactly what was there.
 * Assigned through `Reflect.set`: each is a writable data property the types declare a function.
 */
export function installDnsSeal(gate: DnsGate): () => void {
  const originalBun = Reflect.get(Bun.dns, 'lookup') as typeof Bun.dns.lookup;
  const originalNode = Reflect.get(nodeDns, 'lookup') as (...args: unknown[]) => void;
  const originalPromises = Reflect.get(nodeDns.promises, 'lookup') as (
    ...args: unknown[]
  ) => Promise<unknown>;

  const sealedBun = async (hostname: string, options?: unknown): Promise<unknown> => {
    const verdict = gate(hostname);
    if ('refused' in verdict) throw verdict.refused;
    if ('answer' in verdict) return entriesOf(verdict.answer).map((one) => ({ ...one, ttl: 0 }));
    return Reflect.apply(originalBun, Bun.dns, [hostname, options]);
  };

  const sealedNode = (hostname: string, ...rest: unknown[]): void => {
    const verdict = gate(hostname);
    if ('real' in verdict) {
      Reflect.apply(originalNode, nodeDns, [hostname, ...rest]);
      return;
    }
    const callback = rest.findLast((one) => typeof one === 'function') as NodeCallback | undefined;
    const options = rest.length > 1 ? rest[0] : undefined;
    // A real lookup answers on a later tick, and a caller may rely on it: never synchronously.
    queueMicrotask(() => {
      if ('refused' in verdict) return callback?.(verdict.refused);
      const entries = entriesOf(verdict.answer);
      if (wantsAll(options)) return callback?.(null, entries);
      return callback?.(null, entries[0]?.address, entries[0]?.family);
    });
  };

  const sealedPromises = async (hostname: string, options?: unknown): Promise<unknown> => {
    const verdict = gate(hostname);
    if ('refused' in verdict) throw verdict.refused;
    if ('real' in verdict) {
      return Reflect.apply(originalPromises, nodeDns.promises, [hostname, options]);
    }
    const entries = entriesOf(verdict.answer);
    return wantsAll(options) ? entries : entries[0];
  };

  Reflect.set(Bun.dns, 'lookup', sealedBun);
  Reflect.set(nodeDns, 'lookup', sealedNode);
  Reflect.set(nodeDns.promises, 'lookup', sealedPromises);
  return () => {
    Reflect.set(Bun.dns, 'lookup', originalBun);
    Reflect.set(nodeDns, 'lookup', originalNode);
    Reflect.set(nodeDns.promises, 'lookup', originalPromises);
  };
}
