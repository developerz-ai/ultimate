// Single responsibility: an RFC 5322 address-list header (`From`, `To`, `Cc`, `Reply-To`) →
// `{ address, name }` entries. Commas inside quotes, angle brackets and comments do not split;
// a group (`team: a@x.test, b@x.test;`) yields its members. Lenient: nothing here refuses.

export interface InboundAddress {
  /** The addr-spec, as written — never lower-cased: a local part is case-sensitive. */
  readonly address: string;
  /** The display phrase, RFC 2047 decoded already, or `undefined`. */
  readonly name: string | undefined;
}

/** Top-level commas only; `;` closes a group and splits too. */
function entries(value: string): string[] {
  const out: string[] = [];
  let current = '';
  let quoted = false;
  let angle = 0;
  let comment = 0;
  for (let at = 0; at < value.length; at += 1) {
    const char = value.charAt(at);
    if (char === '\\') {
      current += char + value.charAt(at + 1);
      at += 1;
      continue;
    }
    if (char === '"' && comment === 0) quoted = !quoted;
    else if (!quoted && char === '(') comment += 1;
    else if (!quoted && char === ')' && comment > 0) comment -= 1;
    else if (!quoted && comment === 0 && char === '<') angle += 1;
    else if (!quoted && comment === 0 && char === '>' && angle > 0) angle -= 1;
    else if (!quoted && comment === 0 && angle === 0 && (char === ',' || char === ';')) {
      out.push(current);
      current = '';
      continue;
    }
    current += char;
  }
  out.push(current);
  return out;
}

const stripComments = (text: string): string => text.replace(/\((?:[^()\\]|\\.)*\)/g, ' ');
const unquote = (text: string): string =>
  text
    .replace(/^"(.*)"$/s, '$1')
    .replace(/\\(.)/g, '$1')
    .trim();

function one(entry: string): InboundAddress | undefined {
  let text = entry.trim();
  // A group's display name ends at the first unquoted colon before any `<` or `@`.
  const group = /^(?:"[^"]*"|[^"<@:])*:/.exec(text);
  if (group !== null) text = text.slice(group[0].length).trim();
  if (text === '') return undefined;
  const angle = /^(.*)<([^<>]*)>\s*(?:\(.*\))?$/s.exec(text);
  if (angle !== null) {
    const phrase = unquote(stripComments(angle[1] ?? '').trim());
    const address = (angle[2] ?? '').trim();
    return address === '' ? undefined : { address, name: phrase === '' ? undefined : phrase };
  }
  // A bare addr-spec, perhaps with a trailing comment as its name (`jane@x.test (Jane)`).
  const comment = /\(([^()]*)\)/.exec(text)?.[1]?.trim();
  const address = stripComments(text).trim();
  if (address === '') return undefined;
  return { address, name: comment === undefined || comment === '' ? undefined : comment };
}

export function parseAddressList(value: string | undefined): readonly InboundAddress[] {
  if (value === undefined) return [];
  return entries(value).flatMap((entry) => {
    const parsed = one(entry);
    return parsed === undefined ? [] : [parsed];
  });
}
