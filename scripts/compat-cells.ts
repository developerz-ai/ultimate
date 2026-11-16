// The compat matrix, read out of `.github/workflows/compat.yml` — the one place it is written. A
// cell is one runtime the gate does not pin (Bun, Postgres or Solid at a version); a part is one
// gate step on one shard. The runner, the filing job and the Stability table all read it here.

import { renderFixShellArg } from '../packages/core/src/error-render';
import { ScriptError } from './lib/script-error';

export const COMPAT_WORKFLOW = '.github/workflows/compat.yml';

export const COMPAT_AXES = ['bun', 'postgres', 'solid'] as const;
export type CompatAxis = (typeof COMPAT_AXES)[number];
/** `supported` is a promise the table makes; `watched` is tested and promised to nobody. */
export const COMPAT_SUPPORT = ['supported', 'watched'] as const;
export type CompatSupport = (typeof COMPAT_SUPPORT)[number];
/** The gate steps a part may run: the two the plan names, and only shardable ones. */
const PART_STEPS = ['unit', 'live'] as const;

export interface CompatCell {
  readonly id: string;
  readonly axis: CompatAxis;
  readonly version: string;
  readonly support: CompatSupport;
}

export interface CompatPart {
  readonly name: string;
  readonly only: (typeof PART_STEPS)[number];
  readonly shard: string;
  readonly services: readonly string[];
  readonly urls: readonly string[];
}

export interface CompatMatrix {
  readonly cells: readonly CompatCell[];
  readonly parts: readonly CompatPart[];
}

const FIX = `grep -n -A30 'matrix:' ${COMPAT_WORKFLOW}   # each cell { id, axis: bun|postgres|solid, version, support: supported|watched }; each part { name, only: unit|live, shard: i/n, services, urls }`;

const unreadable = (cause: string): ScriptError =>
  new ScriptError({ code: 'X_COMPAT_UNREADABLE', cause: `${COMPAT_WORKFLOW}: ${cause}`, fix: FIX });

const record = (value: unknown): Readonly<Record<string, unknown>> | undefined =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;

const word = (row: Readonly<Record<string, unknown>>, key: string): string => {
  const value = row[key];
  return typeof value === 'string' || typeof value === 'number' ? String(value) : '';
};

const oneOf = <T extends string>(list: readonly T[], value: string): value is T =>
  list.some((one) => one === value);

const cellFrom = (value: unknown, at: number): CompatCell => {
  const row = record(value) ?? {};
  const id = word(row, 'id');
  const axis = word(row, 'axis');
  const version = word(row, 'version');
  const support = word(row, 'support');
  const name = id || `cell ${at + 1}`;
  if (!/^[a-z0-9][a-z0-9.-]*$/.test(id)) throw unreadable(`${name} has no id of [a-z0-9.-]`);
  if (!oneOf(COMPAT_AXES, axis)) throw unreadable(`${name} has axis "${axis}"`);
  if (!oneOf(COMPAT_SUPPORT, support)) throw unreadable(`${name} has support "${support}"`);
  if (!/^[a-z0-9.]+$/.test(version)) throw unreadable(`${name} has version "${version}"`);
  return { id, axis, version, support };
};

const partFrom = (value: unknown, at: number): CompatPart => {
  const row = record(value) ?? {};
  const name = word(row, 'name') || `part ${at + 1}`;
  const only = word(row, 'only');
  const shard = word(row, 'shard');
  if (!oneOf(PART_STEPS, only)) throw unreadable(`${name} runs "${only}", not unit or live`);
  if (!/^\d+\/\d+$/.test(shard)) throw unreadable(`${name} has shard "${shard}", not i/n`);
  const split = (text: string, by: string) => text.split(by).filter((one) => one !== '');
  const services = split(word(row, 'services'), ' ');
  const urls = split(word(row, 'urls'), '|');
  if (services.length === 0 || urls.length === 0) throw unreadable(`${name} starts no service`);
  return { name, only, shard, services, urls };
};

const unique = (names: readonly string[], what: string): void => {
  const twice = names.filter((name, at) => names.indexOf(name) !== at);
  if (twice.length > 0) throw unreadable(`${what} ${twice.join(', ')} appears twice`);
};

/** The `cell` job's matrix; refused, never read as empty, when either list is missing. */
export function readCompatMatrix(text: string): CompatMatrix {
  const doc = record(Bun.YAML.parse(text));
  const matrix = record(record(record(record(doc?.['jobs'])?.['cell'])?.['strategy'])?.['matrix']);
  const [cells, parts] = [matrix?.['cell'], matrix?.['part']];
  if (!Array.isArray(cells) || cells.length === 0 || !Array.isArray(parts) || parts.length === 0) {
    throw unreadable('the cell job declares no matrix of cells and parts');
  }
  const read = { cells: cells.map(cellFrom), parts: parts.map(partFrom) };
  unique(
    read.cells.map((cell) => cell.id),
    'cell',
  );
  unique(
    read.parts.map((part) => part.name),
    'part',
  );
  return read;
}

export const loadCompatMatrix = async (root: string): Promise<CompatMatrix> =>
  readCompatMatrix(await Bun.file(`${root}/${COMPAT_WORKFLOW}`).text());

/** The flag that was wrong carries a real value; the other stays a placeholder. */
const badFlag = (what: 'cell' | 'part', name: string, known: readonly string[]): ScriptError => {
  const first = known[0] ?? '';
  const choices = `${what}s: ${known.join(', ')}`;
  return new ScriptError({
    code: 'X_CLI_BAD_FLAG',
    cause: `${COMPAT_WORKFLOW} has no ${what} "${name}"`,
    fix:
      what === 'cell'
        ? `bun run scripts/compat.ts run --cell ${renderFixShellArg(first, '<cell>')} --part <part> --json   # ${choices}`
        : `bun run scripts/compat.ts run --cell <cell> --part ${renderFixShellArg(first, '<part>')} --json   # ${choices}`,
  });
};

export function cellOf(matrix: CompatMatrix, id: string): CompatCell {
  const cell = matrix.cells.find((one) => one.id === id);
  if (cell === undefined) {
    throw badFlag(
      'cell',
      id,
      matrix.cells.map((one) => one.id),
    );
  }
  return cell;
}

export function partOf(matrix: CompatMatrix, name: string): CompatPart {
  const part = matrix.parts.find((one) => one.name === name);
  if (part === undefined) {
    throw badFlag(
      'part',
      name,
      matrix.parts.map((one) => one.name),
    );
  }
  return part;
}
