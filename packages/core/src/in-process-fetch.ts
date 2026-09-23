// Where a SERVER-side typed call goes when its answer lives in this process. The build's
// measurement render has no server to reach, so a route `load` reading the app's own queries over
// `queryClient()` failed as the network; the process that owns the route table answers instead.
//
// ZERO bytes in a browser, by construction: the transport's dispatch already calls
// `globalThis.fetch` at call time, so this module wraps THAT, once, in the process that first opens
// a scope — and only a server process ever imports this module. Outside a scope the wrapper hands
// every call to the fetch it wrapped, untouched. The first version added a slot read to the
// dispatch itself, and that was 46 B in every island that calls `rpc()` or `queryClient()`.
import { asyncContext } from './async-context';
import type { FetchLike } from './client-dispatch';

const scope = asyncContext<FetchLike>('the in-process dispatch');

const INSTALLED: unique symbol = Symbol.for('ultimate.in-process-fetch');

/** Wrap `globalThis.fetch` once per process; a re-wrap after someone replaced it wraps theirs. */
function install(): void {
  const current = globalThis.fetch as typeof fetch & { [INSTALLED]?: true };
  if (current[INSTALLED] === true) return;
  const wrapped = (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const inProcess = scope.get();
    if (inProcess === undefined) return current(input, init);
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    return inProcess(url, init ?? {});
  };
  globalThis.fetch = Object.assign(wrapped, current, { [INSTALLED]: true as const });
}

/**
 * Run `fn` with every `fetch` inside it — so every `clientTransport` call, `queryClient()` and
 * `rpc()` included — answered by `fetchImpl`: the app's own HTTP pipeline handed a `Request`,
 * rather than the network. A caller's explicit `fetchImpl` never reaches `globalThis.fetch` at all,
 * so a test's double is never overridden by an ambient scope.
 */
export function withInProcessFetch<T>(fetchImpl: FetchLike, fn: () => T): T {
  install();
  return scope.run(fetchImpl, fn);
}
