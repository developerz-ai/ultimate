// `scripts/lib/public-api.lock.json`, read and written. Format 2 records each exported symbol's
// hash AND its shape, so a change can be told additive from breaking; format 1 (31.19–31.21) held
// hashes only, and parses with no shapes — `public-api-migrate.ts` re-baselines it from the tags.

import type { ApiSymbol } from './public-api-compat';
import type { ApiShape } from './public-api-shape';

export const LOCK_PATH = 'scripts/lib/public-api.lock.json';
export const LOCK_FORMAT = 2;

/** specifier → exported name → what the lock records of it. */
export type ApiSnapshot = Readonly<Record<string, Readonly<Record<string, ApiSymbol>>>>;

export interface ApiLock {
  /** 1: hashes only. 2: hashes and shapes. */
  readonly format: 1 | 2;
  /** The tree's version when the lock was written. */
  readonly version: string;
  readonly entries: ApiSnapshot;
}

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const strings = (value: unknown): value is readonly string[] =>
  Array.isArray(value) && value.every((one) => typeof one === 'string');

function parseShape(value: unknown): ApiShape | undefined {
  if (!isRecord(value) || typeof value['head'] !== 'string') return undefined;
  const head = value['head'];
  const members = value['members'];
  if (value['kind'] === 'members' && isRecord(members)) {
    const all = Object.entries(members);
    const codes = all.filter((pair): pair is [string, string] => typeof pair[1] === 'string');
    if (codes.length !== all.length) return undefined;
    return { kind: 'members', head, members: Object.fromEntries(codes) };
  }
  const { params, returns } = value;
  if (value['kind'] === 'function' && strings(params) && typeof returns === 'string') {
    return { kind: 'function', head, params: [...params], returns };
  }
  return undefined;
}

function parseSymbol(value: unknown, format: 1 | 2): ApiSymbol | undefined {
  if (format === 1) return typeof value === 'string' ? { hash: value } : undefined;
  if (!isRecord(value) || typeof value['hash'] !== 'string') return undefined;
  if (value['shape'] === undefined) return { hash: value['hash'] };
  const shape = parseShape(value['shape']);
  return shape === undefined ? undefined : { hash: value['hash'], shape };
}

/** The lock parsed from `unknown`, or the reason it is not one. */
export function parseLock(value: unknown): ApiLock | string {
  if (!isRecord(value) || typeof value['version'] !== 'string' || !isRecord(value['entries'])) {
    return 'is not an object with a string `version` and an `entries` object';
  }
  const raw = value['format'] ?? 1;
  if (raw !== 1 && raw !== LOCK_FORMAT) {
    return `has \`format\` ${JSON.stringify(raw)}, and this script reads formats 1 and ${LOCK_FORMAT}`;
  }
  const format = raw === 1 ? 1 : 2;
  const entries: Record<string, Record<string, ApiSymbol>> = {};
  for (const [specifier, names] of Object.entries(value['entries'])) {
    if (!isRecord(names)) return `holds \`${specifier}\`, which is not an object of symbols`;
    const symbols: Record<string, ApiSymbol> = {};
    for (const [name, symbol] of Object.entries(names)) {
      const parsed = parseSymbol(symbol, format);
      if (parsed === undefined)
        return `holds \`${specifier}\` \`${name}\` in no format-${format} form`;
      symbols[name] = parsed;
    }
    entries[specifier] = symbols;
  }
  return { format, version: value['version'], entries };
}

const byKey = <T>(record: Readonly<Record<string, T>>): [string, T][] =>
  Object.entries(record).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));

/** A symbol as one JSON line, its keys in one fixed order, so the file diffs one line a change. */
function symbolLine(symbol: ApiSymbol): string {
  const { shape } = symbol;
  if (shape === undefined) return JSON.stringify({ hash: symbol.hash });
  const body =
    shape.kind === 'members'
      ? { kind: shape.kind, head: shape.head, members: Object.fromEntries(byKey(shape.members)) }
      : { kind: shape.kind, head: shape.head, params: shape.params, returns: shape.returns };
  return JSON.stringify({ hash: symbol.hash, shape: body });
}

/** The lock as committed, always format 2: keys sorted, one line per symbol, LF, on every OS. */
export function renderLock(lock: ApiLock): string {
  const blocks = byKey(lock.entries).map(([specifier, names]) => {
    const lines = byKey(names).map(
      ([name, one]) => `      ${JSON.stringify(name)}: ${symbolLine(one)}`,
    );
    return lines.length === 0
      ? `    ${JSON.stringify(specifier)}: {}`
      : `    ${JSON.stringify(specifier)}: {\n${lines.join(',\n')}\n    }`;
  });
  const entries = blocks.length === 0 ? '{}' : `{\n${blocks.join(',\n')}\n  }`;
  return `{\n  "format": ${LOCK_FORMAT},\n  "version": ${JSON.stringify(lock.version)},\n  "entries": ${entries}\n}\n`;
}
