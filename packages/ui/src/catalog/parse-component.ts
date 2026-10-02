// Reads a component's contract out of its own source: the header comment, the exported
// component(s), and every prop with its type and doc line. Text in, data out — no filesystem, so
// the rule is testable, and the catalog it feeds cannot describe a component that isn't there.

export interface PropDoc {
  readonly name: string;
  /** Normalised: `| undefined` stripped, whitespace collapsed. */
  readonly type: string;
  readonly required: boolean;
  readonly doc: string;
}

export interface ComponentDoc {
  readonly name: string;
  /** The file's header comment, which is the component's one-paragraph purpose. */
  readonly summary: string;
  readonly props: readonly PropDoc[];
}

// The generic slot is optional: `DataTable<Row>(props: DataTableProps<Row>)` is still a component.
const COMPONENT_PATTERN = /export function ([A-Z]\w*)(?:<[^>]*>)?\(\s*props: (\w+)/g;

/** Every exported component in one source file, in source order. */
export function parseComponents(source: string): ComponentDoc[] {
  const summary = headerComment(source);
  const out: ComponentDoc[] = [];
  for (const match of source.matchAll(COMPONENT_PATTERN)) {
    const [, name = '', propsType = ''] = match;
    out.push({ name, summary, props: parseProps(source, propsType) });
  }
  return out;
}

/** The `// …` block at the top of the file, before the first import. */
export function headerComment(source: string): string {
  const lines: string[] = [];
  for (const line of source.split('\n')) {
    const trimmed = line.trim();
    if (trimmed.startsWith('//')) {
      lines.push(trimmed.slice(2).trim());
      continue;
    }
    if (lines.length > 0) break;
    if (trimmed !== '') break;
  }
  return lines.join(' ').trim();
}

/**
 * Every prop a caller may write for `<name>`: the members of `interface <name>`, its bases' first,
 * or — where `<name>` is `type <name> = A | B`, one interface per mode — the modes merged.
 */
export function parseProps(source: string, typeName: string): PropDoc[] {
  const modes = unionMembers(source, typeName);
  if (modes === undefined) return interfaceProps(source, typeName);
  return mergeModes(modes.map((mode) => interfaceProps(source, mode)));
}

/** `GridLinkProps<Row>` names the interface `GridLinkProps`. */
const withoutTypeArguments = (name: string): string => name.replace(/<[^>]*>/, '').trim();

/** `A`, `B` out of `export type <name> = A | B;`. `undefined` when `<name>` is not such an alias. */
function unionMembers(source: string, typeName: string): string[] | undefined {
  const alias = new RegExp(`export type ${typeName}(?:<[^>]*>)?\\s*=\\s*([\\w\\s|<>]+);`).exec(
    source,
  );
  return alias?.[1]
    ?.split('|')
    .map((member) => withoutTypeArguments(member))
    .filter((member) => member !== '');
}

/**
 * One row per prop across modes. Required only when EVERY mode requires it — a prop one mode
 * forbids is optional to a reader choosing between them — and typed as each mode types it.
 */
function mergeModes(modes: readonly (readonly PropDoc[])[]): PropDoc[] {
  const merged = new Map<string, PropDoc>();
  for (const props of modes) {
    for (const prop of props) {
      const seen = merged.get(prop.name);
      if (seen === undefined) {
        merged.set(prop.name, prop);
        continue;
      }
      merged.set(prop.name, {
        name: prop.name,
        type: seen.type === prop.type ? seen.type : `${seen.type} | ${prop.type}`,
        required: seen.required && prop.required,
        doc: seen.doc === '' ? prop.doc : seen.doc,
      });
    }
  }
  return [...merged.values()].map((prop) => ({
    ...prop,
    required: prop.required && modes.every((props) => props.some((p) => p.name === prop.name)),
  }));
}

/** The members of `interface <name> { … }`, generics and all, after those of every base. */
function interfaceProps(source: string, interfaceName: string): PropDoc[] {
  const declared = interfaceDeclaration(source, interfaceName);
  if (declared === undefined) return [];
  const { body, bases } = declared;

  const own: PropDoc[] = [];
  let doc: string[] = [];
  let buffer = '';
  let depth = 0;

  for (const raw of body.split('\n')) {
    const line = raw.trim();
    if (line === '') continue;
    if (buffer === '' && isComment(line)) {
      doc.push(stripComment(line));
      continue;
    }
    buffer = buffer === '' ? line : `${buffer} ${line}`;
    depth = nesting(buffer);
    // A member ends at a `;` that is not inside a function type or an inline object type.
    if (depth > 0 || !buffer.endsWith(';')) continue;
    const prop = toProp(buffer, doc.join(' ').trim());
    if (prop !== undefined) own.push(prop);
    buffer = '';
    doc = [];
  }

  const names = new Set(own.map((prop) => prop.name));
  const inherited = bases
    .flatMap((base) => interfaceProps(source, base))
    .filter((prop) => !names.has(prop.name));
  return [...inherited, ...own];
}

function isComment(line: string): boolean {
  return line.startsWith('//') || line.startsWith('/*') || line.startsWith('*');
}

function stripComment(line: string): string {
  return line
    .replace(/^\/\*\*?/, '')
    .replace(/^\/\//, '')
    .replace(/^\*+\/?/, '')
    .replace(/\*\/$/, '')
    .trim();
}

/**
 * Brackets only — never `<`/`>`, because `=>` in a function-type prop would read as a closing
 * angle and end the member one line early.
 */
function nesting(text: string): number {
  let depth = 0;
  for (const char of text) {
    if (char === '(' || char === '{' || char === '[') depth += 1;
    if (char === ')' || char === '}' || char === ']') depth -= 1;
  }
  return depth;
}

function toProp(declaration: string, doc: string): PropDoc | undefined {
  const match = /^(?:readonly\s+)?('[^']+'|"[^"]+"|\w+)(\?)?:\s*([\s\S]+);$/.exec(declaration);
  if (match === null) return undefined;
  const [, rawName = '', optional, rawType = ''] = match;
  const type = normaliseType(rawType);
  // `hrefFor?: undefined` is how one mode of a union forbids another mode's prop: a member that
  // exists so the prop CANNOT be written is not a prop.
  if (type === '' || type === 'never') return undefined;
  return {
    name: rawName.replace(/^['"]|['"]$/g, ''),
    type,
    required: optional === undefined,
    doc,
  };
}

function normaliseType(type: string): string {
  return (
    type
      .replace(/\s+/g, ' ')
      .split('|')
      .map((part) => part.trim())
      // The empty part is a leading `|` in a wrapped union, which is style, not a member.
      .filter((part) => part !== 'undefined' && part !== '')
      .join(' | ')
      .trim()
  );
}

/**
 * Brace-matched so a nested object type does not end the interface early. `export` is optional:
 * a base shared by two modes is a detail of the file, and its members are still the component's.
 */
function interfaceDeclaration(
  source: string,
  interfaceName: string,
): { readonly body: string; readonly bases: readonly string[] } | undefined {
  const header = new RegExp(
    `(?:export )?interface ${interfaceName}(?:<[^>]*>)?(?:\\s+extends\\s+([\\w\\s,<>]+?))?\\s*\\{`,
  ).exec(source);
  if (header === null) return undefined;
  const bases = (header[1] ?? '')
    .split(',')
    .map((base) => withoutTypeArguments(base))
    .filter((base) => base !== '');
  const start = header.index + header[0].length;
  let depth = 1;
  for (let i = start; i < source.length; i += 1) {
    const char = source[i];
    if (char === '{') depth += 1;
    if (char === '}') depth -= 1;
    if (depth === 0) return { body: source.slice(start, i), bases };
  }
  return undefined;
}
