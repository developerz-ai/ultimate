#!/usr/bin/env bun
// Enforce, as a build error, that every `ADAPTER_PORTS` row (packages/core/src/registrar.ts) ships
// whole: a `RuntimeOverrides` field, a boot binding, its interface (and installer) on the package's
// `./adapter`, a `<x>Conformance` on `@ultimat3/testing/conformance` and a `wiki/Adapters.md`
// section — and that no backend is swapped any other way: no `set*`/`configure*`/`install*` on a
// `.` barrel, no port-shaped type on a `./adapter` that no row lists (`X_ADAPTER_PORT_INCOMPLETE`).
//
// WHAT IT READS: text (`lib/adapter-port-facts.ts`). WHAT IT CANNOT SEE: a backend selected under a
// name that is neither installer- nor port-shaped — a floor, not a proof. Parts still being built
// are pinned, each with a reason, in `lib/adapter-port-pins.ts`; a pin that excuses nothing reds.
//
//   bun run scripts/adapter-ports.ts [--json] [--write]

import { renderFixShellArg } from '../packages/core/src/error-render';
import { ADAPTER_PORTS, type AdapterPort } from '../packages/core/src/registrar';
import {
  ADAPTERS_PAGE,
  type AdapterPortFacts,
  CONFORMANCE_PACKAGE,
  PORT_BINDINGS_FILES,
  RUNTIME_OVERRIDES,
  readAdapterPortFacts,
} from './lib/adapter-port-facts';
import {
  BARREL_INSTALLERS,
  BARREL_UNSCANNED,
  PENDING_PARTS,
  PORT_MEMBERS,
  PORT_PARTS,
  PORT_SHAPED,
  type PortPart,
} from './lib/adapter-port-pins';
import {
  CONFORMANCE_SUBJECTS,
  PORT_REFERENCES,
  type PortReference,
} from './lib/adapter-port-references';
import { PAGE_COMMAND, renderAdaptersPage } from './lib/adapters-page';
import { flagBool, parseScriptArgs } from './lib/args';
import type { Finding, ScriptResult } from './lib/log';
import { report } from './lib/log';
import { repoRoot } from './lib/run';

const SCRIPT = 'adapter-ports';
const CODE = 'X_ADAPTER_PORT_INCOMPLETE';
const PINS = 'scripts/lib/adapter-port-pins.ts';
const CHECK = 'bun run scripts/adapter-ports.ts --json';
const INSTALL_PHASES = new Set(['boot', 'queue', 'services']);

/** The declared tables, injectable so a fixture is judged on its own pins. */
export interface AdapterPortPins {
  readonly pending: Readonly<Record<string, string>>;
  readonly barrel: Readonly<Record<string, string>>;
  readonly unscanned: Readonly<Record<string, string>>;
  readonly members: Readonly<Record<string, string>>;
  readonly references: Readonly<Record<string, PortReference>>;
  readonly subjects: Readonly<Record<string, string>>;
}

export const REPO_TABLES: AdapterPortPins = {
  pending: PENDING_PARTS,
  barrel: BARREL_INSTALLERS,
  unscanned: BARREL_UNSCANNED,
  members: PORT_MEMBERS,
  references: PORT_REFERENCES,
  subjects: CONFORMANCE_SUBJECTS,
};

/** One port's five parts: `true`, or why it is missing. */
export type PortStatus = AdapterPort & {
  readonly parts: Readonly<Record<PortPart, true | string>>;
};

const dirOf = (pkg: string): string => `packages/${pkg.replace('@ultimat3/', '')}`;
const kebab = (name: string): string => name.replace(/([a-z0-9])([A-Z])/g, '$1-$2').toLowerCase();

function adapterPart(row: AdapterPort, facts: AdapterPortFacts): true | string {
  const pkg = facts.packages[row.pkg];
  if (pkg?.adapterEntry === undefined) return `${row.pkg} has no ./adapter subpath`;
  if (!pkg.adapterTypes.includes(row.interface)) {
    return `${pkg.adapterEntry} does not export ${row.interface}`;
  }
  const binding = facts.bindings[row.port];
  if (binding !== undefined && INSTALL_PHASES.has(binding.phase)) {
    if (!binding.installerFrom.includes(`${row.pkg}/adapter`)) {
      return `the boot installs ${row.port} with ${binding.detail || 'an installer'} from ${binding.installerFrom.join(', ') || 'no import'}, not from ${row.pkg}/adapter`;
    }
  }
  return true;
}

/** Every part of every row, judged against the facts alone (pins do not change a status). */
export function portStatuses(
  ports: readonly AdapterPort[],
  facts: AdapterPortFacts,
  rendered: string,
): readonly PortStatus[] {
  return ports.map((row) => {
    const binding = facts.bindings[row.port];
    const header = `## ${row.port}\n`;
    const at = rendered.indexOf(header);
    const next = rendered.indexOf('\n## ', at + header.length);
    const section = at < 0 ? '' : rendered.slice(at, next < 0 ? undefined : next);
    const parts: Record<PortPart, true | string> = {
      field: Object.hasOwn(facts.fields, row.port) || `PortValues has no ${row.port} field`,
      binding:
        binding === undefined
          ? `no binding for ${row.port}`
          : binding.phase === 'pending' || binding.phase === 'unbound'
            ? `binding is ${binding.phase}${binding.detail === '' ? '' : `: ${binding.detail}`}`
            : true,
      adapter: adapterPart(row, facts),
      conformance:
        facts.conformance.includes(row.conformance) ||
        `${CONFORMANCE_PACKAGE}/conformance does not export ${row.conformance}`,
      docs:
        (section !== '' && facts.page?.includes(section) === true) ||
        `${ADAPTERS_PAGE} has no current section for ${row.port}`,
    };
    return { ...row, parts };
  });
}

function partFix(row: AdapterPort, part: PortPart, facts: AdapterPortFacts): string {
  const entry = facts.packages[row.pkg]?.adapterEntry;
  switch (part) {
    case 'field':
      return `readonly ${row.port}: ${row.interface};   // in interface PortValues, ${RUNTIME_OVERRIDES}; then bind it in ${PORT_BINDINGS_FILES[0]}; then ${CHECK}`;
    case 'binding':
      return `${row.port}: { phase: 'services', install: (value) => install${row.interface}(value) },   // in PORT_BINDINGS, ${PORT_BINDINGS_FILES[0]} (or phase: 'read', at: '<the module that reads it>'); then ${CHECK}`;
    case 'adapter':
      return entry === undefined
        ? `"./adapter": "./src/adapter.ts"   // in ${dirOf(row.pkg)}/package.json exports, and export type { ${row.interface} } from './<file>'; in ${dirOf(row.pkg)}/src/adapter.ts; then ${CHECK}`
        : `export type { ${row.interface} } from './<file>';   // in ${entry}, beside its install*/reset* — the boot imports the installer from '${row.pkg}/adapter'; then ${CHECK}`;
    case 'conformance':
      return `export { ${row.conformance} } from './${kebab(row.interface)}-conformance';   // in packages/testing/src/conformance.ts; then ${CHECK}`;
    case 'docs':
      return PAGE_COMMAND;
  }
}

function partFindings(
  statuses: readonly PortStatus[],
  facts: AdapterPortFacts,
  pins: AdapterPortPins,
): Finding[] {
  const findings: Finding[] = [];
  for (const row of statuses) {
    for (const part of PORT_PARTS) {
      const status = row.parts[part];
      const key = `${row.port}#${part}`;
      const pinned = Object.hasOwn(pins.pending, key);
      if (status === true && pinned) {
        findings.push({
          code: CODE,
          at: PINS,
          cause: `PENDING_PARTS pins ${key}, but that part now exists — the ratchet must tighten, or the next regression of it is excused`,
          fix: `${PAGE_COMMAND}   # after deleting the '${key}' row of PENDING_PARTS in ${PINS}`,
        });
      } else if (status !== true && !pinned) {
        findings.push({
          code: CODE,
          at: part === 'docs' ? ADAPTERS_PAGE : `${row.pkg}#${row.port}`,
          cause: `adapter port ${row.port} (${row.interface}, ${row.pkg}) is missing its ${part}: ${status}`,
          fix: partFix(row, part, facts),
        });
      }
    }
  }
  return findings;
}

function barrelFindings(facts: AdapterPortFacts, pins: AdapterPortPins): Finding[] {
  const findings: Finding[] = [];
  const seen = new Set<string>();
  for (const pkg of Object.values(facts.packages)) {
    if (Object.hasOwn(pins.unscanned, pkg.name)) continue;
    for (const name of pkg.barrelInstallers) {
      const key = `${pkg.name}#${name}`;
      seen.add(key);
      if (Object.hasOwn(pins.barrel, key)) continue;
      findings.push({
        code: CODE,
        at: `${dirOf(pkg.name)}/src/index.ts`,
        cause: `${pkg.name} exports ${name} from its . barrel: a backend swapped by a call from app code runs after the boot captured its own, so it is the second way to swap one — every port is a runtime.ts field`,
        fix: `export { ${renderFixShellArg(name, '<the installer>')} } from './<file>';   // in ${dirOf(pkg.name)}/src/adapter.ts, removed from ${dirOf(pkg.name)}/src/index.ts — or, if it selects no backend, a '${key}' row with its reason in BARREL_INSTALLERS, ${PINS}`,
      });
    }
  }
  for (const key of Object.keys(pins.barrel)) {
    if (seen.has(key)) continue;
    findings.push({
      code: CODE,
      at: PINS,
      cause: `BARREL_INSTALLERS names ${key}, which no scanned barrel exports — the row excuses nothing`,
      fix: `${CHECK}   # after deleting the '${key}' row of BARREL_INSTALLERS in ${PINS}`,
    });
  }
  return findings;
}

function memberFindings(
  ports: readonly AdapterPort[],
  facts: AdapterPortFacts,
  pins: AdapterPortPins,
): Finding[] {
  const findings: Finding[] = [];
  const listed = new Set(ports.map((row) => `${row.pkg}#${row.interface}`));
  const seen = new Set<string>();
  for (const pkg of Object.values(facts.packages)) {
    for (const type of pkg.adapterTypes) {
      if (!PORT_SHAPED.test(type)) continue;
      const key = `${pkg.name}#${type}`;
      seen.add(key);
      if (listed.has(key) || Object.hasOwn(pins.members, key)) continue;
      findings.push({
        code: CODE,
        at: pkg.adapterEntry ?? pkg.name,
        cause: `${pkg.adapterEntry} exports ${type}, a backend-shaped interface no ADAPTER_PORTS row lists — an app can implement it and has no runtime.ts field to hand it over`,
        fix: `{ port: '<name>', pkg: '${pkg.name}', interface: '${type}', envDefault: '<default>', conformance: '<${type}>Conformance' },   // a row in ADAPTER_PORTS, packages/core/src/registrar.ts — or a '${key}' row naming the port it belongs to in PORT_MEMBERS, ${PINS}`,
      });
    }
  }
  for (const key of Object.keys(pins.members)) {
    if (seen.has(key)) continue;
    findings.push({
      code: CODE,
      at: PINS,
      cause: `PORT_MEMBERS names ${key}, which no ./adapter subpath exports — the row excuses nothing`,
      fix: `${CHECK}   # after deleting the '${key}' row of PORT_MEMBERS in ${PINS}`,
    });
  }
  return findings;
}

function referenceFindings(
  ports: readonly AdapterPort[],
  facts: AdapterPortFacts,
  pins: AdapterPortPins,
): Finding[] {
  return ports.flatMap((row) => {
    const ref = pins.references[row.port];
    if (ref !== undefined && facts.declared(ref.file, ref.symbol)) return [];
    return [
      {
        code: CODE,
        at: PINS,
        cause: `PORT_REFERENCES.${row.port} names ${ref === undefined ? 'nothing' : `${ref.symbol} in ${ref.file}`}, which ${ref === undefined ? 'leaves its page section no reference' : 'that file does not export'} — the page would send an author to copy code that is not there`,
        fix: `${PAGE_COMMAND}   # after pointing PORT_REFERENCES.${row.port} in scripts/lib/adapter-port-references.ts at the file that exports the reference`,
      },
    ];
  });
}

/** The whole verdict over one set of facts. */
export function adapterPortResult(
  ports: readonly AdapterPort[],
  facts: AdapterPortFacts,
  pins: AdapterPortPins = REPO_TABLES,
): ScriptResult & { readonly rendered: string } {
  const rendered = renderAdaptersPage({
    ports,
    references: pins.references,
    subjects: pins.subjects,
    bindings: facts.bindings,
    fields: facts.fields,
    pending: (port, part) => Object.hasOwn(pins.pending, `${port}#${part}`),
  });
  const statuses = portStatuses(ports, facts, rendered);
  const findings = [
    ...partFindings(statuses, facts, pins),
    ...barrelFindings(facts, pins),
    ...memberFindings(ports, facts, pins),
    ...referenceFindings(ports, facts, pins),
  ];
  if (facts.page !== rendered && !findings.some((one) => one.at === ADAPTERS_PAGE)) {
    findings.push({
      code: CODE,
      at: ADAPTERS_PAGE,
      cause: `${ADAPTERS_PAGE} is not what ADAPTER_PORTS, PORT_REFERENCES and the ratchet render — it was edited by hand or a row moved without it`,
      fix: PAGE_COMMAND,
    });
  }
  const whole = statuses.filter((row) => PORT_PARTS.every((part) => row.parts[part] === true));
  return {
    ok: findings.length === 0,
    script: SCRIPT,
    summary:
      findings.length === 0
        ? `${ports.length} ports, ${whole.length} whole, the rest pinned with a reason`
        : `${findings.length} adapter port finding(s)`,
    findings,
    data: { ports: statuses, pending: Object.keys(pins.pending).length },
    rendered,
  };
}

const referenceFiles = (pins: AdapterPortPins): readonly string[] =>
  Object.values(pins.references).map((ref) => ref.file);

/** The rule as a host check, for `scripts/verify.ts`'s `boundaries` step. */
export async function adapterPortFindings(root: string): Promise<readonly Finding[]> {
  const facts = await readAdapterPortFacts(root, referenceFiles(REPO_TABLES));
  return adapterPortResult(ADAPTER_PORTS, facts).findings ?? [];
}

if (import.meta.main) {
  const args = parseScriptArgs(Bun.argv.slice(2));
  const root = repoRoot();
  let facts = await readAdapterPortFacts(root, referenceFiles(REPO_TABLES));
  if (flagBool(args, 'write')) {
    await Bun.write(`${root}/${ADAPTERS_PAGE}`, adapterPortResult(ADAPTER_PORTS, facts).rendered);
    facts = await readAdapterPortFacts(root, referenceFiles(REPO_TABLES));
  }
  const { rendered: _rendered, ...result } = adapterPortResult(ADAPTER_PORTS, facts);
  report(result, args.json);
}
