// `allowHosts` matching is `@ultimat3/core`'s (`host-rules.ts`), shared with `x shot`'s browser;
// re-exported here so this package's own modules and its public names are unchanged.
export type { HostDecision, HostRule } from '@ultimat3/core';
export { ANY_HOST, hostDecision, hostMatches } from '@ultimat3/core';
