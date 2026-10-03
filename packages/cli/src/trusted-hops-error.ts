// The refusal of a malformed `TRUSTED_PROXY_HOPS` — its own code, never `X_PORT_INVALID`: a proxy
// count is not a port, and an operator told "is not a TCP port number" looked for the wrong setting.

import { UltimateError } from '@ultimat3/core';
import { MAX_PROXY_HOPS } from '@ultimat3/http';
import { quoteArg } from './shell-quote';

export class TrustedProxyHopsInvalidError extends UltimateError {
  constructor(input: { readonly value: string }) {
    super({
      code: 'X_TRUSTED_PROXY_HOPS_INVALID',
      cause: `TRUSTED_PROXY_HOPS=${quoteArg(input.value)} is not a whole number of proxies from 1 to ${MAX_PROXY_HOPS} — the count that append to x-forwarded-for in front of this process; unset means none`,
      fix: 'TRUSTED_PROXY_HOPS=1 ROLE=web bun apps/web/server.ts',
      meta: { value: input.value, max: MAX_PROXY_HOPS },
    });
  }
}
