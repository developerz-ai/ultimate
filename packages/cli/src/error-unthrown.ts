// A registered code nothing constructs. The registry and the reference keep a shipped code alive
// forever — which is right — and that is exactly why a code can outlive its last thrower with no
// gate noticing: `X_RPC_FAILED` sat registered and documented as live after the transport change
// took its only throw site away. The reference row has to SAY so, or this reports it.

import { join } from 'node:path';
import { ERROR_DOCS_URL, maskLiterals, stripComments } from '@ultimat3/core';
import { RESERVED_HEADING } from './error-contract';
import type { Finding } from './output';
import { eachSourceFile, isGenerated, isTest } from './source-files';
import { isCodeRegistry } from './ts-scan';

const CODE_LITERAL = /(['"`])(X_[A-Z0-9_]+)\1/g;
const TITLE_KEY = /^[\t ]*(X_[A-Z0-9_]+)\s*:/gm;
/** A registry's own code LIST line — `'X_FOO',` — declares a code and throws nothing. */
const LIST_LINE = /^[\t ]*(['"`])X_[A-Z0-9_]+\1\s*,?\s*$/;
/** `metaMissing: 'X_SEO_META_MISSING'` — the table `@ultimat3/seo` and `@ultimat3/ui` raise from. */
const TABLE_ENTRY = /\b([a-z][A-Za-z0-9]*)\s*:\s*(['"`])(X_[A-Z0-9_]+)\2/g;
const MEMBER_READ = /\.([A-Za-z_$][\w$]*)/g;

/** Phrases a reference row uses to say, in words, that nothing throws the code any more. */
const DECLARED_UNTHROWN = /thrown by nothing|not thrown/i;

export interface CodeUse {
  /** Every code a package registry names. */
  readonly registered: ReadonlySet<string>;
  /** Every code shipped source constructs, compares or raises outside a registry's declaration. */
  readonly used: ReadonlySet<string>;
}

/**
 * One file's contribution. A registry file's code LIST and title KEYS declare; any other literal in
 * it is a use (a class's `code:`, a `?? 'X_…'` fallback, a comparison). A table entry counts only
 * once something reads that member — which is how two packages raise every code they own.
 */
export function codeUseOf(source: string): {
  readonly registered: readonly string[];
  readonly used: readonly string[];
  readonly table: ReadonlyMap<string, string>;
  readonly members: readonly string[];
} {
  const text = stripComments(source);
  const members = [...maskLiterals(source).matchAll(MEMBER_READ)].map((m) => m[1] ?? '');
  if (!isCodeRegistry(text)) {
    return {
      registered: [],
      used: [...text.matchAll(CODE_LITERAL)].map((m) => m[2] ?? ''),
      table: new Map(),
      members,
    };
  }
  const registered = [
    ...[...text.matchAll(TITLE_KEY)].map((m) => m[1] ?? ''),
    ...[...text.matchAll(CODE_LITERAL)].map((m) => m[2] ?? ''),
  ];
  const table = new Map<string, string>();
  for (const m of text.matchAll(TABLE_ENTRY)) {
    // `code: 'X_…'` is a class or a factory constructing the code, never a table entry.
    if (m[1] !== 'code') table.set(m[1] ?? '', m[3] ?? '');
  }
  const tableCodes = new Set(table.values());
  const used: string[] = [];
  for (const line of text.split('\n')) {
    if (LIST_LINE.test(line)) continue;
    for (const m of line.matchAll(CODE_LITERAL)) {
      const code = m[2] ?? '';
      if (!tableCodes.has(code)) used.push(code);
    }
  }
  return { registered, used, table, members };
}

/** Shipped package source only: `scripts/` never ships, so a code only a gate script names is unthrown. */
export async function collectCodeUse(root: string): Promise<CodeUse> {
  const registered = new Set<string>();
  const used = new Set<string>();
  const table = new Map<string, string>();
  const members = new Set<string>();
  for await (const source of eachSourceFile(root)) {
    if (!/^packages\/[^/]+\/src\//.test(source) || isTest(source) || isGenerated(source)) continue;
    const use = codeUseOf(await Bun.file(join(root, source)).text());
    for (const code of use.registered) registered.add(code);
    for (const code of use.used) used.add(code);
    for (const [member, code] of use.table) table.set(member, code);
    for (const member of use.members) members.add(member);
  }
  for (const [member, code] of table) if (members.has(member)) used.add(code);
  return { registered, used };
}

/** Codes whose reference row says nothing throws them, or that sit under the reserved heading. */
export function declaredUnthrown(markdown: string): ReadonlySet<string> {
  const out = new Set<string>();
  let reserved = false;
  for (const line of markdown.split('\n')) {
    if (line.trim() === RESERVED_HEADING) reserved = true;
    const row = /^\|\s*`(X_[A-Z0-9_]+)`\s*\|/.exec(line);
    if (row !== null && (reserved || DECLARED_UNTHROWN.test(line))) out.add(row[1] ?? '');
  }
  return out;
}

const unthrownFinding = (code: string, page: string): Finding => ({
  code: 'X_ERROR_CODE_UNTHROWN',
  cause: `${code} is registered and ${page} presents it as live, but no shipped source constructs it — a reader matching on it waits for an error that cannot arrive`,
  // Never "delete the registration": a shipped code is stable forever, and an old log line must
  // still explain. The row is what has to change.
  fix: `write "registered, thrown by nothing since <version>" into ${code}'s row in ${page}, naming the code that replaced it — or throw it again where it belongs`,
  docs: ERROR_DOCS_URL,
  at: page,
});

/**
 * Registered, used by nothing, and not declared unthrown on the reference. A host check — the page
 * is the host repo's to name, and only a monorepo's walk sees every package's source; in a
 * generated app every framework code would read as unthrown.
 */
export async function checkErrorCodesThrown(
  root: string,
  page: string,
): Promise<readonly Finding[]> {
  const reference = Bun.file(join(root, page));
  if (!(await reference.exists())) return [];
  const exempt = declaredUnthrown(await reference.text());
  const { registered, used } = await collectCodeUse(root);
  return [...registered]
    .filter((code) => !used.has(code) && !exempt.has(code))
    .sort()
    .map((code) => unthrownFinding(code, page));
}
