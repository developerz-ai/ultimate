// The `x client`, `x graph` and `x impact` rows of the CLI catalog (`messages.ts` composes them):
// what a generation wrote, what the app graph holds, what a change reaches. Data only.

export const CLIENT_MESSAGES = {
  'cli.client.vendor.written':
    '{name}: {operations} operation(s), {types} type(s) compiled from {source} into {dir}',
  'cli.client.customer.written':
    '{operations} operation(s), {types} type(s) compiled from {source} into {dir}',
  'cli.client.file': '  wrote {path}',
  'cli.graph.summary': '{nodes} node(s), {edges} edge(s) ({provenance}); {opaque} opaque file(s)',
  'cli.graph.kind': '  {kind}: {count}',
  'cli.graph.path': '{from} → {to} in {steps} step(s)',
  'cli.graph.pathStep': '  {from} —{rel} ({provenance})→ {to}',
  'cli.graph.noPath': 'no known path between {from} and {to} (searched: {searched})',
  'cli.impact.summary':
    '{node} reaches {routes} route(s), {actions} action(s), {queries} query(ies), {jobs} job(s), {tests} test(s)',
  'cli.impact.published':
    '  published: {operations} — contract-diff will have an opinion about this change',
  'cli.impact.section': '  {section}: {names}',
  'cli.affected.tests': '{count} test file(s) in this app import a changed file, transitively',
  'cli.affected.testsAll':
    'every test file in this app: {files} changed and no import says who reads it',
} as const;
