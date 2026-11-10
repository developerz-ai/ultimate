// `wiki/Adapters.md`, rendered: one section per `ADAPTER_PORTS` row — the interface, the memory
// reference to copy, the conformance one-liner and the `runtime.ts` line — from the table, the
// reference map and the ratchet. Generated so a row cannot be added, renamed or finished without
// the page moving with it; `scripts/adapter-ports.ts --write` writes it, its check refuses drift.

import type { AdapterPort } from '../../packages/core/src/registrar';
import type { BindingFact } from './adapter-port-facts';
import type { PortPart } from './adapter-port-pins';
import type { PortReference } from './adapter-port-references';

const BLOB = 'https://github.com/developerz-ai/ultimate/blob/main';
export const PAGE_COMMAND = 'bun run scripts/adapter-ports.ts --write';

export interface PageInput {
  readonly ports: readonly AdapterPort[];
  readonly references: Readonly<Record<string, PortReference>>;
  /** What each suite's subject thunk answers (`CONFORMANCE_SUBJECTS`). */
  readonly subjects: Readonly<Record<string, string>>;
  readonly bindings: Readonly<Record<string, BindingFact>>;
  /** `RuntimeOverrides` field → the type it takes (the `storage` field takes `Storage`, not its row's interface). */
  readonly fields: Readonly<Record<string, string>>;
  /** Whether `<port>#<part>` is still on the ratchet. */
  readonly pending: (port: string, part: PortPart) => boolean;
}

const INTRO = `# Adapters

<!-- generated: ${PAGE_COMMAND} — from ADAPTER_PORTS in packages/core/src/registrar.ts; the boundaries step refuses an edit by hand (X_ADAPTER_PORT_INCOMPLETE) -->

Every backend an app may swap is an **adapter port**: one row of \`ADAPTER_PORTS\` (\`packages/core/src/registrar.ts\`), one field of \`apps/web/runtime.ts\`. That file is the ONE place a backend is swapped — no setter on a package barrel, no env switch beside the default, no plugin API. Leave a field out and the boot builds the default the row names from the environment.

Writing your own adapter is four steps, the same for every port:

1. **Implement** the interface, imported from the owning package's \`/adapter\` subpath.
2. **Copy** the in-repo reference below — the memory one, where one ships.
3. **Prove** it: \`behavesLike(<suite>, () => subject)\` in a test, the suite from \`@ultimat3/testing/conformance\`, \`behavesLike\` from \`@ultimat3/testing\`. The subject is your adapter, or — where a check needs more than the port to observe it — the suite's own \`<X>Subject\` object around it; each section below names its fields.
4. **Wire** it: one field of \`apps/web/runtime.ts\`, which \`x dev\` and the container both read before a port is bound.

\`\`\`ts
import type { RuntimeOverrides } from '@ultimat3/cli/serve';
import { memoryJobDriver } from '@ultimat3/jobs';

export const runtime = {
  jobs: memoryJobDriver(),
} satisfies RuntimeOverrides;
\`\`\`

\`runtime.ts\` runs BEFORE its own ports are installed: import no app module that seals a secret or builds auth at module scope. In a test, \`await swapAdapter(port, impl)\` from \`@ultimat3/testing\` installs one for that test alone, through the same installer the boot calls; a port it cannot swap is listed in its \`UNSWAPPED\` with what a test does instead.

\`bun run scripts/adapter-ports.ts --json\` lists every port with its five parts; a part missing is \`X_ADAPTER_PORT_INCOMPLETE\` on the \`boundaries\` step. A part marked *pending* below is on that guard's ratchet (\`scripts/lib/adapter-port-pins.ts\`) and is being built.
`;

function bootLine(binding: BindingFact | undefined, pending: boolean): string {
  if (binding === undefined) return '*pending*: the boot does not honour this field yet';
  if (binding.phase === 'pending' || pending) return `*pending*: ${binding.detail}`;
  if (binding.phase === 'read') return `read as a value by \`${binding.detail}\``;
  return `installed by \`${binding.detail}\` (${binding.phase} phase)`;
}

function section(input: PageInput, row: AdapterPort): string {
  const pending = (part: PortPart) => input.pending(row.port, part);
  const ref = input.references[row.port];
  const copy =
    ref === undefined
      ? '*none named*'
      : `[\`${ref.symbol}\`](${BLOB}/${ref.file}) in \`${ref.file}\`${ref.note === undefined ? '' : ` — ${ref.note}`}`;
  const iface = pending('adapter')
    ? `\`${row.interface}\` from \`${row.pkg}\` — its \`/adapter\` export is *pending*`
    : `\`${row.interface}\` from \`${row.pkg}/adapter\``;
  const prove = `\`behavesLike(${row.conformance}, () => ${input.subjects[row.port] ?? 'yourAdapter'})\`${pending('conformance') ? ' — *pending*: the suite is not on `@ultimat3/testing/conformance` yet' : ''}`;
  const fieldType = input.fields[row.port];
  const wire =
    pending('field') || fieldType === undefined
      ? `*pending*: not a \`runtime.ts\` field yet`
      : `\`${row.port}: …\` in \`apps/web/runtime.ts\`, typed \`${fieldType}\``;
  return [
    `## ${row.port}`,
    '',
    '| Part | Value |',
    '|---|---|',
    `| Interface | ${iface} |`,
    `| Default | ${row.envDefault} |`,
    `| Copy | ${copy} |`,
    `| Prove | ${prove} |`,
    `| Wire | ${wire} |`,
    `| Boot | ${bootLine(input.bindings[row.port], pending('binding'))} |`,
    '',
  ].join('\n');
}

/** The whole page, deterministic: table order, which is sorted by port name. */
export function renderAdaptersPage(input: PageInput): string {
  const index = input.ports
    .map(
      (row) =>
        `| [\`${row.port}\`](#${row.port.toLowerCase()}) | \`${row.interface}\` | \`${row.pkg}\` |`,
    )
    .join('\n');
  return [
    INTRO,
    '| Port | Interface | Package |',
    '|---|---|---|',
    index,
    '',
    ...input.ports.map((row) => section(input, row)),
  ].join('\n');
}
