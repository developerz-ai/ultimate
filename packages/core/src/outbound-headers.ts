/**
 * The trace and request-budget headers a SERVER-side typed call carries onward, installed into the
 * transport's slot by the code that makes them meaningful — `runWithContext` and `startSpan` — and
 * never at import. A browser runs neither, so its slot stays empty and `clientTransport` carries
 * zero bytes of telemetry, context or logger: that graph was 12.9 kB of every island that called
 * `rpc()` or `queryClient()`, for a header a browser never has a value for.
 */

import { traceHeaders } from './client-wire';
import { outboundSlot } from './record-sink';

/** Idempotent: the first call fills the slot, every later one is a property read. */
export function installTraceHeaders(): void {
  const slot = outboundSlot();
  if (slot.outboundHeaders === undefined) slot.outboundHeaders = traceHeaders;
}
