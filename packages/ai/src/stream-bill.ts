// Single responsibility: what a stream in flight has been billed SO FAR, handed from the provider
// that reads the wire to the gateway that settles the budget — for the streams that never reach
// `done`: abandoned by their consumer, cut, or aborted after the provider's first byte.
//
// Keyed by the request object the gateway passed, and read lazily: no cost per frame.

import type { Billed } from './billed';
import { billedCall } from './billed';
import { exactCostOf } from './cost';
import type { ModelId } from './models';
import type { GenerateRequest } from './provider';
import { estimateInputTokens } from './provider';
import { ZERO_USAGE } from './wire';

const running = new WeakMap<GenerateRequest, () => Billed | undefined>();
/** Requests that left the process, with the model they were priced for. */
const sent = new WeakMap<GenerateRequest, ModelId>();

/** The provider's reader of its running usage, registered once when the stream opens. */
export function trackStreamBill(request: GenerateRequest, read: () => Billed | undefined): void {
  running.set(request, read);
}

/**
 * What the stream for `request` was billed before it stopped — `undefined` when no provider byte
 * arrived (or the provider is one an app wrote, which reports nothing): the reservation goes back.
 */
export function streamBillOf(request: GenerateRequest): Billed | undefined {
  const read = running.get(request);
  if (read === undefined) return undefined;
  try {
    return read();
  } catch {
    return undefined;
  }
}

/** ~4 characters a token, the estimate `estimateTextTokens` uses: output the wire has not counted. */
export const streamedTokens = (chars: number): number => Math.ceil(chars / 4);

/**
 * Called by a provider as its request leaves the process — never for a signal already aborted,
 * which `fetch` refuses without sending a byte. From here an abort is not free: the provider
 * has the prompt, and bills it.
 */
export function trackSent(request: GenerateRequest, model: ModelId): void {
  if (request.signal?.aborted === true) return;
  sent.set(request, model);
}

/** The prompt's estimate, priced, for a request that was sent — `undefined` for one never sent. */
export function sentBillOf(request: GenerateRequest): Billed | undefined {
  const model = sent.get(request);
  if (model === undefined) return undefined;
  const usage = { ...ZERO_USAGE, inputTokens: estimateInputTokens(request) };
  return billedCall(usage, exactCostOf(model, usage));
}
