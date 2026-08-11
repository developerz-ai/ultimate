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

/** The members of `export interface <name> { … }`, generics and all. */
export function parseProps(source: string, interfaceName: string): PropDoc[] {
  const body = interfaceBody(source, interfaceName);
  if (body === undefined) return [];

  const props: PropDoc[] = [];
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
    if (prop !== undefined) props.push(prop);
    buffer = '';
    doc = [];
  }
  return props;
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
  return {
    name: rawName.replace(/^['"]|['"]$/g, ''),
    type: normaliseType(rawType),
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

/** Brace-matched so a nested object type does not end the interface early. */
function interfaceBody(source: string, interfaceName: string): string | undefined {
  const header = new RegExp(`export interface ${interfaceName}(?:<[^>]*>)?\\s*\\{`).exec(source);
  if (header === null) return undefined;
  const start = header.index + header[0].length;
  let depth = 1;
  for (let i = start; i < source.length; i += 1) {
    const char = source[i];
    if (char === '{') depth += 1;
    if (char === '}') depth -= 1;
    if (depth === 0) return source.slice(start, i);
  }
  return undefined;
}
