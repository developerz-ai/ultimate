// TEST-ONLY. A wrapper package the way a stranger publishes one — unscoped `ultimate-<name>`, plain
// ESM JavaScript under `node_modules/`, `@ultimat3/*` as `peerDependencies` at `^<major>` — and an
// app that imports it. `third-party-wrapper.test.ts` writes these files and proves every primitive
// in the package reaches the registries, the manifest and the MCP tool list like the app's own.

/** The package's name: the convention `wiki/Building-Your-Own-Base.md#publish-it` states. */
export const THIRD_PARTY_PACKAGE = 'ultimate-acme-log';
export const THIRD_PARTY_ENTITY = 'acme_log';
export const THIRD_PARTY_ACTION = 'recordAcmeLine';
export const THIRD_PARTY_JOB = 'acme.prune';
/** The permission the package's action asks for, and the app role that grants it. */
export const THIRD_PARTY_PERMISSION = 'acme_log:write';
export const THIRD_PARTY_ROLE = 'archivist';

const PEERS = ['action', 'entity', 'jobs', 'policy', 'schema'] as const;

/** The published package: JavaScript, because a registry tarball ships no TypeScript to run. */
const packageIndex = `import { action } from '@ultimat3/action';
import { entity, text, timestamp, uuid } from '@ultimat3/entity';
import { job } from '@ultimat3/jobs';
import { can } from '@ultimat3/policy';
import { t } from '@ultimat3/schema';

/** The package's factory: every table it builds carries a stamp, declared once. */
export const loggedEntity = (name, init) =>
  entity(name, { ...init, columns: { ...init.columns, loggedAt: timestamp().defaultNow() } });

export const acmeLog = loggedEntity('${THIRD_PARTY_ENTITY}', {
  columns: { id: uuid().primaryKey(), line: text({ max: 200 }) },
});

export const ${THIRD_PARTY_ACTION} = action({
  input: t.object({ line: t.string }),
  output: t.object({ line: t.string }),
  policy: can('${THIRD_PARTY_PERMISSION}'),
  mcp: { expose: true, description: 'Record one line in the acme log.' },
  async handle({ input }) {
    return { line: input.line };
  },
});

export const pruneAcmeLog = job({
  name: '${THIRD_PARTY_JOB}',
  input: t.object({ day: t.string }),
  idempotencyKey: (input) => input.day,
  tenant: 'none',
  retry: { attempts: 1, backoff: 'fixed' },
  run: ({ input }) => ({ pruned: input.day }),
});
`;

/** Every file of the fixture, app-root-relative, for a framework at `major`. */
export function thirdPartyFiles(major: number): Readonly<Record<string, string>> {
  const range = `^${String(major)}.0.0`;
  const peerDependencies = Object.fromEntries(PEERS.map((name) => [`@ultimat3/${name}`, range]));
  return {
    'package.json': JSON.stringify({
      name: 'third-party-consumer',
      version: '1.0.0',
      dependencies: { [THIRD_PARTY_PACKAGE]: '^1.0.0' },
    }),
    'app.config.ts': "export const config = { name: 'third-party-consumer' };\n",
    [`node_modules/${THIRD_PARTY_PACKAGE}/package.json`]: JSON.stringify({
      name: THIRD_PARTY_PACKAGE,
      version: '1.0.0',
      type: 'module',
      exports: { '.': './index.js' },
      keywords: ['ultimate-package'],
      peerDependencies,
    }),
    [`node_modules/${THIRD_PARTY_PACKAGE}/index.js`]: packageIndex,
    // The app's half: re-exports, the way a wrapper is meant to be used. No tier, no plugin call.
    'apps/web/app/acme/entity.ts': `export { acmeLog } from '${THIRD_PARTY_PACKAGE}';\n`,
    'apps/web/app/acme/actions.ts': `export { ${THIRD_PARTY_ACTION} } from '${THIRD_PARTY_PACKAGE}';\n`,
    'apps/web/app/acme/jobs.ts': `export { pruneAcmeLog } from '${THIRD_PARTY_PACKAGE}';\n`,
    'apps/web/app/acme/roles.ts': `import { defineRoles } from '@ultimat3/policy';
export const roles = defineRoles({ ${THIRD_PARTY_ROLE}: { grants: ['${THIRD_PARTY_PERMISSION}'] } });
`,
  };
}

/**
 * The child process's body: one fresh set of registries, loaded the way `x manifest` loads an app,
 * then asked every question a consumer's tooling asks. Prints one `probe:` line of JSON.
 */
export function thirdPartyProbe(cliSrc: string, root: string): string {
  const at = (file: string): string => JSON.stringify(`${cliSrc}/${file}`);
  return `const { appManifest } = await import(${at('app-manifest.ts')});
const { entitiesCommand } = await import(${at('cmd-registries.ts')});
const { agentActor } = await import('@ultimat3/core');
const { exposedPrimitives, mcpServer, toolsFrom } = await import('@ultimat3/mcp');
const { testJobs } = await import('@ultimat3/testing');
const root = ${JSON.stringify(root)};
const { manifest, findings } = await appManifest(root);
const listed = await entitiesCommand.run({
  args: { command: 'entities', subcommand: 'list', positionals: [], flags: new Map(), json: true, help: false, passthrough: [] },
  cwd: root, runner: async () => ({ command: [], code: 0, ok: true, stdout: '', stderr: '', durationMs: 0 }),
  env: {}, bunVersion: Bun.version,
});
const server = mcpServer({ tools: toolsFrom(exposedPrimitives()) });
const as = (roles) => ({ actor: agentActor({ id: 'agent-' + roles.length, roles }), scopes: new Set() });
const call = (id) => ({ jsonrpc: '2.0', id, method: 'tools/call', params: { name: ${JSON.stringify(THIRD_PARTY_ACTION)}, arguments: { line: 'hello' } } });
const tools = await server.handle({ jsonrpc: '2.0', id: 1, method: 'tools/list' }, as([${JSON.stringify(THIRD_PARTY_ROLE)}]));
const refused = await server.handle(call(2), as([]));
const allowed = await server.handle(call(3), as([${JSON.stringify(THIRD_PARTY_ROLE)}]));
const { pruneAcmeLog } = await import(${JSON.stringify(`${root}/node_modules/${THIRD_PARTY_PACKAGE}/index.js`)});
const jobs = await testJobs();
const trace = await jobs(pruneAcmeLog, { day: '2026-11-03' });
await jobs[Symbol.asyncDispose]();
await Bun.write(Bun.stdout, 'probe:' + JSON.stringify({
  findings: findings.map((f) => f.code),
  entities: (listed.data ?? []).map((e) => e.name),
  manifest: {
    entities: manifest.entities.map((e) => e.name),
    actions: manifest.actions.map((a) => a.name),
    jobs: manifest.jobs.map((j) => j.name),
  },
  tools: (tools?.result?.tools ?? []).map((tool) => tool.name),
  refused, allowed,
  runs: trace.executions.map((run) => [run.outcome, run.result]),
}) + '\\n');
`;
}
