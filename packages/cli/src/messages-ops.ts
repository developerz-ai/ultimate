// The `x token`, `x config`, `x logs`, `x cache` and `x explain` rows of the CLI catalog
// (`messages.ts` composes them): what each operator command found or did. Data only.

export const OPS_MESSAGES = {
  'cli.token.created': 'issued {prefix} with {count} scope(s) — the token is printed once, below',
  'cli.token.plaintext': '  {token}',
  'cli.token.once': '  shown once: only its hash is stored, and no command prints it again',
  'cli.token.listed': '{count} token(s) owned by {owner}',
  'cli.token.row': '  {prefix}  {scopes}  {state}',
  'cli.token.revoked': 'revoked {at}',
  'cli.token.noExpiry': 'no expiry',
  'cli.token.expires': 'expires {at}',
  'cli.token.revokedOne': 'revoked {id} — the next request that presents it is refused',
  'cli.token.notLive': 'no live token has the id {id} — nothing to revoke',
  'cli.config.show': '{name}: {count} config section(s), defaults merged, from {path}',
  'cli.config.section': '{section}, defaults merged, from {path}',
  'cli.logs.tail': '{count} line(s) from the end of {path}',
  'cli.cache.graph': '{tags} tag(s); {stale} read and never invalidated by an action',
  'cli.cache.graphRow': '  {tag}: written by {writers} · read by {readers}',
  'cli.cache.busted': 'busted {tags} tag(s) here and on every replica listening on {bus}',
  'cli.cache.bustedLocal':
    'busted {tags} tag(s) in this process only: the bus is in-process, so no running server heard it — set NATS_URL or REDIS_URL, or bust from /_x',
  'cli.cache.tierRow': '  {tier}: {keys} key(s) dropped',
  'cli.explain.served': '{query}: {planned} statement(s) planned, each served by a declared index',
  'cli.explain.red': '{query}: {count} read(s) no declared index serves',
  'cli.explain.unplannable':
    '{query}: the dev database could not plan it — x db migrate first if its tables are missing',
  'cli.explain.none':
    '{query}: sent no statement — its rows come from memory or a provider that reads no table',
  'cli.explain.exempt': '  may scan: {reason}',
  'cli.explain.refused': '  not planned: {reason}',
} as const;
