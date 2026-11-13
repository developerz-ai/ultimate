// One emitted `.d.ts` file read into the statements `scripts/public-api.ts` hashes: a tokenizer
// that drops comments and whitespace (so CRLF, indentation and JSDoc never churn a hash) and a
// top-level splitter. Declaration files are regular enough that no TypeScript parser is needed —
// and TypeScript 7 ships none to JavaScript.

export interface ExportSpec {
  /** The name a consumer imports. */
  readonly name: string;
  /** The name in the module it comes from. */
  readonly local: string;
}

export interface ImportBinding {
  readonly local: string;
  /** `*` for a namespace import, `default` for a default import. */
  readonly imported: string;
  readonly from: string;
}

export interface Declared {
  readonly name: string;
  /** The declaration, normalised: no `export`/`declare`, no `import("…")` qualifiers. */
  readonly text: string;
  readonly exported: boolean;
}

export interface DtsModule {
  readonly imports: readonly ImportBinding[];
  readonly declarations: readonly Declared[];
  /** `export { local as name }`, no `from`. */
  readonly lists: readonly ExportSpec[];
  readonly reexports: readonly (ExportSpec & { readonly from: string })[];
  /** `export * from` (`as` absent) and `export * as ns from`. */
  readonly stars: readonly { readonly from: string; readonly as?: string }[];
}

const IDENT = /[\w$#\u0080-\uffff]/;
const MULTI = ['=>', '...', '?.'];

/** A quoted string, re-spelt with `"` when that changes nothing but the quote. */
const quoted = (raw: string): string => {
  const body = raw.slice(1, -1);
  return /["'\\]/.test(body) ? raw : `"${body}"`;
};

function skipTemplate(text: string, start: number): number {
  let at = start + 1;
  while (at < text.length && text[at] !== '`') {
    if (text[at] === '\\') at += 2;
    else if (text[at] === '$' && text[at + 1] === '{') {
      let depth = 1;
      at += 2;
      while (at < text.length && depth > 0) {
        if (text[at] === '`') at = skipTemplate(text, at);
        else if (text[at] === '{') depth += 1;
        else if (text[at] === '}') depth -= 1;
        at += 1;
      }
    } else at += 1;
  }
  return at;
}

/** Every token of `text`, comments and whitespace dropped. */
export function tokenize(source: string): readonly string[] {
  const text = source.replace(/\r\n?/g, '\n');
  const tokens: string[] = [];
  let at = 0;
  while (at < text.length) {
    const char = text[at] ?? '';
    if (/\s/.test(char)) at += 1;
    else if (text.startsWith('//', at)) {
      const end = text.indexOf('\n', at);
      at = end === -1 ? text.length : end;
    } else if (text.startsWith('/*', at)) {
      const end = text.indexOf('*/', at + 2);
      at = end === -1 ? text.length : end + 2;
    } else if (char === '"' || char === "'") {
      let end = at + 1;
      while (end < text.length && text[end] !== char) end += text[end] === '\\' ? 2 : 1;
      tokens.push(quoted(text.slice(at, end + 1)));
      at = end + 1;
    } else if (char === '`') {
      const end = skipTemplate(text, at);
      tokens.push(text.slice(at, end + 1));
      at = end + 1;
    } else if (IDENT.test(char)) {
      let end = at + 1;
      while (end < text.length && IDENT.test(text[end] ?? '')) end += 1;
      tokens.push(text.slice(at, end));
      at = end;
    } else {
      const multi = MULTI.find((op) => text.startsWith(op, at));
      tokens.push(multi ?? char);
      at += multi?.length ?? 1;
    }
  }
  return tokens;
}

const MODIFIERS = new Set(['export', 'declare', 'default', 'abstract', 'async', 'const']);
const BLOCK_KINDS = new Set(['interface', 'class', 'enum', 'namespace', 'module', 'global']);

const headKind = (tokens: readonly string[]): string | undefined =>
  tokens.find((token) => !MODIFIERS.has(token));

/** The top-level statements: `;` at depth 0, or a block declaration's closing `}`. */
export function splitStatements(tokens: readonly string[]): readonly (readonly string[])[] {
  const out: string[][] = [];
  let current: string[] = [];
  let depth = 0;
  let angle = 0;
  let bodyOpened = false;
  const flush = (): void => {
    if (current.length > 0) out.push(current);
    current = [];
    bodyOpened = false;
    angle = 0;
  };
  for (const token of tokens) {
    if (token === ';' && depth === 0) {
      flush();
      continue;
    }
    current.push(token);
    const block = BLOCK_KINDS.has(headKind(current) ?? '');
    if (depth === 0 && !bodyOpened && block) {
      if (token === '<') angle += 1;
      else if (token === '>') angle -= 1;
    }
    if (token === '{' || token === '(' || token === '[') {
      if (token === '{' && depth === 0 && angle === 0 && block) bodyOpened = true;
      depth += 1;
    } else if (token === '}' || token === ')' || token === ']') {
      depth -= 1;
      if (depth === 0 && token === '}' && bodyOpened) flush();
    }
  }
  flush();
  return out;
}

/**
 * `import("./x").Name` → `Name`: the emitter's spelling of a path, never part of the API. A class's
 * `private x;` / `#private;` lines go too: the emitter writes them untyped, and no caller names one.
 */
export function normalised(tokens: readonly string[]): string {
  const kept: string[] = [];
  for (let at = 0; at < tokens.length; at += 1) {
    const [a, b, c, d, e] = tokens.slice(at, at + 5);
    if (a === 'import' && b === '(' && c?.startsWith('"') && d === ')' && e === '.') {
      at += 4;
      continue;
    }
    if (a === '#private' && b === ';') {
      at += 1;
      continue;
    }
    if (a === 'private') {
      const end = tokens.indexOf(';', at);
      const member = tokens.slice(at + 1, end);
      if (end !== -1 && member.length > 0 && member.every((one) => /^(?:[\w$]+|\?)$/.test(one))) {
        at = end;
        continue;
      }
    }
    kept.push(tokens[at] ?? '');
  }
  return kept.join(' ');
}

const unquote = (token: string | undefined): string => (token ?? '').slice(1, -1);

/** `{ a, type b, c as d }` → specs; `from` reads the token after the closing brace. */
function specList(tokens: readonly string[], open: number): { specs: ExportSpec[]; end: number } {
  const close = tokens.indexOf('}', open);
  const specs: ExportSpec[] = [];
  const inner = tokens.slice(open + 1, close);
  let part: string[] = [];
  for (const token of [...inner, ',']) {
    if (token !== ',') {
      part.push(token);
      continue;
    }
    const words = part[0] === 'type' && part.length > 1 ? part.slice(1) : part;
    if (words.length > 0) {
      const local = words[0] ?? '';
      specs.push({ local, name: words[1] === 'as' ? (words[2] ?? local) : local });
    }
    part = [];
  }
  return { specs, end: close };
}

function parseImport(tokens: readonly string[], into: ImportBinding[]): void {
  const fromAt = tokens.lastIndexOf('from');
  if (fromAt === -1) return;
  const from = unquote(tokens[fromAt + 1]);
  const clause = tokens.slice(tokens[1] === 'type' ? 2 : 1, fromAt);
  const brace = clause.indexOf('{');
  if (brace !== -1) {
    for (const spec of specList(clause, brace).specs) {
      into.push({ local: spec.name, imported: spec.local, from });
    }
  }
  const star = clause.indexOf('*');
  if (star !== -1) into.push({ local: clause[star + 2] ?? '', imported: '*', from });
  const first = clause[0];
  if (first !== undefined && first !== '{' && first !== '*') {
    into.push({ local: first, imported: 'default', from });
  }
}

const OPENERS = new Set(['{', '(', '[', '<']);
const CLOSERS = new Set(['}', ')', ']', '>']);

/** A variable statement's declarators, split at depth-0 commas: `const a: A, b: B`. */
function declarators(keyword: string, rest: readonly string[]): Declared[] {
  const out: Declared[] = [];
  let depth = 0;
  let part: string[] = [];
  for (const token of [...rest, ',']) {
    if (token === ',' && depth === 0) {
      if (part[0] !== undefined) {
        out.push({ name: part[0], text: normalised([keyword, ...part]), exported: false });
      }
      part = [];
      continue;
    }
    if (OPENERS.has(token)) depth += 1;
    else if (CLOSERS.has(token)) depth -= 1;
    part.push(token);
  }
  return out;
}

function parseDeclaration(tokens: readonly string[]): Declared[] {
  const exported = tokens[0] === 'export';
  let at = 0;
  while (at < tokens.length && (tokens[at] === 'export' || tokens[at] === 'declare')) at += 1;
  if (tokens[at] === 'default' || tokens[at] === '=' || tokens[at] === 'import') return [];
  const keyword = tokens[at] ?? '';
  if (keyword === 'const' && tokens[at + 1] === 'enum') {
    return [{ name: tokens[at + 2] ?? '', text: normalised(tokens.slice(at)), exported }];
  }
  if (keyword === 'const' || keyword === 'let' || keyword === 'var') {
    return declarators(keyword, tokens.slice(at + 1)).map((one) => ({ ...one, exported }));
  }
  let kind = at;
  while (tokens[kind] === 'abstract' || tokens[kind] === 'async') kind += 1;
  const name = tokens[kind + 1] ?? '';
  if (!/^[\w$]+$/.test(name) || tokens[kind] === 'global') return [];
  return [{ name, text: normalised(tokens.slice(at)), exported }];
}

/** One `.d.ts` file's imports, declarations and exports. */
export function parseDts(text: string): DtsModule {
  const imports: ImportBinding[] = [];
  const declarations: Declared[] = [];
  const lists: ExportSpec[] = [];
  const reexports: (ExportSpec & { from: string })[] = [];
  const stars: { from: string; as?: string }[] = [];
  for (const tokens of splitStatements(tokenize(text))) {
    if (tokens[0] === 'import') {
      parseImport(tokens, imports);
      continue;
    }
    const brace = tokens[0] === 'export' ? tokens.indexOf('{') : -1;
    if (brace !== -1 && brace <= 2 && (brace === 1 || tokens[1] === 'type')) {
      const { specs, end } = specList(tokens, brace);
      if (tokens[end + 1] === 'from') {
        const from = unquote(tokens[end + 2]);
        for (const spec of specs) reexports.push({ ...spec, from });
      } else lists.push(...specs);
      continue;
    }
    if (tokens[0] === 'export' && tokens[1] === '*') {
      const from = unquote(tokens[tokens.indexOf('from') + 1]);
      stars.push(tokens[2] === 'as' ? { from, as: tokens[3] ?? '' } : { from });
      continue;
    }
    declarations.push(...parseDeclaration(tokens));
  }
  return { imports, declarations, lists, reexports, stars };
}
