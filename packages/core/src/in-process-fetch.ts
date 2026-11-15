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

/** The scope: who answers, and which urls are its to answer (every one, when unsaid). */
interface InProcess {
  readonly fetchImpl: FetchLike;
  readonly owns?: ((url: string) => boolean) | undefined;
}

const scope = asyncContext<InProcess>('the in-process dispatch');

const INSTALLED: unique symbol = Symbol.for('ultimate.in-process-fetch');

/**
 * A `Request` object as the dispatcher's `(url, init)`: its method, headers and body carried, with
 * `init` laid over it as `fetch` itself would — a bare `init ?? {}` sent a POST as a bodyless GET.
 */
async function asInit(input: Request, init: RequestInit | undefined): Promise<RequestInit> {
  const request = init === undefined ? input : new Request(input, init);
  const bodyless = request.method === 'GET' || request.method === 'HEAD';
  return {
    method: request.method,
    headers: request.headers,
    redirect: request.redirect,
    signal: request.signal,
    ...(bodyless ? {} : { body: await request.arrayBuffer() }),
  };
}

/** Wrap `globalThis.fetch` once per process; a re-wrap after someone replaced it wraps theirs. */
function install(): void {
  const current = globalThis.fetch as typeof fetch & { [INSTALLED]?: true };
  if (current[INSTALLED] === true) return;
  const wrapped = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const inProcess = scope.get();
    if (inProcess === undefined) return current(input, init);
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    // A url the scope does not own — another host — goes where it would have gone without one.
    if (inProcess.owns !== undefined && !inProcess.owns(url)) return current(input, init);
    if (typeof input === 'string' || input instanceof URL)
      return inProcess.fetchImpl(url, init ?? {});
    return inProcess.fetchImpl(url, await asInit(input, init));
  };
  globalThis.fetch = Object.assign(wrapped, current, { [INSTALLED]: true as const });
}

/**
 * Run `fn` with every `fetch` inside it — so every `clientTransport` call, `queryClient()` and
 * `rpc()` included — answered by `fetchImpl`: the app's own HTTP pipeline handed a `Request`,
 * rather than the network. `owns` narrows that to the urls it answers true for (the app's own
 * origin); the rest reach the fetch this wrapped. A caller's explicit `fetchImpl` never reaches
 * `globalThis.fetch` at all, so a test's double is never overridden by an ambient scope.
 */
export function withInProcessFetch<T>(
  fetchImpl: FetchLike,
  fn: () => T,
  owns?: (url: string) => boolean,
): T {
  install();
  return scope.run({ fetchImpl, owns }, fn);
}
