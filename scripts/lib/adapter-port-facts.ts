// What the tree says about each `ADAPTER_PORTS` row, read as text: the `RuntimeOverrides` fields,
// the boot's bindings, every package's `./adapter` and `.` exports, the conformance subpath and
// the generated wiki page. Text, never an import of the packages, so the guard still loads while a
// package is mid-edit. `scripts/adapter-ports.ts` judges these facts; nothing here decides.

import { maskLiterals, stripComments } from '../../packages/core/src/source-mask';

export const RUNTIME_OVERRIDES = 'packages/cli/src/runtime-overrides.ts';
export const PORT_BINDINGS_FILES = [
  'packages/cli/src/runtime-port-bindings.ts',
  'packages/cli/src/runtime-port-bindings-queue.ts',
] as const;
export const CONFORMANCE_PACKAGE = '@ultimat3/testing';
export const CONFORMANCE_SUBPATH = './conformance';
export const ADAPTERS_PAGE = 'wiki/Adapters.md';

/** Where the boot honours a port: `pending` (no installer yet), `read` (a value) or an install phase. */
export interface BindingFact {
  readonly phase: string;
  /** The owner a pending row names, the reader a read row names, or the installer(s) called. */
  readonly detail: string;
  /** Every module an installed binding takes its installer from (static or dynamic import). */
  readonly installerFrom: readonly string[];
}

export interface PackageFact {
  readonly name: string;
  /** Repo-relative entry of `exports['./adapter']`, when the package has one. */
  readonly adapterEntry?: string | undefined;
  readonly adapterTypes: readonly string[];
  readonly adapterValues: readonly string[];
  /** `set*` / `configure*` / `install*` names the `.` entry exports. */
  readonly barrelInstallers: readonly string[];
}

export interface AdapterPortFacts {
  /** `RuntimeOverrides` field → the type it takes. */
  readonly fields: Readonly<Record<string, string>>;
  readonly bindings: Readonly<Record<string, BindingFact>>;
  readonly packages: Readonly<Record<string, PackageFact>>;
  /** Value names `@ultimat3/testing/conformance` exports; empty while the subpath is absent. */
  readonly conformance: readonly string[];
  /** `file#symbol` → whether `file` declares `symbol` (the references the page cites). */
  readonly declared: (file: string, symbol: string) => boolean;
  readonly page?: string | undefined;
}

export interface ExportedNames {
  readonly types: readonly string[];
  readonly values: readonly string[];
}

const DECLARED_VALUE =
  /\bexport\s+(?:declare\s+)?(?:async\s+)?(?:function\s*\*?|const|let|var|class)\s+([A-Za-z_$][\w$]*)/g;
const DECLARED_TYPE = /\bexport\s+(?:declare\s+)?(?:interface|type)\s+([A-Za-z_$][\w$]*)/g;
const LISTED = /\bexport\s+(type\s+)?\{([^}]*)\}/g;

/** Every name one module exports, split into types and values; `masked` has strings blanked. */
export function exportedNames(masked: string): ExportedNames {
  const types = new Set<string>();
  const values = new Set<string>();
  for (const match of masked.matchAll(DECLARED_VALUE)) values.add(match[1] ?? '');
  for (const match of masked.matchAll(DECLARED_TYPE)) types.add(match[1] ?? '');
  for (const match of masked.matchAll(LISTED)) {
    const allTypes = match[1] !== undefined;
    for (const raw of (match[2] ?? '').split(',')) {
      const entry = raw.trim();
      if (entry === '') continue;
      const isType = allTypes || entry.startsWith('type ');
      const name = (
        entry
          .replace(/^type\s+/, '')
          .split(/\s+as\s+/)
          .at(-1) ?? ''
      ).trim();
      (isType ? types : values).add(name);
    }
  }
  return { types: [...types].sort(), values: [...values].sort() };
}

const INSTALLER = /^(?:set|configure|install)[A-Z]/;

/** The installer-shaped values among a barrel's exports. */
export const installerNames = (names: ExportedNames): readonly string[] =>
  names.values.filter((name) => INSTALLER.test(name));

/** `readonly <field>: <type>;` members of `interface PortValues { … }`, field → declared type. */
export function portValueFields(masked: string): Readonly<Record<string, string>> {
  const start = masked.search(/\binterface\s+PortValues\b/);
  if (start < 0) return {};
  const end = masked.indexOf('\n}', start);
  const body = masked.slice(start, end < 0 ? undefined : end);
  const out: Record<string, string> = {};
  for (const match of body.matchAll(/\breadonly\s+(\w+)\s*\??:\s*([^;]+);/g)) {
    out[match[1] ?? ''] = (match[2] ?? '').replace(/\s+/g, ' ').trim();
  }
  return out;
}

/** `local name → module` for every value import in a comment-stripped file. */
function valueImports(stripped: string): ReadonlyMap<string, string> {
  const map = new Map<string, string>();
  for (const match of stripped.matchAll(/\bimport\s+(?!type\b)\{([^}]*)\}\s*from\s*'([^']+)'/g)) {
    for (const raw of (match[1] ?? '').split(',')) {
      const entry = raw.trim();
      if (entry === '' || entry.startsWith('type ')) continue;
      map.set((entry.split(/\s+as\s+/).at(-1) ?? '').trim(), match[2] ?? '');
    }
  }
  return map;
}

/** Each top-level object-literal entry (`  <key>: …`) of a comment-stripped bindings file. */
function entriesOf(stripped: string): ReadonlyMap<string, string> {
  const entries = new Map<string, string>();
  const lines = stripped.split('\n');
  let key: string | undefined;
  let body: string[] = [];
  const close = () => {
    if (key !== undefined) entries.set(key, body.join('\n'));
    key = undefined;
    body = [];
  };
  for (const line of lines) {
    const opened = /^ {2}(\w+):/.exec(line);
    if (opened !== null) {
      close();
      key = opened[1];
    } else if (/^\S/.test(line)) {
      close();
      continue;
    }
    if (key !== undefined) body.push(line);
  }
  close();
  return entries;
}

const firstQuoted = (text: string): string => /'([^']*)'/.exec(text)?.[1] ?? '';

/** Each port's binding, read from the bindings files (comment-stripped, in `PORT_BINDINGS_FILES` order). */
export function portBindings(files: readonly string[]): Readonly<Record<string, BindingFact>> {
  const parsed = files.map((text) => ({ entries: entriesOf(text), imports: valueImports(text) }));
  const out: Record<string, BindingFact> = {};
  for (const file of parsed) {
    for (const [port, raw] of file.entries) {
      if (Object.hasOwn(out, port)) continue;
      // `clock: BOOT_PORT_BINDINGS.clock` — the entry lives in another file under the same key.
      const forwarded = /^\s*\w+:\s*[A-Z_]+_PORT_BINDINGS\.(\w+)/.exec(raw);
      const home =
        forwarded === null ? file : parsed.find((f) => f !== file && f.entries.has(port));
      const text = forwarded === null ? raw : (home?.entries.get(port) ?? '');
      const phase = /phase:\s*'(\w+)'/.exec(text)?.[1] ?? 'unbound';
      const called = [...text.matchAll(/\b(install\w*|set\w*)\s*\(/g)].map((m) => m[1] ?? '');
      const from = new Set<string>();
      for (const name of called) {
        const module = home?.imports.get(name);
        if (module !== undefined) from.add(module);
      }
      for (const match of text.matchAll(/import\(\s*'([^']+)'\s*\)/g)) from.add(match[1] ?? '');
      const detail =
        phase === 'pending'
          ? firstQuoted(text.slice(text.indexOf('owner:')))
          : phase === 'read'
            ? firstQuoted(text.slice(text.indexOf('at:')))
            : [...new Set(called)].join(', ');
      out[port] = { phase, detail, installerFrom: [...from].sort() };
    }
  }
  return out;
}

/** A `package.json` `exports` value, as a bun-resolvable path, whatever its condition shape. */
export function exportPath(value: unknown): string | undefined {
  if (typeof value === 'string') return value;
  if (typeof value !== 'object' || value === null) return undefined;
  for (const condition of ['bun', 'import', 'default']) {
    const found = (value as Readonly<Record<string, unknown>>)[condition];
    if (typeof found === 'string') return found;
  }
  return undefined;
}

const exportsOf = (manifest: unknown): Readonly<Record<string, unknown>> => {
  if (typeof manifest !== 'object' || manifest === null) return {};
  const exports = (manifest as Readonly<Record<string, unknown>>)['exports'];
  return typeof exports === 'object' && exports !== null
    ? (exports as Readonly<Record<string, unknown>>)
    : {};
};

const nameOf = (manifest: unknown): string => {
  if (typeof manifest !== 'object' || manifest === null) return '';
  const name = (manifest as Readonly<Record<string, unknown>>)['name'];
  return typeof name === 'string' ? name : '';
};

async function readText(root: string, path: string): Promise<string | undefined> {
  const file = Bun.file(`${root}/${path}`);
  return (await file.exists()) ? file.text() : undefined;
}

async function namesAt(root: string, path: string | undefined): Promise<ExportedNames> {
  const text = path === undefined ? undefined : await readText(root, path);
  return text === undefined ? { types: [], values: [] } : exportedNames(maskLiterals(text));
}

/** Read every fact the guard judges, from `root`; `references` are the files the page cites. */
export async function readAdapterPortFacts(
  root: string,
  references: readonly string[],
): Promise<AdapterPortFacts> {
  const packages: Record<string, PackageFact> = {};
  let conformance: readonly string[] = [];
  for await (const path of new Bun.Glob('packages/*/package.json').scan({ cwd: root })) {
    const dir = path.replaceAll('\\', '/').replace(/\/package\.json$/, '');
    const manifest: unknown = JSON.parse((await readText(root, path)) ?? '{}');
    const name = nameOf(manifest);
    const exports = exportsOf(manifest);
    const entry = (key: string): string | undefined => {
      const target = exportPath(exports[key]);
      return target === undefined ? undefined : `${dir}/${target.replace(/^\.\//, '')}`;
    };
    const adapterEntry = entry('./adapter');
    const adapter = await namesAt(root, adapterEntry);
    const barrel = await namesAt(root, entry('.'));
    packages[name] = {
      name,
      adapterEntry,
      adapterTypes: adapter.types,
      adapterValues: adapter.values,
      barrelInstallers: installerNames(barrel),
    };
    if (name === CONFORMANCE_PACKAGE) {
      conformance = (await namesAt(root, entry(CONFORMANCE_SUBPATH))).values;
    }
  }
  const bindingTexts: string[] = [];
  for (const path of PORT_BINDINGS_FILES) {
    bindingTexts.push(stripComments((await readText(root, path)) ?? ''));
  }
  const sources = new Map<string, string>();
  for (const path of new Set(references)) {
    const text = await readText(root, path);
    if (text !== undefined) sources.set(path, text);
  }
  return {
    fields: portValueFields(maskLiterals((await readText(root, RUNTIME_OVERRIDES)) ?? '')),
    bindings: portBindings(bindingTexts),
    packages,
    conformance,
    declared: declaredIn(sources),
    page: await readText(root, ADAPTERS_PAGE),
  };
}

/** `declared(file, symbol)`: whether `file` exports a value or type called `symbol`. */
export function declaredIn(
  sources: ReadonlyMap<string, string>,
): (file: string, symbol: string) => boolean {
  const memo = new Map<string, ExportedNames>();
  return (file, symbol) => {
    let names = memo.get(file);
    if (names === undefined) {
      const text = sources.get(file);
      names = text === undefined ? { types: [], values: [] } : exportedNames(maskLiterals(text));
      memo.set(file, names);
    }
    return names.values.includes(symbol) || names.types.includes(symbol);
  };
}
