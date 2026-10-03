// Whether a hostname is this machine: `localhost`, a `*.localhost` name (RFC 6761 reserves both
// to loopback) or a loopback address literal. One answer for `x dev`'s Host check and `x doctor`'s
// APP_URL rule, which ask the same question about two different headers.

import { classifyAddress } from '@ultimat3/core';

/** `hostname` as `URL` spells it — `[::1]` bracketed, no port. */
export const isLoopbackHostname = (hostname: string): boolean => {
  const name = hostname.toLowerCase();
  return (
    name === 'localhost' || name.endsWith('.localhost') || classifyAddress(name) === 'loopback'
  );
};
