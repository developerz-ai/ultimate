// Single responsibility: the one screen a `RenderResult.status` passes before it reaches
// `new Response(body, { status })`, which answers a bare `RangeError` — no code, no fix, no
// `--json` — for anything outside the range it accepts. Its own module because two render modes
// take a status from their caller and a second copy of the rule is how the two drift apart.
// Named for `finiteOption`, and the name is load-bearing: `bun run finite-bounds` recognises a
// repair by the shape of the CALL, so a screen spelled `renderStatus` reads as no screen at all.

import { assert, finiteCount } from '@ultimat3/core';

/**
 * What `new Response` accepts for a document. It also accepts `101`, which is a protocol switch
 * and never a rendered page, so this range is the narrower of the two on purpose.
 */
const MIN_RENDER_STATUS = 200;
const MAX_RENDER_STATUS = 599;

/**
 * `NaN` is the value that gets here: `??` guards NULLISH, so a status read from a config, a JSON
 * body or `Number(process.env.X)` walks past its default intact — and the boundary then reports it
 * as `The status provided (-9223372036854775808)`, which names nothing a caller can act on.
 */
export function finiteStatus(subject: string, status: number): number {
  finiteCount(subject, 'status', status, 0);
  assert(
    status >= MIN_RENDER_STATUS && status <= MAX_RENDER_STATUS,
    `${subject} status is ${String(status)}, which new Response() refuses with a RangeError instead of returning a document`,
    `pass a status between ${String(MIN_RENDER_STATUS)} and ${String(MAX_RENDER_STATUS)} to ${subject}, or omit it and take 200`,
  );
  return status;
}
