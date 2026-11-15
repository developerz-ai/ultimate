// `scripts/lib/public-api.lock.json`, read and written. Format 2 records each exported symbol's
// hash AND its shape, so a change can be told additive from breaking; format 1 (31.19–31.21) held
// hashes only, and parses with no shapes — `public-api-migrate.ts` re-baselines it from the tags.

import type { ApiSymbol } from './public-api-compat';
import type { ApiShape, LocalShape } from './public-api-shape';

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

const codes = (value: unknown): Record<string, string> | undefined => {
  if (!isRecord(value)) return undefined;
  const all = Object.entries(value);
  const kept = all.filter((pair): pair is [string, string] => typeof pair[1] === 'string');
  return kept.length === all.length ? Object.fromEntries(kept) : undefined;
};

function parseLocals(value: unknown): Record<string, LocalShape> | undefined {
  if (!isRecord(value)) return undefined;
  const out: Record<string, LocalShape> = {};
  for (const [name, local] of Object.entries(value)) {
    if (!isRecord(local) || typeof local['hash'] !== 'string') return undefined;
    if (local['shape'] === undefined) {
      out[name] = { hash: local['hash'] };
      continue;
    }
    const shape = parseShape(local['shape']);
    if (shape === undefined) return undefined;
    out[name] = { hash: local['hash'], shape };
  }
  return out;
}

function parseShape(value: unknown): ApiShape | undefined {
  if (isRecord(value) && value['kind'] === 'unrecorded') return { kind: 'unrecorded' };
  if (isRecord(value) && value['kind'] === 'overloads' && Array.isArray(value['signatures'])) {
    const signatures = value['signatures'].map(parseShape);
    const functions = signatures.filter((one) => one?.kind === 'function');
    return functions.length === signatures.length
      ? { kind: 'overloads', signatures: functions }
      : undefined;
  }
  if (!isRecord(value) || typeof value['head'] !== 'string') return undefined;
  const { head, kind } = value;
  const members = codes(value['members']);
  if ((kind === 'members' || kind === 'value') && members !== undefined) {
    return { kind, head, members };
  }
  const { params, returns, values, ctor, keyword } = value;
  if (kind === 'function' && strings(params) && typeof returns === 'string') {
    return { kind: 'function', head, params: [...params], returns };
  }
  if (kind === 'literals' && strings(values)) return { kind, head, values: [...values] };
  if (kind === 'class' && members !== undefined && (ctor === undefined || strings(ctor))) {
    return { kind, head, members, ...(ctor === undefined ? {} : { ctor: [...ctor] }) };
  }
  if (kind === 'declaration' && typeof keyword === 'string') {
    if (value['locals'] === undefined) return { kind, keyword, head };
    const locals = parseLocals(value['locals']);
    return locals === undefined ? undefined : { kind, keyword, head, locals };
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

const sortedCodes = (record: Readonly<Record<string, string>>): Record<string, string> =>
  Object.fromEntries(byKey(record));

/** A shape with its keys in one fixed order, members and locals sorted. */
function shapeBody(shape: ApiShape): unknown {
  switch (shape.kind) {
    case 'members':
    case 'value':
      return { kind: shape.kind, head: shape.head, members: sortedCodes(shape.members) };
    case 'function':
      return { kind: shape.kind, head: shape.head, params: shape.params, returns: shape.returns };
    case 'literals':
      return { kind: shape.kind, head: shape.head, values: shape.values };
    case 'class':
      return {
        kind: shape.kind,
        head: shape.head,
        members: sortedCodes(shape.members),
        ...(shape.ctor === undefined ? {} : { ctor: shape.ctor }),
      };
    case 'declaration':
      return {
        kind: shape.kind,
        keyword: shape.keyword,
        head: shape.head,
        ...(shape.locals === undefined
          ? {}
          : {
              locals: Object.fromEntries(
                byKey(shape.locals).map(([name, local]) => [name, symbolBody(local)]),
              ),
            }),
      };
    case 'overloads':
      return { kind: shape.kind, signatures: shape.signatures.map(shapeBody) };
    case 'unrecorded':
      return { kind: shape.kind };
  }
}

const symbolBody = (symbol: ApiSymbol | LocalShape): unknown =>
  symbol.shape === undefined
    ? { hash: symbol.hash }
    : { hash: symbol.hash, shape: shapeBody(symbol.shape) };

/** A symbol as one JSON line, its keys in one fixed order, so the file diffs one line a change. */
const symbolLine = (symbol: ApiSymbol): string => JSON.stringify(symbolBody(symbol));

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
